import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { validateComposePolicy } from '@homemcp/core';
import { loadStackTemplates, renderTemplateCompose } from '../src/modules/stacks.js';
import { buildMcpServer, createGatewayDeps, type GatewayDeps } from '../src/server/factory.js';

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
        clientInfo: { name: 'p6-test', version: '1.0.0' },
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

describe('Phase 6 Stacks, Files, Templates, Media Rename, and Smart Playlists', () => {
  const openDeps: GatewayDeps[] = [];

  afterEach(() => {
    for (const d of openDeps.splice(0)) {
      d.db.close();
    }
  });

  it('validates that all 7 curated templates render cleanly and pass compose security policy with 0 violations', () => {
    const tpls = loadStackTemplates();
    expect(tpls.map((t) => t.name).sort()).toEqual([
      'actual-budget',
      'homepage',
      'it-tools',
      'ntfy',
      'searxng',
      'shlink',
      'uptime-kuma',
    ]);
    for (const t of tpls) {
      const rendered = renderTemplateCompose(t, {}, t.name);
      const pol = validateComposePolicy(rendered.composeYaml, {
        stackName: t.name,
        stackDir: `/home/homelab/docker-containers/${t.name}`,
        allowedBindRoots: [`/home/homelab/docker-containers/${t.name}`, '/mnt/storage/media'],
      });
      expect(pol.allowed).toBe(true);
      expect(pol.violations).toEqual([]);
      expect(pol.warnings).toEqual([]);
    }
  });

  it('passes U8 (deploy template + secret never returned + expose + trash removal) and U12 (dormant stack start/stop)', async () => {
    const deps = createGatewayDeps({ mock: true });
    openDeps.push(deps);
    const server = buildMcpServer(deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await ct.start();
    const client = createClient(ct);
    await client.init();

    // U8: deploy searxng from template (generates SEARXNG_SECRET to .env, value NEVER returned!)
    const planRes = await client.callTool('stacks_plan', {
      name: 'searxng',
      template: 'searxng',
      params: { hostname: 'search.example.com' },
    });
    const planId = String(planRes.structuredContent['plan_id']);
    const confId = String(planRes.structuredContent['confirmation_id']);
    deps.confirmations.approveConfirmation(confId, { approvedBy: 'owner' });

    const applyRes = await client.callTool('stacks_apply', { plan_id: planId });
    expect(applyRes.structuredContent['applied']).toBe(true);
    expect(applyRes.structuredContent['generated_secret_keys']).toEqual(['SEARXNG_SECRET']);
    expect(JSON.stringify(applyRes)).not.toContain('mock-generated-secret-value');

    // Reading .env directly MUST fail
    const envRead = await client.callTool('files_read', {
      path: '/home/homelab/docker-containers/searxng/.env',
    });
    expect(envRead.isError).toBe(true);
    expect((envRead.structuredContent['error'] as { code: string }).code).toBe('POLICY_DENIED');

    // Reading traversal path MUST fail
    const travRead = await client.callTool('files_read', {
      path: '/home/homelab/docker-containers/../../etc/passwd',
    });
    expect(travRead.isError).toBe(true);

    // Reading normal compose file succeeds
    const okRead = await client.callTool('files_read', {
      path: '/home/homelab/docker-containers/searxng/docker-compose.yml',
    });
    expect(okRead.isError).toBeFalsy();

    // Remove stack to .trash with T3 passkey confirmation
    const remPlan = await client.callTool('stacks_remove', {
      stack_dir: '/home/homelab/docker-containers/searxng',
    });
    deps.confirmations.approveConfirmation(String(remPlan.structuredContent['confirmation_id']), {
      approvedBy: 'owner',
      authTime: Math.floor(Date.now() / 1000),
    });
    const remApply = await client.callTool('stacks_remove', {
      stack_dir: '/home/homelab/docker-containers/searxng',
      plan_id: String(remPlan.structuredContent['plan_id']),
    });
    expect(remApply.structuredContent['applied']).toBe(true);
    expect(String(remApply.structuredContent['trash_path'])).toContain('.trash');

    // U12: dormant stack immich-app up -> down
    const upRes = await client.callTool('stacks_up', {
      stack_dir: '/home/homelab/docker-containers/immich-app',
    });
    expect(upRes.structuredContent['status']).toBe('up');

    const downPlan = await client.callTool('stacks_down', {
      stack_dir: '/home/homelab/docker-containers/immich-app',
    });
    deps.confirmations.approveConfirmation(String(downPlan.structuredContent['confirmation_id']), {
      approvedBy: 'owner',
    });
    const downApply = await client.callTool('stacks_down', {
      stack_dir: '/home/homelab/docker-containers/immich-app',
      plan_id: String(downPlan.structuredContent['plan_id']),
    });
    expect(downApply.structuredContent['applied']).toBe(true);

    // Agent-level rejection of malicious compose YAML (bypassing gateway plan check)
    await expect(
      deps.agent.call('stacks.apply', {
        name: 'evil',
        compose_yaml: 'services:\n  evil:\n    image: alpine:3.20\n    privileged: true\n',
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    // Oversized file read (>256 KB) rejected
    await deps.agent.call('files.write', {
      path: '/home/homelab/docker-containers/navidrome/huge.txt',
      content: 'x'.repeat(300_000),
    });
    const bigRead = await client.callTool('files_read', {
      path: '/home/homelab/docker-containers/navidrome/huge.txt',
    });
    expect(bigRead.isError).toBe(true);
    expect((bigRead.structuredContent['error'] as { code: string }).code).toBe('INVALID_ARGUMENT');

    // Smart playlist create (.nsp)
    const nsp = await client.callTool('music_smart_playlist_create', {
      filename: 'recent_favs.nsp',
      name: 'Recent Favorites',
      all: [{ greaterThan: { rating: 3 } }],
    });
    expect(nsp.structuredContent['created']).toBe(true);

    await ct.close();
    await st.close();
  });
});
