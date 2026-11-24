import { randomUUID } from 'node:crypto';
import { HomemcpError, type Redactor } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';

export type JobStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting_user';

export interface JobStep {
  ts: string;
  message: string;
}

export interface JobRecord {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  steps: JobStep[];
  created_by: string;
  created_at: string;
  started_at?: string | undefined;
  finished_at?: string | undefined;
  result_redacted?: unknown;
  error?: string | undefined;
  cancel_requested: boolean;
}

export interface JobContext {
  jobId: string;
  isCancelled: () => boolean;
  addStep: (message: string, progress?: number) => Promise<void>;
  setProgress: (progress: number, message?: string) => Promise<void>;
  markWaitingUser: (message: string, result?: unknown) => void;
}

export class JobRunner {
  private readonly activePromises = new Map<string, Promise<void>>();
  private readonly onProgress:
    ((jobId: string, progress: number, message?: string) => Promise<void>) | undefined;

  public constructor(
    private readonly db: HomemcpDb,
    private readonly redactor: Redactor,
    opts?: {
      onProgress?:
        ((jobId: string, progress: number, message?: string) => Promise<void>) | undefined;
    },
  ) {
    this.onProgress = opts?.onProgress;
  }

  private rowToJob(row: Record<string, unknown>): JobRecord {
    const stepsRaw = typeof row['steps_json'] === 'string' ? row['steps_json'] : '[]';
    const resultRaw =
      typeof row['result_redacted'] === 'string' ? row['result_redacted'] : undefined;
    return {
      id: String(row['id']),
      kind: String(row['kind']),
      status: String(row['status']) as JobStatus,
      progress: Number(row['progress'] ?? 0),
      steps: JSON.parse(stepsRaw) as JobStep[],
      created_by: String(row['created_by']),
      created_at: String(row['created_at']),
      started_at: typeof row['started_at'] === 'string' ? row['started_at'] : undefined,
      finished_at: typeof row['finished_at'] === 'string' ? row['finished_at'] : undefined,
      result_redacted: resultRaw ? (JSON.parse(resultRaw) as unknown) : undefined,
      error: typeof row['error'] === 'string' ? row['error'] : undefined,
      cancel_requested: Number(row['cancel_requested'] ?? 0) === 1,
    };
  }

  public getJob(jobId: string): JobRecord | undefined {
    const row = this.db.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
      Record<string, unknown> | undefined;
    return row ? this.rowToJob(row) : undefined;
  }

  public listJobs(opts?: {
    status?: JobStatus | undefined;
    kind?: string | undefined;
    limit?: number | undefined;
  }): JobRecord[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (opts?.status) {
      clauses.push('status = ?');
      args.push(opts.status);
    }
    if (opts?.kind) {
      clauses.push('kind = ?');
      args.push(opts.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    args.push(limit);
    const rows = this.db.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToJob(r));
  }

  public createJob(kind: string, createdBy: string, initialStep?: string): JobRecord {
    const id = `job_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const steps: JobStep[] = initialStep
      ? [{ ts: now, message: this.redactor.redactString(initialStep).text }]
      : [];
    this.db.db
      .prepare(
        `INSERT INTO jobs (id, kind, status, progress, steps_json, created_by, created_at, cancel_requested)
         VALUES (?, ?, 'queued', 0, ?, ?, ?, 0)`,
      )
      .run(id, kind, JSON.stringify(steps), createdBy, now);
    return this.getJob(id)!;
  }

  public updateJob(
    jobId: string,
    patch: {
      status?: JobStatus | undefined;
      progress?: number | undefined;
      appendStep?: string | undefined;
      startedAt?: string | undefined;
      finishedAt?: string | undefined;
      result?: unknown;
      error?: string | undefined;
    },
  ): JobRecord {
    const existing = this.getJob(jobId);
    if (!existing) {
      throw new HomemcpError('NOT_FOUND', `Job not found: ${jobId}`);
    }
    const steps = [...existing.steps];
    if (patch.appendStep !== undefined) {
      steps.push({
        ts: new Date().toISOString(),
        message: this.redactor.redactString(patch.appendStep).text,
      });
    }
    const nextProgress =
      patch.progress !== undefined
        ? Math.min(100, Math.max(0, Math.round(patch.progress)))
        : existing.progress;
    const redactedResult =
      patch.result !== undefined
        ? JSON.stringify(this.redactor.redactValue(patch.result).value)
        : existing.result_redacted !== undefined
          ? JSON.stringify(existing.result_redacted)
          : null;
    const redactedErr =
      patch.error !== undefined
        ? this.redactor.redactString(patch.error).text
        : (existing.error ?? null);

    this.db.db
      .prepare(
        `UPDATE jobs
         SET status = ?, progress = ?, steps_json = ?, started_at = ?, finished_at = ?, result_redacted = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        patch.status ?? existing.status,
        nextProgress,
        JSON.stringify(steps),
        patch.startedAt ?? existing.started_at ?? null,
        patch.finishedAt ?? existing.finished_at ?? null,
        redactedResult,
        redactedErr,
        jobId,
      );
    return this.getJob(jobId)!;
  }

