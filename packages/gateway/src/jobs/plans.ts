import { createHash, randomUUID } from 'node:crypto';
import { HomemcpError, type Tier } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';

export type PlanStatus = 'draft' | 'confirmed' | 'applied' | 'expired' | 'rejected';

export interface PlanRecord {
  id: string;
  tool: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  summary: string;
  diff: string;
  side_effects: string[];
  rollback: string[];
  tier: Tier;
  created_by: string;
  created_at: string;
  expires_at: string;
  status: PlanStatus;
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
}

export function hashPlanPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

export class PlanManager {
  public constructor(private readonly db: HomemcpDb) {}

  private rowToPlan(row: Record<string, unknown>): PlanRecord {
    const id = String(row['id']);
    let status = String(row['status']) as PlanStatus;
    const expiresAt = String(row['expires_at']);
    if ((status === 'draft' || status === 'confirmed') && Date.parse(expiresAt) < Date.now()) {
      this.db.db.prepare("UPDATE plans SET status = 'expired' WHERE id = ?").run(id);
      status = 'expired';
    }
    return {
      id,
      tool: String(row['tool']),
      payload: JSON.parse(String(row['payload_json'])) as Record<string, unknown>,
      payload_hash: String(row['payload_hash']),
      summary: String(row['summary']),
      diff: String(row['diff']),
      side_effects: JSON.parse(String(row['side_effects_json'])) as string[],
      rollback: JSON.parse(String(row['rollback_json'])) as string[],
      tier: String(row['tier']) as Tier,
      created_by: String(row['created_by']),
      created_at: String(row['created_at']),
      expires_at: expiresAt,
      status,
    };
  }

  public createPlan(opts: {
    tool: string;
    tier: Tier;
    payload: Record<string, unknown>;
    summary: string;
    diff: string;
    sideEffects: readonly string[];
    rollback: readonly string[];
    createdBy: string;
    ttlMs?: number | undefined;
  }): PlanRecord {
    const id = `plan_${randomUUID().slice(0, 12)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? 600_000)).toISOString();
    const payloadJson = canonicalStringify(opts.payload);
    const payloadHash = hashPlanPayload(opts.payload);

    this.db.db
      .prepare(
        `INSERT INTO plans (id, tool, payload_json, payload_hash, summary, diff, side_effects_json, rollback_json, tier, created_by, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      )
      .run(
        id,
        opts.tool,
        payloadJson,
        payloadHash,
        opts.summary,
        opts.diff,
        JSON.stringify(opts.sideEffects),
        JSON.stringify(opts.rollback),
        opts.tier,
        opts.createdBy,
        now.toISOString(),
        expiresAt,
      );

    return this.getPlan(id)!;
  }

  public getPlan(planId: string): PlanRecord | undefined {
    const row = this.db.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToPlan(row) : undefined;
  }

  public assertPlanReady(planId: string, expectedTool?: string): PlanRecord {
    const plan = this.getPlan(planId);
    if (!plan) {
      throw new HomemcpError('NOT_FOUND', `Plan not found: ${planId}`);
    }
    if (expectedTool && plan.tool !== expectedTool) {
      throw new HomemcpError(
        'INVALID_ARGUMENT',
        `Plan ${planId} is for tool "${plan.tool}", not "${expectedTool}"`,
      );
    }
    if (plan.status === 'expired') {
      throw new HomemcpError('CONFLICT', `Plan ${planId} has expired; generate a fresh plan`);
    }
    if (plan.status === 'applied') {
      throw new HomemcpError('CONFLICT', `Plan ${planId} was already applied`);
    }
    if (plan.status === 'rejected') {
      throw new HomemcpError('POLICY_DENIED', `Plan ${planId} was rejected by the user`);
    }
    const recomputed = hashPlanPayload(plan.payload);
    if (recomputed !== plan.payload_hash) {
      throw new HomemcpError('POLICY_DENIED', `Plan ${planId} integrity hash mismatch`);
    }
    return plan;
  }

  public markConfirmed(planId: string): PlanRecord {
    this.assertPlanReady(planId);
    this.db.db.prepare("UPDATE plans SET status = 'confirmed' WHERE id = ?").run(planId);
    return this.getPlan(planId)!;
  }

  public markApplied(planId: string): PlanRecord {
    const plan = this.assertPlanReady(planId);
    this.db.db.prepare("UPDATE plans SET status = 'applied' WHERE id = ?").run(plan.id);
    return this.getPlan(planId)!;
  }

  public markRejected(planId: string): PlanRecord {
    const plan = this.getPlan(planId);
    if (!plan) {
      throw new HomemcpError('NOT_FOUND', `Plan not found: ${planId}`);
    }
    this.db.db.prepare("UPDATE plans SET status = 'rejected' WHERE id = ?").run(planId);
    return this.getPlan(planId)!;
  }
}
