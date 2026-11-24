import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMcpServer, createGatewayDeps, type GatewayDeps } from '../src/index.js';

function createJsonRpcClient(transport: InMemoryTransport) {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();

  transport.onmessage = (msg: JSONRPCMessage) => {
    const rec = msg as unknown as Record<string, unknown>;
    const id = rec['id'];
    if (typeof id === 'number' && pending.has(id)) {
      const p = pending.get(id)!;
      pending.delete(id);
      p.resolve(rec);
    }
  };

  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    await transport.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  };

  const init = async () => {
    const res = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    await transport.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    return res;
  };

  return { init, request };
}

describe('P1 Gateway MCP server (mock mode)', () => {
  const openDeps: GatewayDeps[] = [];

  afterEach(() => {
    for (const d of openDeps.splice(0)) {
      d.db.close();
    }
  });

  it('enforces annotations, outputSchema, tier, and toolset on every registered tool', () => {
    const deps = createGatewayDeps({ mock: true });
    openDeps.push(deps);
    const tools = deps.registry.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(24);
    for (const t of tools) {
      expect(t.annotations.title).toBeTruthy();
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations.destructiveHint).toBe('boolean');
      expect(typeof t.annotations.idempotentHint).toBe('boolean');
      expect(typeof t.annotations.openWorldHint).toBe('boolean');
      expect(t.outputSchema).toBeDefined();
      expect(t.tier).toMatch(/^T[0-3]$/);
    }
  });

  it('passes U1, U2 (redacted), U3, U6-read, and U9 acceptance workflows over MCP JSON-RPC', async () => {
    const deps = createGatewayDeps({ mock: true });
    openDeps.push(deps);

    // Seed an older disk snapshot to verify days_until_full forecast
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    deps.db.insertMetricSnapshot(
      'disk',
      { filesystems: [{ mountpoint: '/mnt/storage', used_bytes: 750_000_000_000 }] },
      threeDaysAgo,
    );

    const server = buildMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await clientTransport.start();

    const client = createJsonRpcClient(clientTransport);
    await client.init();

    const callTool = async (name: string, args: Record<string, unknown> = {}) => {
      const resp = await client.request('tools/call', { name, arguments: args });
      expect(resp['error']).toBeUndefined();
      return resp['result'] as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        structuredContent: Record<string, unknown>;
      };
    };

    // U1: overview & docker_list_services incl. dormant stacks
    const overview = await callTool('homemcp_overview');
    expect(overview.isError).toBeFalsy();
    expect((overview.structuredContent['containers'] as { running: number }).running).toBeGreaterThanOrEqual(5);

    const listSvc = await callTool('docker_list_services');
    const dormant = listSvc.structuredContent['dormant_stacks'] as Array<{ name: string }>;
    expect(dormant.some((s) => s.name === 'immich-app')).toBe(true);

    // U2: docker_service_profile on navidrome & cloudflared-cloudflared-1 (must have ZERO secret leaks)
    const naviProfile = await callTool('docker_service_profile', { name: 'navidrome' });
    expect(naviProfile.isError).toBeFalsy();

    const cfProfile = await callTool('docker_service_profile', { name: 'cloudflared-cloudflared-1' });
    const cfLogs = await callTool('docker_logs', { name: 'cloudflared-cloudflared-1' });
    const cfSerialized = JSON.stringify(cfProfile) + JSON.stringify(cfLogs);
    expect(cfSerialized).not.toContain('eyJhIjoi');
    expect(cfSerialized).toContain('«redacted:');

    // U3: system_health, system_disks (forecast), smart, errors, security_audit
    const health = await callTool('system_health');
    expect(health.structuredContent['reboot_required']).toBe(false);

    const disks = await callTool('system_disks');
    const hdd = (disks.structuredContent['filesystems'] as Array<{ mountpoint: string; days_until_full?: number }>).find(
      (f) => f.mountpoint === '/mnt/storage',
    );
    expect(hdd?.days_until_full).toBeGreaterThan(0);

    const smart = await callTool('system_smart_details', { device: 'sda' });
    expect(smart.structuredContent['passed']).toBe(true);

    const errs = await callTool('system_errors_summary');
    expect(errs.structuredContent['untrusted_source']).toBe('journald');

    const sec = await callTool('system_security_audit');
    expect(sec.structuredContent['failed_ssh_logins_24h']).toBe(0);

    // U6-read: backup_status, backup_snapshots, vaultwarden_health
    const bkp = await callTool('backup_status', { set: 'vaultwarden' });
    expect(bkp.structuredContent['within_budget']).toBe(true);

    const snaps = await callTool('backup_snapshots', { set: 'vaultwarden' });
    expect((snaps.structuredContent['snapshots'] as unknown[]).length).toBe(1);

    const vw = await callTool('vaultwarden_health');
    expect(vw.structuredContent['alive']).toBe(true);
    expect(vw.structuredContent['admin_panel_disabled']).toBe(true);

    // U9: network_routes flags stale-dead.example.com
    const routes = await callTool('network_routes', { probe: true });
    expect(Number(routes.structuredContent['dead_count'])).toBeGreaterThanOrEqual(1);

    // Audit recorded every tool call
    const audit = await callTool('audit_query', { limit: 50 });
    expect((audit.structuredContent['entries'] as unknown[]).length).toBeGreaterThanOrEqual(12);

    // Resources & prompts
    const resRead = await client.request('resources/read', { uri: 'homemcp://backup/status' });
    expect(resRead['error']).toBeUndefined();

    const promptGet = await client.request('prompts/get', {
      name: 'triage_service',
      arguments: { service: 'navidrome' },
    });
    expect(promptGet['error']).toBeUndefined();

    await clientTransport.close();
    await serverTransport.close();
  });

  it('filters tools by caller scopes and URL toolset parameter', async () => {
    const deps = createGatewayDeps({ mock: true });
    openDeps.push(deps);

    const server = buildMcpServer(deps, {
      toolsetFilter: 'backup,vaultwarden',
      auth: {
        subject: 'reader',
        clientId: 'c1',
        tokenKind: 'oauth',
        tokenId: 't1',
        scopes: ['homemcp:read'],
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await clientTransport.start();

    const client = createJsonRpcClient(clientTransport);
    await client.init();

    const listResp = await client.request('tools/list');
    const tools = (listResp['result'] as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['backup_snapshots', 'backup_status', 'vaultwarden_health']);

    await clientTransport.close();
    await serverTransport.close();
  });
});