  public requestCancel(jobId: string): JobRecord {
    const existing = this.getJob(jobId);
    if (!existing) {
      throw new HomemcpError('NOT_FOUND', `Job not found: ${jobId}`);
    }
    if (
      existing.status === 'succeeded' ||
      existing.status === 'failed' ||
      existing.status === 'cancelled'
    ) {
      return existing;
    }
    this.db.db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(jobId);
    if (existing.status === 'queued' || existing.status === 'waiting_user') {
      return this.updateJob(jobId, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
        appendStep: 'Cancelled by user',
      });
    }
    return this.updateJob(jobId, { appendStep: 'Cancellation requested' });
  }

  public isCancelled(jobId: string): boolean {
    const row = this.db.db
      .prepare('SELECT cancel_requested, status FROM jobs WHERE id = ?')
      .get(jobId) as { cancel_requested?: number; status?: string } | undefined;
    return Number(row?.cancel_requested ?? 0) === 1 || row?.status === 'cancelled';
  }

  public startBackground(
    kind: string,
    createdBy: string,
    fn: (ctx: JobContext) => Promise<unknown>,
  ): JobRecord {
    const job = this.createJob(kind, createdBy, `Started ${kind}`);
    const now = new Date().toISOString();
    this.updateJob(job.id, { status: 'running', startedAt: now });

    let waitingUser = false;
    const ctx: JobContext = {
      jobId: job.id,
      isCancelled: () => this.isCancelled(job.id),
      addStep: async (message: string, progress?: number) => {
        const updated = this.updateJob(job.id, {
          appendStep: message,
          ...(progress !== undefined ? { progress } : {}),
        });
        if (this.onProgress) {
          await this.onProgress(job.id, updated.progress, message);
        }
      },
      setProgress: async (progress: number, message?: string) => {
        const updated = this.updateJob(job.id, {
          progress,
          ...(message !== undefined ? { appendStep: message } : {}),
        });
        if (this.onProgress) {
          await this.onProgress(job.id, updated.progress, message);
        }
      },
      markWaitingUser: (message: string, result?: unknown) => {
        waitingUser = true;
        this.updateJob(job.id, {
          status: 'waiting_user',
          appendStep: message,
          ...(result !== undefined ? { result } : {}),
        });
      },
    };

    const p = (async () => {
      try {
        const result = await fn(ctx);
        if (this.isCancelled(job.id)) {
          this.updateJob(job.id, {
            status: 'cancelled',
            finishedAt: new Date().toISOString(),
            appendStep: 'Cancelled',
          });
          return;
        }
        if (waitingUser) {
          return;
        }
        this.updateJob(job.id, {
          status: 'succeeded',
          progress: 100,
          finishedAt: new Date().toISOString(),
          result,
          appendStep: 'Completed',
        });
        if (this.onProgress) {
          await this.onProgress(job.id, 100, 'Completed');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.updateJob(job.id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: msg,
          appendStep: `Failed: ${msg}`,
        });
      } finally {
        this.activePromises.delete(job.id);
      }
    })();

    this.activePromises.set(job.id, p);
    return this.getJob(job.id)!;
  }

  public async waitForJob(jobId: string): Promise<JobRecord | undefined> {
    const active = this.activePromises.get(jobId);
    if (active) {
      await active;
    }
    return this.getJob(jobId);
  }

  public reconcileOnBoot(): number {
    const rows = this.db.db.prepare("SELECT id FROM jobs WHERE status = 'running'").all() as Array<{
      id: string;
    }>;
    for (const r of rows) {
      this.updateJob(r.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: 'Gateway restarted while job was running',
        appendStep: 'Interrupted by gateway restart',
      });
    }
    return rows.length;
  }
}
