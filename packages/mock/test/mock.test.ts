import { describe, expect, it } from 'vitest';
import { Redactor } from '@homemcp/core';
import {
  createMockState,
  MockCloudflareConnector,
  MockDockerConnector,
  MockExecutor,
  MockHttpProbeConnector,
  MockNpmConnector,
} from '../src/index.js';

describe('@homemcp/mock', () => {
  it('provides stateful P1 fixtures with redaction and stale route detection', async () => {
    const state = createMockState();
    const redactor = new Redactor();
    const exec = new MockExecutor(state);
    const docker = new MockDockerConnector(state, redactor);
    const npm = new MockNpmConnector(state);
    const cf = new MockCloudflareConnector(state);
    const probe = new MockHttpProbeConnector();

    const health = await exec.call<{ battery: { ac_online: boolean } }>('system.health');
    expect(health.battery.ac_online).toBe(true);

    const logs = await docker.getContainerLogs('cloudflared-cloudflared-1');
    expect(logs).not.toContain('eyJhIjoi');
    expect(logs).toContain('«redacted:');

    const hosts = await npm.listProxyHosts();
    expect(hosts.some((h) => h.domain_names.includes('stale-dead.example.com'))).toBe(true);

    const tunnel = await cf.getTunnelStatus();
    expect(tunnel.connections).toHaveLength(3);

    const deadProbe = await probe.probe('https://stale-dead.example.com/');
    expect(deadProbe.ok).toBe(false);
  });
});
