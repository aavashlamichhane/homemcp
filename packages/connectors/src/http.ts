import { HomemcpError } from '@homemcp/core';

export interface HttpJsonOptions {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  timeoutMs?: number | undefined;
  serviceName: string;
}

export async function fetchWithTimeout(url: string, opts: HttpJsonOptions): Promise<Response> {
  const controller = new AbortController();
  const timeout = opts.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: opts.method ?? 'GET',
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      signal: controller.signal,
    });
    return resp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HomemcpError('TIMEOUT', `${opts.serviceName} timed out after ${timeout}ms`);
    }
    throw new HomemcpError(
      'UPSTREAM_UNAVAILABLE',
      `${opts.serviceName} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, opts: HttpJsonOptions): Promise<T> {
  const resp = await fetchWithTimeout(url, opts);
  if (resp.status === 401 || resp.status === 403) {
    throw new HomemcpError(
      'UPSTREAM_AUTH',
      `${opts.serviceName} rejected credentials (${resp.status})`,
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new HomemcpError(
      'UPSTREAM_UNAVAILABLE',
      `${opts.serviceName} returned HTTP ${resp.status}: ${text.slice(0, 200)}`,
    );
  }
  return (await resp.json()) as T;
}
