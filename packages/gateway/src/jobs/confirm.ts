import { randomUUID } from 'node:crypto';
import type { ServerContext } from '@modelcontextprotocol/server';
import { HomemcpError, parseDurationMs, type AuthContext, type Tier } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';
import type { PlanManager, PlanRecord } from './plans.js';

export type ConfirmationMethod = 'elicit_form' | 'elicit_url' | 'url';
export type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ConfirmationRecord {
  id: string;
  plan_id: string;
  method: ConfirmationMethod;
  approved_by?: string | undefined;
  approved_at?: string | undefined;
  auth_time?: number | undefined;
  status: ConfirmationStatus;
  expires_at: string;
}

export class ConfirmationGate {
  private readonly stepUpMaxAgeSec: number;

  public constructor(
    private readonly db: HomemcpDb,
    private readonly plans: PlanManager,
    opts?: { stepUpMaxAge?: string | undefined },
  ) {
    this.stepUpMaxAgeSec = Math.max(
      60,
      Math.floor(parseDurationMs(opts?.stepUpMaxAge ?? '5m') / 1000),
    );
  }

  private rowToRecord(row: Record<string, unknown>): ConfirmationRecord {
    let status = String(row['status']) as ConfirmationStatus;
    const expiresAt = String(row['expires_at']);
    if (status === 'pending' && Date.parse(expiresAt) < Date.now()) {
      status = 'expired';
      this.db.db
        .prepare("UPDATE confirmations SET status = 'expired' WHERE id = ?")
        .run(String(row['id']));
    }
    return {
      id: String(row['id']),
      plan_id: String(row['plan_id']),
      method: String(row['method']) as ConfirmationMethod,
      approved_by: typeof row['approved_by'] === 'string' ? row['approved_by'] : undefined,
      approved_at: typeof row['approved_at'] === 'string' ? row['approved_at'] : undefined,
      auth_time: typeof row['auth_time'] === 'number' ? row['auth_time'] : undefined,
      status,
      expires_at: expiresAt,
    };
  }

