import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Redactor } from '@homemcp/core';
import { HttpCloudflareConnector } from '../src/cloudflare.js';
import { HttpDockerConnector } from '../src/docker.js';
import { NodeHttpProbeConnector } from '../src/http-probe.js';
import { HttpNpmConnector } from '../src/npm.js';
import { HttpVaultwardenConnector } from '../src/vaultwarden.js';

describe('P1 connectors', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  async function startMockServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<string> {
    const srv = http.createServer(handler);
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('DockerConnector strips Env values and redacts Cmd/Logs', async () => {
    const redactor = new Redactor();
    const url = await startMockServer((req, res) => {
      if (req.url === '/containers/c1/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            Id: 'c1',
            Name: '/cloudflared',
            Created: '2026-01-01T00:00:00Z',
            Image: 'sha256:abc',
            State: {
              Status: 'running',
              Running: true,
              Restarting: false,
              OOMKilled: false,
              ExitCode: 0,
              StartedAt: '',
              FinishedAt: '',
            },
            RestartCount: 0,
            Config: {
              Image: 'cloudflare/cloudflared:2026.5.2',
              Env: [
                'TUNNEL_TOKEN=eyJhIjoiYWJjZGVmMDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzIn0=',
                'PORT=8080',
              ],
              Labels: {},
              Cmd: [
                'tunnel',
                'run',
                '--token',
                'eyJhIjoiYWJjZGVmMDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzIn0=',
              ],
            },
            Mounts: [],
            NetworkSettings: { Networks: { cloudflared_default: {} }, Ports: {} },
            HostConfig: { NetworkMode: 'cloudflared_default', Memory: 134217728 },
          }),
        );
        return;
      }
      if (req.url?.startsWith('/containers/c1/logs')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('2026-01-01T00:00:00Z started with Authorization: Bearer secretjwt123\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const docker = new HttpDockerConnector(url, redactor);
    const inspected = await docker.inspectContainer('c1');
    expect(inspected.Config.EnvKeys).toEqual(['TUNNEL_TOKEN', 'PORT']);
    const serialized = JSON.stringify(inspected);
    expect(serialized).not.toContain('eyJhIjoi');

    const logs = await docker.getContainerLogs('c1', { tail: 50 });
    expect(logs).not.toContain('secretjwt123');
    expect(logs).toContain('«redacted:');
  });

  it('NpmConnector authenticates, caches token, and lists proxy hosts', async () => {
    let tokenCalls = 0;
    const url = await startMockServer((req, res) => {
      if (req.url === '/api/tokens' && req.method === 'POST') {
        tokenCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            token: 'npm-jwt-123',
            expires: new Date(Date.now() + 3600_000).toISOString(),
          }),
        );
        return;
      }
      if (req.url?.startsWith('/api/nginx/proxy-hosts')) {
        expect(req.headers.authorization).toBe('Bearer npm-jwt-123');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              id: 1,
              domain_names: ['app.example.com'],
              forward_scheme: 'http',
              forward_host: '192.0.2.10',
              forward_port: 8080,
              certificate_id: 2,
              access_list_id: 0,
              ssl_forced: true,
              block_exploits: true,
              allow_websocket_upgrade: true,
              caching_enabled: false,
              enabled: true,
            },
          ]),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const npm = new HttpNpmConnector({ url, email: 'mcp@example.com', password: 'pw' });
    const hosts1 = await npm.listProxyHosts();
    const hosts2 = await npm.listProxyHosts();
    expect(hosts1).toHaveLength(1);
    expect(hosts2).toHaveLength(1);
    expect(tokenCalls).toBe(1);
  });

  it('HttpProbeConnector follows redirects and VaultwardenConnector checks /alive', async () => {
    const url = await startMockServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/alive' });
        res.end();
        return;
      }
      if (req.url === '/alive') {
        res.writeHead(200);
        res.end('OK');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const probe = new NodeHttpProbeConnector();
    const res = await probe.probe(`${url}/redirect`);
    expect(res.ok).toBe(true);
    expect(res.status_code).toBe(200);
    expect(res.redirect_chain).toHaveLength(1);

    const vw = new HttpVaultwardenConnector({ url, publicUrl: 'https://vw.example.com' });
    const vwHealth = await vw.checkHealth({
      containerLabels: { 'org.opencontainers.image.version': '1.37.0' },
      containerEnvKeys: ['DOMAIN', 'SIGNUPS_ALLOWED'],
      configuredDomain: 'https://vw.example.com',
    });
    expect(vwHealth.alive).toBe(true);
    expect(vwHealth.admin_panel_disabled).toBe(true);
    expect(vwHealth.domain_matches_public_url).toBe(true);
  });

  it('CloudflareConnector class initializes cleanly', () => {
    const cf = new HttpCloudflareConnector({
      accountId: 'acc1',
      tunnelId: 'tun1',
      apiToken: 'tok1',
      zones: ['example.com'],
    });
    expect(cf).toBeDefined();
  });
});
