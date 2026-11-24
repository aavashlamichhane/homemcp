import tls from 'node:tls';

export interface HttpProbeResult {
  url: string;
  ok: boolean;
  status_code?: number | undefined;
  latency_ms: number;
  redirect_chain: string[];
  final_url: string;
  tls_valid_to?: string | undefined;
  tls_days_remaining?: number | undefined;
  error?: string | undefined;
}

export interface HttpProbeConnector {
  probe(
    url: string,
    opts?: { timeoutMs?: number | undefined; followRedirects?: boolean | undefined },
  ): Promise<HttpProbeResult>;
}

async function inspectTlsCert(hostname: string, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 4000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(cert?.valid_to);
      },
    );
    socket.on('error', () => resolve(undefined));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

export class NodeHttpProbeConnector implements HttpProbeConnector {
  public async probe(
    targetUrl: string,
    opts?: { timeoutMs?: number | undefined; followRedirects?: boolean | undefined },
  ): Promise<HttpProbeResult> {
    const start = Date.now();
    const timeoutMs = opts?.timeoutMs ?? 8_000;
    const follow = opts?.followRedirects ?? true;
    const redirectChain: string[] = [];
    let currentUrl = targetUrl;
    let statusCode: number | undefined;

    try {
      for (let hop = 0; hop < 8; hop++) {
        const resp = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        statusCode = resp.status;
        if (follow && resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location');
          if (!loc) break;
          const next = new URL(loc, currentUrl).toString();
          redirectChain.push(next);
          currentUrl = next;
          continue;
        }
        break;
      }

      let tlsValidTo: string | undefined;
      let tlsDaysRemaining: number | undefined;
      const parsed = new URL(currentUrl);
      if (parsed.protocol === 'https:') {
        const rawValidTo = await inspectTlsCert(
          parsed.hostname,
          parsed.port ? Number(parsed.port) : 443,
        );
        if (rawValidTo) {
          const expMs = Date.parse(rawValidTo);
          if (Number.isFinite(expMs)) {
            tlsValidTo = new Date(expMs).toISOString();
            tlsDaysRemaining = Math.floor((expMs - Date.now()) / 86_400_000);
          }
        }
      }

      const latencyMs = Date.now() - start;
      const ok = statusCode !== undefined && statusCode >= 200 && statusCode < 400;
      return {
        url: targetUrl,
        ok,
        ...(statusCode !== undefined ? { status_code: statusCode } : {}),
        latency_ms: latencyMs,
        redirect_chain: redirectChain,
        final_url: currentUrl,
        ...(tlsValidTo ? { tls_valid_to: tlsValidTo } : {}),
        ...(tlsDaysRemaining !== undefined ? { tls_days_remaining: tlsDaysRemaining } : {}),
      };
    } catch (err) {
      return {
        url: targetUrl,
        ok: false,
        latency_ms: Date.now() - start,
        redirect_chain: redirectChain,
        final_url: currentUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
