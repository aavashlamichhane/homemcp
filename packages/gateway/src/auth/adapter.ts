import type { Adapter, AdapterConstructor, AdapterPayload } from 'oidc-provider';
import type { HomemcpDb } from '../db/database.js';
import { fetchCimdMetadata, isCimdClientId } from './cimd.js';

export function createSqliteAdapterFactory(db: HomemcpDb): AdapterConstructor {
  return class SqliteOidcAdapter implements Adapter {
    private readonly model: string;

    public constructor(name: string) {
      this.model = name;
    }

    public upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
      const expiresAt = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;
      db.db
        .prepare(
          `INSERT INTO oauth_kv (model, id, payload_json, grant_id, user_code, uid, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(model, id) DO UPDATE SET
             payload_json = excluded.payload_json,
             grant_id = excluded.grant_id,
             user_code = excluded.user_code,
             uid = excluded.uid,
             expires_at = excluded.expires_at`,
        )
        .run(
          this.model,
          id,
          JSON.stringify(payload),
          payload.grantId ?? null,
          payload.userCode ?? null,
          payload.uid ?? null,
          expiresAt,
        );
      return Promise.resolve();
    }

    public async find(id: string): Promise<AdapterPayload | undefined> {
      const nowSec = Math.floor(Date.now() / 1000);
      const row = db.db
        .prepare(
          'SELECT payload_json, expires_at, consumed_at FROM oauth_kv WHERE model = ? AND id = ?',
        )
        .get(this.model, id) as
        { payload_json: string; expires_at: number | null; consumed_at: number | null } | undefined;

      if (!row) {
        // Dynamic CIMD client resolution per MCP 2026-07-28 spec
        if (this.model === 'Client' && isCimdClientId(id)) {
          try {
            const meta = await fetchCimdMetadata(id, db);
            return {
              client_id: meta.client_id,
              client_name: meta.client_name,
              redirect_uris: meta.redirect_uris,
              grant_types: meta.grant_types ?? ['authorization_code', 'refresh_token'],
              response_types: (meta.response_types ?? ['code']) as AdapterPayload['response_types'],
              token_endpoint_auth_method: (meta.token_endpoint_auth_method ??
                'none') as AdapterPayload['token_endpoint_auth_method'],
              ...(meta.scope ? { scope: meta.scope } : {}),
              ...(meta.logo_uri ? { logo_uri: meta.logo_uri } : {}),
              ...(meta.client_uri ? { client_uri: meta.client_uri } : {}),
            };
          } catch {
            return undefined;
          }
        }
        return undefined;
      }

      if (row.expires_at !== null && row.expires_at <= nowSec) {
        db.db.prepare('DELETE FROM oauth_kv WHERE model = ? AND id = ?').run(this.model, id);
        return undefined;
      }

      const payload = JSON.parse(row.payload_json) as AdapterPayload;
      if (row.consumed_at !== null) {
        payload.consumed = row.consumed_at;
      }
      return payload;
    }

    public findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
      const nowSec = Math.floor(Date.now() / 1000);
      const row = db.db
        .prepare(
          'SELECT payload_json, expires_at, consumed_at FROM oauth_kv WHERE model = ? AND user_code = ?',
        )
        .get(this.model, userCode) as
        { payload_json: string; expires_at: number | null; consumed_at: number | null } | undefined;
      if (!row || (row.expires_at !== null && row.expires_at <= nowSec)) {
        return Promise.resolve(undefined);
      }
      const payload = JSON.parse(row.payload_json) as AdapterPayload;
      if (row.consumed_at !== null) payload.consumed = row.consumed_at;
      return Promise.resolve(payload);
    }

    public findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const nowSec = Math.floor(Date.now() / 1000);
      const row = db.db
        .prepare(
          'SELECT payload_json, expires_at, consumed_at FROM oauth_kv WHERE model = ? AND uid = ?',
        )
        .get(this.model, uid) as
        { payload_json: string; expires_at: number | null; consumed_at: number | null } | undefined;
      if (!row || (row.expires_at !== null && row.expires_at <= nowSec)) {
        return Promise.resolve(undefined);
      }
      const payload = JSON.parse(row.payload_json) as AdapterPayload;
      if (row.consumed_at !== null) payload.consumed = row.consumed_at;
      return Promise.resolve(payload);
    }

    public consume(id: string): Promise<void> {
      const nowSec = Math.floor(Date.now() / 1000);
      db.db
        .prepare('UPDATE oauth_kv SET consumed_at = ? WHERE model = ? AND id = ?')
        .run(nowSec, this.model, id);
      return Promise.resolve();
    }

    public destroy(id: string): Promise<void> {
      db.db.prepare('DELETE FROM oauth_kv WHERE model = ? AND id = ?').run(this.model, id);
      return Promise.resolve();
    }

    public revokeByGrantId(grantId: string): Promise<void> {
      db.db.prepare('DELETE FROM oauth_kv WHERE grant_id = ?').run(grantId);
      return Promise.resolve();
    }
  };
}

