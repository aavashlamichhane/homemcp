import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { assertSafeTunnelIngress } from '@homemcp/connectors';
import {
  createMockState,
  MockCloudflareConnector,
  MockDockerConnector,
  MockExecutor,
  MockHttpProbeConnector,
  MockNpmConnector,
} from '@homemcp/mock';
import { Redactor } from '@homemcp/core';
import { HomemcpDb } from '../src/db/database.js';
import { ConfirmationGate } from '../src/jobs/confirm.js';
import { PlanManager } from '../src/jobs/plans.js';
import { JobRunner } from '../src/jobs/runner.js';
import { SagaRunner } from '../src/jobs/saga.js';
import { registerBackupModule } from '../src/modules/backup.js';
import { registerDockerModule } from '../src/modules/docker.js';
import { registerNetworkModule } from '../src/modules/network.js';
import { PatManager } from '../src/auth/pats.js';
import { createDefaultMockConfig, type GatewayDeps } from '../src/server/factory.js';
import { HomemcpRegistry } from '../src/server/registry.js';
import { AlertWatcher } from '../src/watcher/watcher.js';
import { McpServer } from '@modelcontextprotocol/server';
import { ALL_SCOPES } from '@homemcp/core';

function createOpsTestDeps() {
  const config = createDefaultMockConfig();
  const db = new HomemcpDb(':memory:');
  const redactor = new Redactor();
  const state = createMockState();
  const registry = new HomemcpRegistry();
  const agent = new MockExecutor(state);
  const docker = new MockDockerConnector(state, redactor);
  const npm = new MockNpmConnector(state);
  const cloudflare = new MockCloudflareConnector(state);
  const httpProbe = new MockHttpProbeConnector();
  const pats = new PatManager(db);
  const jobs = new JobRunner(db, redactor);
  const plans = new PlanManager(db);
  const confirmations = new ConfirmationGate(db, plans, { stepUpMaxAge: '5m' });
  const saga = new SagaRunner();
  const watcher = new AlertWatcher({ db, config, redactor, agent, docker, cloudflare });

  const deps: GatewayDeps = {
    config,
    db,
    redactor,
    registry,
    pats,
    jobs,
    plans,
    confirmations,
    saga,
    watcher,
    agent,
    docker,
    ociRegistry: {
      checkImageUpdate: (img) => Promise.resolve({ image: img, update_available: false }),
    },
    npm,
    cloudflare,
    httpProbe,
    isMock: true,
    version: '0.1.0',
  };

  registerDockerModule(deps);
  registerNetworkModule(deps);
  registerBackupModule(deps);

  return { deps, state };
}

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
        clientInfo: { name: 'ops-test', version: '1.0.0' },
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

