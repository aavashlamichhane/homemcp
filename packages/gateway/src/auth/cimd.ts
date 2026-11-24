import { lookup } from 'node:dns/promises';
import net from 'node:net';
import * as z from 'zod/v4';
import { HomemcpError } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';

export const CimdMetadataSchema = z.object({
  client_id: z.string().url(),
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string().url()).min(1).max(20),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
  logo_uri: z.string().url().optional(),
  client_uri: z.string().url().optional(),
});

export type CimdMetadata = z.infer<typeof CimdMetadataSchema>;

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.includes('%') ? rawIp.slice(0, rawIp.indexOf('%')) : rawIp;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 192 && b === 168) return true; // RFC 1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::' || norm === '::1') return true;
    if (norm.startsWith('::ffff:')) {
      return isPrivateOrReservedIp(norm.slice('::ffff:'.length));
    }
    if (norm.startsWith('fe80:') || norm.startsWith('fc') || norm.startsWith('fd')) {
      return true;
    }
    return false;
  }
  return true;
}

export function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === 'https:' && u.pathname.length > 1;
  } catch {
    return false;
  }
}

export async function fetchCimdMetadata(
  clientIdUrl: string,
  db: HomemcpDb,
  opts?: {
    lookupFn?: typeof lookup | undefined;
    fetchFn?: typeof fetch | undefined;
    allowPrivateIpForTest?: boolean | undefined;
  },
): Promise<CimdMetadata> {
  if (!isCimdClientId(clientIdUrl)) {
    throw new HomemcpError(
      'INVALID_ARGUMENT',
      'CIMD client_id must be an https:// URL with a non-empty path',
    );
  }

  const now = Date.now();
  const cached = db.db
    .prepare('SELECT metadata_json, expires_at FROM cimd_cache WHERE client_id_url = ?')
    .get(clientIdUrl) as { metadata_json: string; expires_at: number } | undefined;

  if (cached && cached.expires_at > now) {
    return JSON.parse(cached.metadata_json) as CimdMetadata;
  }

  const parsedUrl = new URL(clientIdUrl);
  if (!opts?.allowPrivateIpForTest) {
    if (net.isIP(parsedUrl.hostname) && isPrivateOrReservedIp(parsedUrl.hostname)) {
      throw new HomemcpError('POLICY_DENIED', 'CIMD URL resolves to a private/reserved IP');
    }
    const resolveFn = opts?.lookupFn ?? lookup;
    const records = await resolveFn(parsedUrl.hostname, { all: true }).catch(() => []);
    if (records.length === 0) {
      throw new HomemcpError(
        'UPSTREAM_UNAVAILABLE',
        `Failed to resolve CIMD host: ${parsedUrl.hostname}`,
      );
    }
    for (const r of records) {
      if (isPrivateOrReservedIp(r.address)) {
        throw new HomemcpError('POLICY_DENIED', 'CIMD host resolves to a private/reserved IP');
      }
    }
  }

  const doFetch = opts?.fetchFn ?? fetch;
  const resp = await doFetch(clientIdUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) {
    throw new HomemcpError('UPSTREAM_UNAVAILABLE', `CIMD fetch failed (${resp.status})`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > 65_536) {
    throw new HomemcpError('POLICY_DENIED', 'CIMD metadata document exceeds 64 KB limit');
  }

  let json: unknown;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HomemcpError('INVALID_ARGUMENT', 'CIMD document is not valid JSON');
  }

  const parsed = CimdMetadataSchema.safeParse(json);
  if (!parsed.success) {
    throw new HomemcpError('INVALID_ARGUMENT', 'CIMD document failed schema validation');
  }
  if (parsed.data.client_id !== clientIdUrl) {
    throw new HomemcpError('POLICY_DENIED', 'CIMD client_id does not match document URL');
  }

  // Respect Cache-Control max-age clamped to [5m, 24h]
  const cc = resp.headers.get('cache-control') ?? '';
  const maxAgeMatch = /max-age=(\d+)/i.exec(cc);
  const rawTtlMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3_600_000;
  const ttlMs = Math.min(Math.max(rawTtlMs, 300_000), 86_400_000);

  db.db
    .prepare(
      `INSERT INTO cimd_cache (client_id_url, metadata_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id_url) DO UPDATE SET
         metadata_json = excluded.metadata_json,
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`,
    )
    .run(clientIdUrl, JSON.stringify(parsed.data), now, now + ttlMs);

  return parsed.data;
}
