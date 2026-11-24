import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { HomemcpError, type Scope, type ToolsetName } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';
import { hashSecret, verifySecret } from './crypto.js';

export interface PatRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  toolsets: ToolsetName[] | null;
  cidrs: string[] | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function ipToBigInt(ip: string): { version: 4 | 6; value: bigint } | null {
  const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    const val =
      (BigInt(parts[0]!) << 24n) |
      (BigInt(parts[1]!) << 16n) |
      (BigInt(parts[2]!) << 8n) |
      BigInt(parts[3]!);
    return { version: 4, value: val };
  }
  if (net.isIPv6(clean)) {
    const [left, right] = clean.split('::');
    const lParts = left ? left.split(':').filter(Boolean) : [];
    const rParts = right ? right.split(':').filter(Boolean) : [];
    const missing = 8 - (lParts.length + rParts.length);
    if (missing < 0) return null;
    const full = [
      ...lParts,
      ...Array.from({ length: missing }, () => '0'),
      ...rParts,
    ];
    let val = 0n;
    for (const seg of full) {
      val = (val << 16n) | BigInt(parseInt(seg || '0', 16));
    }
    return { version: 6, value: val };
  }
  return null;
}

export function isIpAllowedByCidrs(ip: string, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return true;
  const parsedIp = ipToBigInt(ip);
  if (!parsedIp) return false;

  for (const cidr of cidrs) {
    const [baseRaw, maskRaw] = cidr.split('/');
    if (!baseRaw) continue;
    const parsedBase = ipToBigInt(baseRaw);
    if (!parsedBase || parsedBase.version !== parsedIp.version) continue;
    const maxBits = parsedBase.version === 4 ? 32 : 128;
    const prefixLen = maskRaw !== undefined ? Number(maskRaw) : maxBits;
    if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > maxBits) continue;
    if (prefixLen === 0) return true;
    const shift = BigInt(maxBits - prefixLen);
    if ((parsedIp.value >> shift) === (parsedBase.value >> shift)) {
      return true;
    }
  }
  return false;
}

export class PatManager {
  private readonly revealCache = new Map<string, { token: string; expiresAt: number }>();

  public constructor(private readonly db: HomemcpDb) {}