describe('Phase 5 Ops: Updates, Auto-Rollback, and Expose/Unexpose Sagas', () => {
  const openDbs: HomemcpDb[] = [];

  afterEach(() => {
    for (const d of openDbs.splice(0)) {
      d.close();
    }
  });

  it('U10: performs health-gated update AND automatically rolls back on health gate failure', async () => {
    const { deps, state } = createOpsTestDeps();
    openDbs.push(deps.db);
    const server = new McpServer({ name: 'homemcp-ops-test', version: '0.1.0' });
    deps.registry.attachToServer(server, {
      db: deps.db,
      redactor: deps.redactor,
      activeToolsets: [...deps.config.server.toolsets],
      defaultAuth: {
        subject: 'owner',
        clientId: 'test',
        tokenKind: 'stdio',
        tokenId: 'local',
        scopes: [...ALL_SCOPES],
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await ct.start();
    const client = createClient(ct);
    await client.init();

    // 1. Healthy update
    const plan1 = await client.callTool('docker_update_service', {
      stack_dir: '/home/homelab/docker-containers/navidrome',
      service: 'navidrome',
      target_image: 'deluan/navidrome:0.64.0',
    });
    expect(plan1.structuredContent['status']).toBe('confirmation_required');
    const plan1Id = String(plan1.structuredContent['plan_id']);
    const conf1Id = String(plan1.structuredContent['confirmation_id']);
    deps.confirmations.approveConfirmation(conf1Id, { approvedBy: 'owner' });

    const apply1 = await client.callTool('docker_update_service', {
      stack_dir: '/home/homelab/docker-containers/navidrome',
      service: 'navidrome',
      plan_id: plan1Id,
    });
    expect(apply1.structuredContent['updated']).toBe(true);
    expect(apply1.structuredContent['rolled_back']).toBe(false);

    // 2. Forced health failure -> automatic rollback
    state.simulateUpdateHealthFailure = true;
    const plan2 = await client.callTool('docker_update_service', {
      stack_dir: '/home/homelab/docker-containers/navidrome',
      service: 'navidrome',
      target_image: 'deluan/navidrome:broken',
    });
    const plan2Id = String(plan2.structuredContent['plan_id']);
    const conf2Id = String(plan2.structuredContent['confirmation_id']);
    deps.confirmations.approveConfirmation(conf2Id, { approvedBy: 'owner' });

    const apply2 = await client.callTool('docker_update_service', {
      stack_dir: '/home/homelab/docker-containers/navidrome',
      service: 'navidrome',
      plan_id: plan2Id,
    });
    expect(apply2.structuredContent['updated']).toBe(false);
    expect(apply2.structuredContent['rolled_back']).toBe(true);

    // 3. Staging-only backup_restore with T3 fresh passkey auth_time
    const restPlan = await client.callTool('backup_restore', {
      set: 'vaultwarden',
      staging_subdir: 'drill-01',
    });
    const rPlanId = String(restPlan.structuredContent['plan_id']);
    const rConfId = String(restPlan.structuredContent['confirmation_id']);
    deps.confirmations.approveConfirmation(rConfId, {
      approvedBy: 'owner',
      authTime: Math.floor(Date.now() / 1000),
    });
    const restApply = await client.callTool('backup_restore', {
      set: 'vaultwarden',
      staging_subdir: 'drill-01',
      plan_id: rPlanId,
    });
    expect(restApply.structuredContent['applied']).toBe(true);
    expect(String(restApply.structuredContent['staging_target'])).toContain('/var/lib/homemcp/backup/staging-restore/drill-01');

    await ct.close();
    await st.close();
  });

  it('executes expose -> unexpose round-trip, mid-saga rollback on CF failure, and Cloudflare safety assertions', async () => {
    const { deps, state } = createOpsTestDeps();
    openDbs.push(deps.db);
    const server = new McpServer({ name: 'homemcp-ops-test', version: '0.1.0' });
    deps.registry.attachToServer(server, {
      db: deps.db,
      redactor: deps.redactor,
      activeToolsets: [...deps.config.server.toolsets],
      defaultAuth: {
        subject: 'owner',
        clientId: 'test',
        tokenKind: 'stdio',
        tokenId: 'local',
        scopes: [...ALL_SCOPES],
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await ct.start();
    const client = createClient(ct);
    await client.init();

    // 1. Mid-saga failure on DNS step MUST undo tunnel ingress and NPM host cleanly!
    const initialHostCount = state.npmHosts.length;
    const initialIngressLen = state.cfTunnelConfig.config.ingress.length;
    state.failNextCfDns = true;

    const failPlan = await client.callTool('expose_plan', {
      hostname: 'broken.example.com',
      upstream_host: '192.0.2.10',
      upstream_port: 8899,
    });
    deps.confirmations.approveConfirmation(String(failPlan.structuredContent['confirmation_id']), {
      approvedBy: 'owner',
      authTime: Math.floor(Date.now() / 1000),
    });
    const failApply = await client.callTool('expose_apply', {
      plan_id: String(failPlan.structuredContent['plan_id']),
    });
    expect(failApply.structuredContent['status']).toBe('rolled_back');
    expect(failApply.structuredContent['rolled_back_steps']).toEqual(['cf_tunnel_ingress', 'npm_proxy_host']);
    expect(state.npmHosts.length).toBe(initialHostCount);
    expect(state.cfTunnelConfig.config.ingress.length).toBe(initialIngressLen);

    // 2. Full expose -> verify -> unexpose round trip
    const okPlan = await client.callTool('expose_plan', {
      hostname: 'demo.example.com',
      upstream_host: 'demo',
      upstream_port: 3000,
      access_emails: ['owner@example.com'],
    });
    deps.confirmations.approveConfirmation(String(okPlan.structuredContent['confirmation_id']), {
      approvedBy: 'owner',
      authTime: Math.floor(Date.now() / 1000),
    });
    const okApply = await client.callTool('expose_apply', {
      plan_id: String(okPlan.structuredContent['plan_id']),
    });
    expect(okApply.structuredContent['status']).toBe('applied');
    expect(state.npmHosts.some((h) => h.domain_names.includes('demo.example.com'))).toBe(true);
    expect(state.cfDnsRecords.some((d) => d.name === 'demo.example.com')).toBe(true);
    expect(state.cfAccessApps.some((a) => a.domain === 'demo.example.com')).toBe(true);

    // Verify cf_ingress_history snapshot recorded
    const histRows = deps.db.db.prepare('SELECT count(*) AS cnt FROM cf_ingress_history').get() as { cnt: number };
    expect(histRows.cnt).toBeGreaterThanOrEqual(1);

    // Unexpose cleanly
    const unPlan = await client.callTool('unexpose_plan', { hostname: 'demo.example.com' });
    deps.confirmations.approveConfirmation(String(unPlan.structuredContent['confirmation_id']), {
      approvedBy: 'owner',
      authTime: Math.floor(Date.now() / 1000),
    });
    const unApply = await client.callTool('unexpose_apply', {
      plan_id: String(unPlan.structuredContent['plan_id']),
    });
    expect(unApply.structuredContent['status']).toBe('applied');
    expect(state.npmHosts.some((h) => h.domain_names.includes('demo.example.com'))).toBe(false);
    expect(state.cfDnsRecords.some((d) => d.name === 'demo.example.com')).toBe(false);

    // 3. Cloudflare ingress safety assertion rejects dropping http_status:404 or ssh.*/homemcp.*
    expect(() =>
      assertSafeTunnelIngress(state.cfTunnelConfig.config, {
        'warp-routing': { enabled: true },
        ingress: [{ hostname: 'ssh.example.com', service: 'ssh://192.0.2.10:22' }], // missing 404 catch-all!
      }),
    ).toThrow(/http_status:404/);

    expect(() =>
      assertSafeTunnelIngress(state.cfTunnelConfig.config, {
        'warp-routing': { enabled: true },
        ingress: [
          { hostname: 'homemcp.example.com', service: 'http://homemcp:8790' },
          { service: 'http_status:404' }, // dropped ssh.example.com!
        ],
      }),
    ).toThrow(/protected Cloudflare ingress/i);

    await ct.close();
    await st.close();
  });
});
