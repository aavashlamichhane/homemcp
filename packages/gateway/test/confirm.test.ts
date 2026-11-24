import { afterEach, describe, expect, it } from 'vitest';
import { HomemcpDb } from '../src/db/database.js';
import { ConfirmationGate } from '../src/jobs/confirm.js';
import { PlanManager } from '../src/jobs/plans.js';
import { SagaRunner } from '../src/jobs/saga.js';

describe('Phase 5 PlanManager, ConfirmationGate, and SagaRunner', () => {
  const openDbs: HomemcpDb[] = [];

  afterEach(() => {
    for (const d of openDbs.splice(0)) {
      d.close();
    }
  });

  function setup(stepUpMaxAge = '5m') {
    const db = new HomemcpDb(':memory:');
    openDbs.push(db);
    const plans = new PlanManager(db);
    const confirmations = new ConfirmationGate(db, plans, { stepUpMaxAge });
    return { db, plans, confirmations };
  }

  it('rejects expired, tampered, wrong-tool, and already-applied plans', () => {
    const { db, plans } = setup();

    const expired = plans.createPlan({
      tool: 'docker_update_service',
      tier: 'T2',
      payload: { service: 'wordchain' },
      summary: 'Update wordchain',
      diff: '-old\n+new',
      sideEffects: ['Recreates container'],
      rollback: ['Restore prior digest'],
      createdBy: 'owner',
      ttlMs: -1000,
    });
    expect(() => plans.assertPlanReady(expired.id, 'docker_update_service')).toThrow(/expired/i);

    const p2 = plans.createPlan({
      tool: 'docker_update_service',
      tier: 'T2',
      payload: { service: 'wordchain' },
      summary: 'Update wordchain',
      diff: '-old\n+new',
      sideEffects: ['Recreates container'],
      rollback: ['Restore prior digest'],
      createdBy: 'owner',
    });

    // Wrong tool check
    expect(() => plans.assertPlanReady(p2.id, 'expose_apply')).toThrow(/not "expose_apply"/i);

    // Payload tampering in DB must trigger hash mismatch
    db.db
      .prepare('UPDATE plans SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify({ service: 'vaultwarden' }), p2.id);
    expect(() => plans.assertPlanReady(p2.id, 'docker_update_service')).toThrow(/hash mismatch/i);

    // Normal apply locks out re-apply
    const p3 = plans.createPlan({
      tool: 'docker_update_service',
      tier: 'T2',
      payload: { service: 'wordchain' },
      summary: 'Update wordchain',
      diff: '-old\n+new',
      sideEffects: [],
      rollback: [],
      createdBy: 'owner',
    });
    plans.markApplied(p3.id);
    expect(() => plans.assertPlanReady(p3.id)).toThrow(/already applied/i);
  });

  it('enforces out-of-band confirmation for T2 and fresh passkey auth_time for T3 (LLM cannot auto-approve)', async () => {
    const { plans, confirmations } = setup('5m');

    const t3Plan = plans.createPlan({
      tool: 'expose_apply',
      tier: 'T3',
      payload: { hostname: 'test.example.com' },
      summary: 'Expose test.example.com',
      diff: '+ test.example.com',
      sideEffects: ['Public DNS + tunnel route'],
      rollback: ['Delete DNS + tunnel route + NPM host'],
      createdBy: 'llm-caller',
    });

    // Calling requireApprovalOrChallenge with no confirmation returns challenge URL (never auto-approves)
    const ch1 = await confirmations.requireApprovalOrChallenge({
      planId: t3Plan.id,
      expectedTool: 'expose_apply',
      tier: 'T3',
      auth: {
        subject: 'owner',
        clientId: 'c1',
        tokenKind: 'oauth',
        tokenId: 't1',
        scopes: ['homemcp:admin'],
        authTime: Math.floor(Date.now() / 1000), // even with recent OAuth authTime, T3 still requires explicit /confirm approval!
      },
      publicUrl: 'https://homemcp.example.com',
    });
    expect(ch1.approved).toBe(false);
    expect(ch1.approved ? '' : ch1.confirmUrl).toContain(`/confirm/${ch1.confirmationId}`);

    // Stale passkey auth_time (> 5 min ago) MUST be rejected for T3
    const staleEpoch = Math.floor(Date.now() / 1000) - 600;
    expect(() =>
      confirmations.approveConfirmation(ch1.confirmationId, {
        approvedBy: 'owner',
        authTime: staleEpoch,
      }),
    ).toThrow(/Fresh passkey authentication/i);

    // Fresh passkey assertion unlocks apply
    confirmations.approveConfirmation(ch1.confirmationId, {
      approvedBy: 'owner',
      authTime: Math.floor(Date.now() / 1000),
    });

    const ch2 = await confirmations.requireApprovalOrChallenge({
      planId: t3Plan.id,
      expectedTool: 'expose_apply',
      tier: 'T3',
      auth: {
        subject: 'owner',
        clientId: 'c1',
        tokenKind: 'oauth',
        tokenId: 't1',
        scopes: ['homemcp:admin'],
      },
      publicUrl: 'https://homemcp.example.com',
    });
    expect(ch2.approved).toBe(true);
  });

  it('SagaRunner executes completed undo callbacks in reverse order upon failure', async () => {
    const saga = new SagaRunner();
    const trace: string[] = [];

    const res = await saga.run([
      {
        name: 'npm_create',
        run: () => {
          trace.push('run:npm');
          return Promise.resolve({ hostId: 1 });
        },
        undo: () => {
          trace.push('undo:npm');
          return Promise.resolve();
        },
      },
      {
        name: 'cf_tunnel',
        run: () => {
          trace.push('run:tunnel');
          return Promise.resolve({ version: 52 });
        },
        undo: () => {
          trace.push('undo:tunnel');
          return Promise.resolve();
        },
      },
      {
        name: 'cf_dns',
        run: () => {
          trace.push('run:dns');
          return Promise.reject(new Error('Simulated Cloudflare DNS failure'));
        },
        undo: () => {
          trace.push('undo:dns');
          return Promise.resolve();
        },
      },
    ]);

    expect(res.ok).toBe(false);
    expect(res.failed_step).toBe('cf_dns');
    expect(res.rolled_back_steps).toEqual(['cf_tunnel', 'npm_create']);
    expect(trace).toEqual(['run:npm', 'run:tunnel', 'run:dns', 'undo:tunnel', 'undo:npm']);
  });
});