  public getConfirmation(id: string): ConfirmationRecord | undefined {
    const row = this.db.db.prepare('SELECT * FROM confirmations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  public createChallenge(
    planId: string,
    method: ConfirmationMethod,
    ttlMs = 600_000,
  ): ConfirmationRecord {
    this.plans.assertPlanReady(planId);
    const id = `conf_${randomUUID().slice(0, 12)}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.db
      .prepare(
        `INSERT INTO confirmations (id, plan_id, method, status, expires_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(id, planId, method, expiresAt);
    return this.getConfirmation(id)!;
  }

  public approveConfirmation(
    confirmationId: string,
    opts: {
      approvedBy: string;
      method?: ConfirmationMethod | undefined;
      authTime?: number | undefined;
      nowEpochSec?: number | undefined;
    },
  ): ConfirmationRecord {
    const rec = this.getConfirmation(confirmationId);
    if (!rec) {
      throw new HomemcpError('NOT_FOUND', `Confirmation not found: ${confirmationId}`);
    }
    if (rec.status !== 'pending') {
      throw new HomemcpError('CONFLICT', `Confirmation ${confirmationId} is ${rec.status}`);
    }
    const plan = this.plans.assertPlanReady(rec.plan_id);
    const nowSec = opts.nowEpochSec ?? Math.floor(Date.now() / 1000);

    if (plan.tier === 'T3') {
      if (opts.authTime === undefined || nowSec - opts.authTime > this.stepUpMaxAgeSec) {
        throw new HomemcpError(
          'CONFIRMATION_REQUIRED',
          `Fresh passkey authentication (auth_time <= ${this.stepUpMaxAgeSec}s) required to approve T3 plan ${plan.id}`,
        );
      }
    }

    const nowIso = new Date(nowSec * 1000).toISOString();
    this.db.db
      .prepare(
        `UPDATE confirmations
         SET status = 'approved',
             approved_by = ?,
             approved_at = ?,
             auth_time = ?,
             method = COALESCE(?, method)
         WHERE id = ?`,
      )
      .run(opts.approvedBy, nowIso, opts.authTime ?? null, opts.method ?? null, confirmationId);

    this.plans.markConfirmed(plan.id);
    return this.getConfirmation(confirmationId)!;
  }

  public rejectConfirmation(confirmationId: string): ConfirmationRecord {
    const rec = this.getConfirmation(confirmationId);
    if (!rec) {
      throw new HomemcpError('NOT_FOUND', `Confirmation not found: ${confirmationId}`);
    }
    this.db.db
      .prepare("UPDATE confirmations SET status = 'rejected' WHERE id = ?")
      .run(confirmationId);
    this.plans.markRejected(rec.plan_id);
    return this.getConfirmation(confirmationId)!;
  }

  public findValidApproval(
    planId: string,
    requireFreshPasskey: boolean,
    nowEpochSec = Math.floor(Date.now() / 1000),
  ): ConfirmationRecord | undefined {
    const rows = this.db.db
      .prepare("SELECT * FROM confirmations WHERE plan_id = ? AND status = 'approved' ORDER BY approved_at DESC")
      .all(planId) as Array<Record<string, unknown>>;

    for (const r of rows) {
      const rec = this.rowToRecord(r);
      if (!requireFreshPasskey) return rec;
      if (rec.auth_time !== undefined && nowEpochSec - rec.auth_time <= this.stepUpMaxAgeSec) {
        return rec;
      }
    }
    return undefined;
  }

  public async requireApprovalOrChallenge(opts: {
    planId: string;
    expectedTool: string;
    tier: Tier;
    auth: AuthContext;
    mcpCtx?: ServerContext | undefined;
    publicUrl: string;
  }): Promise<
    | { approved: true; plan: PlanRecord; confirmationId: string }
    | { approved: false; plan: PlanRecord; confirmationId: string; confirmUrl: string; expiresAt: string }
  > {
    const plan = this.plans.assertPlanReady(opts.planId, opts.expectedTool);
    const requirePasskey = opts.tier === 'T3';

    const existing = this.findValidApproval(plan.id, requirePasskey);
    if (existing) {
      return { approved: true, plan, confirmationId: existing.id };
    }

    // For T2: attempt MCP client interactive form elicitation if available
    if (opts.tier === 'T2' && opts.mcpCtx) {
      try {
        const maybeElicit = (
          opts.mcpCtx.mcpReq as unknown as {
            elicitInput?: (p: unknown) => Promise<{ action: string; content?: Record<string, unknown> }>;
          }
        ).elicitInput;
        if (typeof maybeElicit === 'function') {
          const elicitRes = await maybeElicit({
            mode: 'form',
            message: `${plan.summary}\nSide effects:\n- ${plan.side_effects.join('\n- ')}`,
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: { type: 'boolean', title: 'Approve execution of this plan' },
              },
              required: ['confirm'],
            },
          });
          if (elicitRes.action === 'accept' && elicitRes.content?.['confirm'] === true) {
            const chal = this.createChallenge(plan.id, 'elicit_form');
            const approved = this.approveConfirmation(chal.id, {
              approvedBy: opts.auth.subject,
              method: 'elicit_form',
              authTime: opts.auth.authTime,
            });
            return { approved: true, plan, confirmationId: approved.id };
          }
          if (elicitRes.action === 'decline' || elicitRes.action === 'cancel') {
            this.plans.markRejected(plan.id);
            throw new HomemcpError('POLICY_DENIED', `User declined plan ${plan.id}`);
          }
        }
      } catch (err) {
        if (err instanceof HomemcpError) throw err;
        // Client does not support push elicitation; fall through to /confirm/:id challenge
      }
    }

    // Check if an existing pending challenge already exists for this plan
    const pendingRow = this.db.db
      .prepare("SELECT * FROM confirmations WHERE plan_id = ? AND status = 'pending' ORDER BY expires_at DESC LIMIT 1")
      .get(plan.id) as Record<string, unknown> | undefined;

    const challenge = pendingRow
      ? this.rowToRecord(pendingRow)
      : this.createChallenge(plan.id, 'url');

    if (challenge.status === 'pending') {
      const cleanBase = opts.publicUrl.replace(/\/+$/, '');
      return {
        approved: false,
        plan,
        confirmationId: challenge.id,
        confirmUrl: `${cleanBase}/confirm/${challenge.id}`,
        expiresAt: challenge.expires_at,
      };
    }

    const freshChallenge = this.createChallenge(plan.id, 'url');
    const cleanBase = opts.publicUrl.replace(/\/+$/, '');
    return {
      approved: false,
      plan,
      confirmationId: freshChallenge.id,
      confirmUrl: `${cleanBase}/confirm/${freshChallenge.id}`,
      expiresAt: freshChallenge.expires_at,
    };
  }
}
