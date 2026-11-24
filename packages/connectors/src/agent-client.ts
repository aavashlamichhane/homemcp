import http from 'node:http';
import { signAgentRequest } from '@homemcp/agent';
import { HomemcpError, type AgentRpcResponse } from '@homemcp/core';

export interface AgentExecutor {
  call<T = unknown>(verb: string, params?: Record<string, unknown>): Promise<T>;
  healthz(): Promise<{ ok: boolean; verbs: string[] }>;
}

export class HttpUnixAgentClient implements AgentExecutor {
  private readonly socketPath: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly hmacSecret: string;

  public constructor(opts: {
    socketPath?: string | undefined;
    url?: string | undefined;
    hmacSecret: string;
  }) {
    this.socketPath = opts.socketPath;
    this.baseUrl = opts.url;
    this.hmacSecret = opts.hmacSecret;
  }

  public async healthz(): Promise<{ ok: boolean; verbs: string[] }> {
    const res = await this.request('GET', '/healthz');
    return JSON.parse(res.body) as { ok: boolean; verbs: string[] };
  }

  public async call<T = unknown>(
    verb: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const payload = JSON.stringify({ verb, params });
    const headers = signAgentRequest(this.hmacSecret, 'POST', payload);
    const res = await this.request('POST', '/rpc', payload, {
      'content-type': 'application/json',
      ...headers,
    });
    const parsed = JSON.parse(res.body) as AgentRpcResponse<T>;
    if (!parsed.ok) {
      throw new HomemcpError(
        parsed.error?.code ?? 'INTERNAL_ERROR',
        parsed.error?.message ?? `Agent verb ${verb} failed`,
        { ...(parsed.error?.hint ? { hint: parsed.error.hint } : {}) },
      );
    }
    return parsed.result as T;
  }

  private async request(
    method: string,
    reqPath: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    if (this.baseUrl) {
      const target = new URL(reqPath, this.baseUrl).toString();
      const resp = await fetch(target, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(30_000),
      }).catch((err) => {
        throw new HomemcpError(
          'UPSTREAM_UNAVAILABLE',
          `homemcpd unreachable: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      });
      return { status: resp.status, body: await resp.text() };
    }

    const socketPath = this.socketPath ?? '/run/homemcpd/homemcpd.sock';
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: reqPath,
          method,
          headers: {
            ...headers,
            ...(body !== undefined
              ? { 'content-length': String(Buffer.byteLength(body, 'utf8')) }
              : {}),
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('timeout', () => {
        req.destroy(new HomemcpError('TIMEOUT', 'homemcpd unix socket request timed out'));
      });
      req.on('error', (err) => {
        if (err instanceof HomemcpError) {
          reject(err);
          return;
        }
        reject(
          new HomemcpError('UPSTREAM_UNAVAILABLE', `homemcpd socket error: ${err.message}`, {
            cause: err,
          }),
        );
      });
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}
