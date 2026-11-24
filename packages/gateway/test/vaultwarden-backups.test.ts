import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { buildMcpServer, createGatewayDeps, type GatewayDeps } from '../src/index.js';

function createClient(transport: InMemoryTransport) {
  let nextId = 1;
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  transport.onmessage = (msg: JSONRPCMessage) => {
    const rec = msg as unknown as Record<string, unknown>;
    if (typeof rec['id'] === 'number' && pending.has(rec['id'])) {
      const resolve = pending.get(rec['id'])!;
      pending.delete(rec['id']);
      resolve(rec);
    }
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const p = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    await transport.send({ jsonrpc: '2.0', id, method, params });
    return p;
  };
  return {
    init: async () => {
      await call('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'vw-backup-test', version: '1.0.0' },
      });
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      const res = await call('tools/call', { name, arguments: args });
      expect(res['error']).toBeUndefined();
      return res['result'] as { isError?: boolean; structuredContent: Record<string, unknown> };
    },
  };
}

describe('Vaultwarden Backup Management MCP Tools', () => {
  const openDeps: GatewayDeps[] = [];

  afterEach(() => {
    for (const d of openDeps.splice(0)) {
      d.db.close();
    }
  });

  it('supports dedicated Vaultwarden status, snapshots, backup run, restore test, prune plan/apply, and T3 staging restore', async () => {
    const deps = createGatewayDeps({ mock: true });
    openDeps.push(deps);
    const server = buildMcpServer(deps, { toolsetFilter: 'vaultwarden' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await ct.start();
    const client = createClient(ct);
    await client.init();

    // 1. Dedicated status & snapshot listing
    const status = await client.callTool('vaultwarden_backup_status');
    expect(status.structuredContent['set']).toBe('vaultwarden');
    expect(status.structuredContent['stale']).toBe(false);
    expect(status.structuredContent['snapshot_count']).toBe(1);

    const snapsBefore = await client.callTool('vaultwarden_backup_snapshots', { limit: 10 });
    expect(snapsBefore.structuredContent['count']).toBe(1);

    // 2. Run on-demand Vaultwarden backup + verify snapshot count increments
    const runRes = await client.callTool('vaultwarden_backup_run');
    expect(runRes.structuredContent['status']).toBe('succeeded');
    const snapsAfter = await client.callTool('vaultwarden_backup_snapshots', { limit: 10 });
    expect(snapsAfter.structuredContent['count']).toBe(2);

    // 3. Automated integrity restore test
    const testRes = await client.callTool('vaultwarden_backup_test', { snapshot_id: 'a1b2c3d4' });
    expect(testRes.structuredContent['status']).toBe('succeeded');
    expect(String(testRes.structuredContent['output'])).toContain('RESTORE_TEST=ok');

    // 4. Prune plan -> unconfirmed apply blocked -> confirmed apply succeeds
    const prunePlan = await client.callTool('vaultwarden_backup_prune_plan');
    const prunePlanId = String(prunePlan.structuredContent['plan_id']);
    const pruneConfId = String(prunePlan.structuredContent['confirmation_id']);

    const unconfirmedPrune = await client.callTool('vaultwarden_backup_prune_apply', {
      plan_id: prunePlanId,
    });
    expect(unconfirmedPrune.structuredContent['applied']).toBe(false);
    expect(unconfirmedPrune.structuredContent['status']).toBe('confirmation_required');

    deps.confirmations.approveConfirmation(pruneConfId, { approvedBy: 'owner' });
    const confirmedPrune = await client.callTool('vaultwarden_backup_prune_apply', {
      plan_id: prunePlanId,
    });
    expect(confirmedPrune.structuredContent['applied']).toBe(true);

    // 5. Staging restore requires T3 fresh passkey auth_time
    const stagePlan = await client.callTool('vaultwarden_backup_restore_staging', {
      snapshot_id: 'a1b2c3d4',
      staging_subdir: 'vw-drill',
    });
    const stPlanId = String(stagePlan.structuredContent['plan_id']);
    const stConfId = String(stagePlan.structuredContent['confirmation_id']);
    deps.confirmations.approveConfirmation(stConfId, {
      approvedBy: 'owner',
      authTime: Math.floor(Date.now() / 1000),
    });

    const stageApply = await client.callTool('vaultwarden_backup_restore_staging', {
      snapshot_id: 'a1b2c3d4',
      staging_subdir: 'vw-drill',
      plan_id: stPlanId,
    });
    expect(stageApply.structuredContent['applied']).toBe(true);
    expect(String(stageApply.structuredContent['staging_target'])).toBe(
      '/var/lib/homemcp/backup/staging-restore/vw-drill',
    );
    expect(String(stageApply.structuredContent['output'])).toContain('INTEGRITY=ok');

    await ct.close();
    await st.close();
  });
});