  public createPat(opts: {
    name: string;
    scopes: readonly Scope[];
    toolsets?: readonly ToolsetName[] | undefined;
    cidrs?: readonly string[] | undefined;
    ttlDays?: number | undefined;
  }): { record: PatRecord; token: string; revealId: string } {
    const ttlDays = Math.min(Math.max(opts.ttlDays ?? 30, 1), 90);
    const id = randomUUID();
    const prefix = `hmp_${randomBytes(4).toString('hex')}`;
    const secretPart = randomBytes(24).toString('base64url');
    const token = `${prefix}.${secretPart}`;
    const hash = hashSecret(token);

    const now = new Date();
    const expires = new Date(now.getTime() + ttlDays * 86_400_000);
    const record: PatRecord = {
      id,
      name: opts.name,
      prefix,
      scopes: [...opts.scopes],
      toolsets: opts.toolsets ? [...opts.toolsets] : null,
      cidrs: opts.cidrs ? [...opts.cidrs] : null,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      last_used_at: null,
      revoked_at: null,
    };

    this.db.db
      .prepare(
        `INSERT INTO pats (id, name, prefix, token_hash, scopes_json, toolsets_json, cidrs_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.prefix,
        hash,
        JSON.stringify(record.scopes),
        record.toolsets ? JSON.stringify(record.toolsets) : null,
        record.cidrs ? JSON.stringify(record.cidrs) : null,
        record.created_at,
        record.expires_at,
      );

    const revealId = randomUUID();
    this.revealCache.set(revealId, { token, expiresAt: Date.now() + 300_000 });
    return { record, token, revealId };
  }

  public consumeOneTimeReveal(revealId: string): string | undefined {
    const entry = this.revealCache.get(revealId);
    this.revealCache.delete(revealId);
    if (!entry || entry.expiresAt < Date.now()) return undefined;
    return entry.token;
  }

  public listPats(): PatRecord[] {
    const rows = this.db.db
      .prepare('SELECT * FROM pats ORDER BY created_at DESC')
      .all() as Array<{
      id: string;
      name: string;
      prefix: string;
      scopes_json: string;
      toolsets_json: string | null;
      cidrs_json: string | null;
      created_at: string;
      expires_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: JSON.parse(r.scopes_json) as Scope[],
      toolsets: r.toolsets_json ? (JSON.parse(r.toolsets_json) as ToolsetName[]) : null,
      cidrs: r.cidrs_json ? (JSON.parse(r.cidrs_json) as string[]) : null,
      created_at: r.created_at,
      expires_at: r.expires_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }));
  }

  public revokePat(id: string): boolean {
    const res = this.db.db
      .prepare('UPDATE pats SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), id);
    return Number(res.changes) > 0;
  }

  public verifyPat(token: string, clientIp?: string): PatRecord | null {
    const dot = token.indexOf('.');
    if (!token.startsWith('hmp_') || dot < 0) return null;
    const prefix = token.slice(0, dot);
    const rows = this.db.db
      .prepare('SELECT * FROM pats WHERE prefix = ?')
      .all(prefix) as Array<{
      id: string;
      name: string;
      prefix: string;
      token_hash: string;
      scopes_json: string;
      toolsets_json: string | null;
      cidrs_json: string | null;
      created_at: string;
      expires_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
    }>;

    const nowMs = Date.now();
    for (const r of rows) {
      if (r.revoked_at) continue;
      if (Date.parse(r.expires_at) <= nowMs) continue;
      if (!verifySecret(token, r.token_hash)) continue;

      const cidrs = r.cidrs_json ? (JSON.parse(r.cidrs_json) as string[]) : null;
      if (cidrs && cidrs.length > 0) {
        if (!clientIp || !isIpAllowedByCidrs(clientIp, cidrs)) {
          throw new HomemcpError('POLICY_DENIED', 'PAT source IP not in allowed CIDRs');
        }
      }

      this.db.db
        .prepare('UPDATE pats SET last_used_at = ? WHERE id = ?')
        .run(new Date(nowMs).toISOString(), r.id);

      return {
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: JSON.parse(r.scopes_json) as Scope[],
        toolsets: r.toolsets_json ? (JSON.parse(r.toolsets_json) as ToolsetName[]) : null,
        cidrs,
        created_at: r.created_at,
        expires_at: r.expires_at,
        last_used_at: new Date(nowMs).toISOString(),
        revoked_at: null,
      };
    }
    return null;
  }

  public issueBootstrapToken(): { id: string; rawToken: string; expiresAt: string } {
    const id = randomUUID();
    const rawToken = randomBytes(24).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + 15 * 60_000);
    this.db.db
      .prepare(
        'INSERT INTO auth_bootstrap_tokens (id, token_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .run(id, hashSecret(rawToken), now.toISOString(), expires.toISOString());
    return { id, rawToken, expiresAt: expires.toISOString() };
  }

  public consumeBootstrapToken(rawToken: string): boolean {
    const rows = this.db.db
      .prepare('SELECT id, token_hash, expires_at FROM auth_bootstrap_tokens WHERE used_at IS NULL')
      .all() as Array<{ id: string; token_hash: string; expires_at: string }>;
    const nowMs = Date.now();
    for (const r of rows) {
      if (Date.parse(r.expires_at) <= nowMs) continue;
      if (verifySecret(rawToken, r.token_hash)) {
        this.db.db
          .prepare('UPDATE auth_bootstrap_tokens SET used_at = ? WHERE id = ?')
          .run(new Date(nowMs).toISOString(), r.id);
        return true;
      }
    }
    return false;
  }
}