export function listOAuthClients(db: HomemcpDb): Array<{
  client_id: string;
  client_name?: string | undefined;
  redirect_uris?: string[] | undefined;
  source: 'registered' | 'cimd';
}> {
  const rows = db.db
    .prepare('SELECT id, payload_json FROM oauth_kv WHERE model = ?')
    .all('Client') as Array<{ id: string; payload_json: string }>;
  const cimdRows = db.db
    .prepare('SELECT client_id_url, metadata_json FROM cimd_cache')
    .all() as Array<{ client_id_url: string; metadata_json: string }>;

  const out: Array<{
    client_id: string;
    client_name?: string | undefined;
    redirect_uris?: string[] | undefined;
    source: 'registered' | 'cimd';
  }> = [];

  for (const r of rows) {
    const p = JSON.parse(r.payload_json) as { client_name?: string; redirect_uris?: string[] };
    out.push({
      client_id: r.id,
      ...(p.client_name ? { client_name: p.client_name } : {}),
      ...(p.redirect_uris ? { redirect_uris: p.redirect_uris } : {}),
      source: 'registered',
    });
  }
  for (const c of cimdRows) {
    const p = JSON.parse(c.metadata_json) as { client_name?: string; redirect_uris?: string[] };
    out.push({
      client_id: c.client_id_url,
      ...(p.client_name ? { client_name: p.client_name } : {}),
      ...(p.redirect_uris ? { redirect_uris: p.redirect_uris } : {}),
      source: 'cimd',
    });
  }
  return out;
}

export function revokeOAuthClientAndGrants(db: HomemcpDb, clientId: string): number {
  const delClient = db.db
    .prepare('DELETE FROM oauth_kv WHERE model = ? AND id = ?')
    .run('Client', clientId);
  db.db.prepare('DELETE FROM cimd_cache WHERE client_id_url = ?').run(clientId);

  // Revoke all tokens/grants associated with this clientId
  const grantRows = db.db
    .prepare('SELECT id, grant_id, payload_json FROM oauth_kv')
    .all() as Array<{ id: string; grant_id: string | null; payload_json: string }>;
  let revoked = Number(delClient.changes);
  for (const r of grantRows) {
    try {
      const p = JSON.parse(r.payload_json) as { clientId?: string };
      if (p.clientId === clientId) {
        db.db.prepare('DELETE FROM oauth_kv WHERE id = ?').run(r.id);
        revoked++;
      }
    } catch {
      // ignore
    }
  }
  return revoked;
}

export function isGrantActive(db: HomemcpDb, grantId: string): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  const row = db.db
    .prepare('SELECT expires_at FROM oauth_kv WHERE model = ? AND id = ?')
    .get('Grant', grantId) as { expires_at: number | null } | undefined;
  if (!row) return false;
  if (row.expires_at !== null && row.expires_at <= nowSec) return false;
  return true;
}
