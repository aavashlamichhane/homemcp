import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

export interface AuditRecord {
  id: string;
  ts: string;
  subject: string;
  client_id: string;
  token_kind: string;
  token_id: string;
  tool: string;
  args_redacted: string;
  tier: string;
  plan_id?: string | null | undefined;
  confirmation_id?: string | null | undefined;
  status: string;
  error_code?: string | null | undefined;
  duration_ms: number;
  job_id?: string | null | undefined;
  resources?: string | null | undefined;
}

export class HomemcpDb {
  public readonly db: DatabaseSyncType;

  public constructor(dbPath: string, migrationsDir?: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new sqlite.DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const defaultDir = path.resolve(import.meta.dirname, 'migrations');
    const fallbackSrcDir = path.resolve(import.meta.dirname, '../../src/db/migrations');
    const resolvedDir = migrationsDir ?? (existsSync(defaultDir) ? defaultDir : fallbackSrcDir);
    this.runMigrations(resolvedDir);
  }

  private runMigrations(dir: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.db.prepare('SELECT name FROM schema_migrations').all() as Array<{
      name: string;
    }>;
    const applied = new Set(appliedRows.map((r) => r.name));

    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const insertStmt = this.db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    );

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      this.db.exec('BEGIN;');
      try {
        this.db.exec(sql);
        insertStmt.run(file, new Date().toISOString());
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }
  }

  public insertAudit(rec: AuditRecord): void {
    this.db
      .prepare(
        `INSERT INTO audit (
          id, ts, subject, client_id, token_kind, token_id, tool, args_redacted,
          tier, plan_id, confirmation_id, status, error_code, duration_ms, job_id, resources
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.ts,
        rec.subject,
        rec.client_id,
        rec.token_kind,
        rec.token_id,
        rec.tool,
        rec.args_redacted,
        rec.tier,
        rec.plan_id ?? null,
        rec.confirmation_id ?? null,
        rec.status,
        rec.error_code ?? null,
        rec.duration_ms,
        rec.job_id ?? null,
        rec.resources ?? null,
      );
  }

  public queryAudit(opts: {
    tool?: string | undefined;
    status?: string | undefined;
    since?: string | undefined;
    limit?: number | undefined;
  }): AuditRecord[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (opts.tool) {
      clauses.push('tool = ?');
      args.push(opts.tool);
    }
    if (opts.status) {
      clauses.push('status = ?');
      args.push(opts.status);
    }
    if (opts.since) {
      clauses.push('ts >= ?');
      args.push(opts.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    args.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM audit ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...args) as Array<Record<string, unknown>>;

    return rows.map((r) => ({ ...r }) as unknown as AuditRecord);
  }

  public insertMetricSnapshot(
    kind: string,
    payload: unknown,
    ts: string = new Date().toISOString(),
  ): void {
    this.db
      .prepare('INSERT INTO metric_snapshots (ts, kind, payload_json) VALUES (?, ?, ?)')
      .run(ts, kind, JSON.stringify(payload));
  }

  public getMetricSnapshots(kind: string, limit = 90): Array<{ ts: string; payload: unknown }> {
    const rows = this.db
      .prepare(
        'SELECT ts, payload_json FROM metric_snapshots WHERE kind = ? ORDER BY ts DESC LIMIT ?',
      )
      .all(kind, limit) as Array<{ ts: string; payload_json: string }>;
    return rows.map((r) => ({
      ts: r.ts,
      payload: JSON.parse(r.payload_json) as unknown,
    }));
  }

  public insertMusicJobItem(item: {
    jobId: string;
    playlistId?: string | undefined;
    playlistName: string;
    videoId: string;
    naviloadTrackId?: string | undefined;
    state: string;
    songId?: string | undefined;
  }): void {
    this.db
      .prepare(
        `INSERT INTO music_jobs (job_id, playlist_id, playlist_name, video_id, naviload_track_id, state, song_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.jobId,
        item.playlistId ?? null,
        item.playlistName,
        item.videoId,
        item.naviloadTrackId ?? null,
        item.state,
        item.songId ?? null,
        new Date().toISOString(),
      );
  }

  public listMusicJobItems(jobId: string): Array<{
    id: number;
    job_id: string;
    playlist_id: string | null;
    playlist_name: string;
    video_id: string;
    naviload_track_id: string | null;
    state: string;
    song_id: string | null;
    updated_at: string;
  }> {
    return this.db
      .prepare('SELECT * FROM music_jobs WHERE job_id = ? ORDER BY id ASC')
      .all(jobId) as Array<{
      id: number;
      job_id: string;
      playlist_id: string | null;
      playlist_name: string;
      video_id: string;
      naviload_track_id: string | null;
      state: string;
      song_id: string | null;
      updated_at: string;
    }>;
  }

  public updateMusicJobItem(
    id: number,
    patch: {
      playlistId?: string | undefined;
      naviloadTrackId?: string | undefined;
      state?: string | undefined;
      songId?: string | undefined;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE music_jobs
         SET playlist_id = COALESCE(?, playlist_id),
             naviload_track_id = COALESCE(?, naviload_track_id),
             state = COALESCE(?, state),
             song_id = COALESCE(?, song_id),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.playlistId ?? null,
        patch.naviloadTrackId ?? null,
        patch.state ?? null,
        patch.songId ?? null,
        new Date().toISOString(),
        id,
      );
  }

  public close(): void {
    this.db.close();
  }
}
