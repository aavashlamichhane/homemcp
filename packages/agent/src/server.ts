import { chmod, mkdir, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { HomemcpError, Redactor } from '@homemcp/core';
import { NonceReplayCache, verifyAgentRequest } from './auth.js';
import type { VerbRegistry } from './registry.js';

export interface AgentServerOptions {
  socketPath?: string | undefined;
  tcpPort?: number | undefined;
  tcpHost?: string | undefined;
  hmacSecret: string;
  registry: VerbRegistry;
  redactor?: Redactor | undefined;
}

export interface AgentServerHandle {
  address: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_048_576;

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new HomemcpError('INVALID_ARGUMENT', 'Request body exceeds 1MB limit');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startAgentServer(opts: AgentServerOptions): Promise<AgentServerHandle> {
  const replayCache = new NonceReplayCache();
  const redactor = opts.redactor ?? new Redactor();
  redactor.registerSecret(opts.hmacSecret);

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/healthz') {
        const body = JSON.stringify({ ok: true, verbs: opts.registry.listVerbs() });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }

      if (req.method !== 'POST' || url !== '/rpc') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }));
        return;
      }

      try {
        const rawBody = await readRequestBody(req);
        verifyAgentRequest(
          {
            secret: opts.hmacSecret,
            method: req.method,
            rawBody,
            tsHeader: req.headers['x-homemcp-ts'] as string | undefined,
            nonceHeader: req.headers['x-homemcp-nonce'] as string | undefined,
            sigHeader: req.headers['x-homemcp-sig'] as string | undefined,
          },
          replayCache,
        );

        const parsed = JSON.parse(rawBody) as { verb?: unknown; params?: unknown };
        if (typeof parsed.verb !== 'string' || !parsed.verb) {
          throw new HomemcpError('INVALID_ARGUMENT', 'Missing verb');
        }
        const rawResult = await opts.registry.dispatch(parsed.verb, parsed.params ?? {});
        const redacted = redactor.redactValue(rawResult);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: redacted.value }));
      } catch (err) {
        const hErr =
          err instanceof HomemcpError
            ? err
            : err instanceof SyntaxError
              ? new HomemcpError('INVALID_ARGUMENT', 'Invalid JSON body')
              : new HomemcpError(
                  'INTERNAL_ERROR',
                  err instanceof Error ? err.message : 'Internal agent error',
                );
        const status =
          hErr.code === 'UPSTREAM_AUTH'
            ? 401
            : hErr.code === 'POLICY_DENIED'
              ? 403
              : hErr.code === 'NOT_FOUND'
                ? 404
                : hErr.code === 'INVALID_ARGUMENT'
                  ? 400
                  : 500;
        const redactedErr = redactor.redactValue({
          ok: false,
          error: {
            code: hErr.code,
            message: hErr.message,
            ...(hErr.hint ? { hint: hErr.hint } : {}),
          },
        });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedErr.value));
      }
    })();
  });

  if (opts.tcpPort !== undefined) {
    const host = opts.tcpHost ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.tcpPort, host, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : opts.tcpPort;
    return {
      address: `http://${host}:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    };
  }

  const sockPath = opts.socketPath ?? '/run/homemcpd/homemcpd.sock';
  await mkdir(path.dirname(sockPath), { recursive: true });
  try {
    await unlink(sockPath);
  } catch {
    // ignore if absent
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve());
  });
  await chmod(sockPath, 0o660);

  return {
    address: sockPath,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      try {
        await unlink(sockPath);
      } catch {
        // ignore
      }
    },
  };
}
