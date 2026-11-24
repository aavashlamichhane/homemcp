import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpHealthchecksConnector } from '../src/healthchecks.js';
import { HttpJellyfinConnector } from '../src/jellyfin.js';
import { HttpNtfyConnector } from '../src/ntfy.js';
import { HttpQbittorrentConnector } from '../src/qbittorrent.js';

describe('Phase 4 connectors (Jellyfin, qBittorrent, ntfy, healthchecks)', () => {
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

  it('HttpJellyfinConnector authenticates via X-Emby-Token and reads health, sessions, and items', async () => {
    const url = await startMockServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('Healthy');
        return;
      }
      expect(req.headers['x-emby-token']).toBe('jf-api-fixture');
      if (req.url === '/System/Info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Id: 'jf-1', ServerName: 'homelab-jf', Version: '10.11.8' }));
        return;
      }
      if (req.url === '/Sessions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ Id: 'sess-1', UserName: 'alice' }]));
        return;
      }
      if (req.url?.startsWith('/Items')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Items: [{ Id: 'm1', Name: 'Movie One', Type: 'Movie' }], TotalRecordCount: 1 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const jf = new HttpJellyfinConnector({ url, apiKey: 'jf-api-fixture' });
    expect((await jf.getHealth()).ok).toBe(true);
    expect((await jf.getSystemInfo()).Version).toBe('10.11.8');
    expect(await jf.getSessions()).toHaveLength(1);
    expect((await jf.searchItems({ searchTerm: 'Movie' })).Items).toHaveLength(1);
  });

  it('HttpQbittorrentConnector logs in, reuses SID cookie, and adds/controls torrents', async () => {
    let loginCount = 0;
    const seenPaths: string[] = [];
    const url = await startMockServer((req, res) => {
      seenPaths.push(req.url ?? '/');
      if (req.url === '/api/v2/auth/login') {
        loginCount++;
        res.writeHead(200, { 'set-cookie': 'SID=mock-sid-123; Path=/; HttpOnly' });
        res.end('Ok.');
        return;
      }
      if (req.headers.cookie !== 'SID=mock-sid-123') {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.url === '/api/v2/transfer/info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ dl_info_speed: 1024, up_info_speed: 512, dl_info_data: 0, up_info_data: 0, connection_status: 'connected' }));
        return;
      }
      if (req.url?.startsWith('/api/v2/torrents/info')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      res.writeHead(200);
      res.end('Ok.');
    });

    const qb = new HttpQbittorrentConnector({ url, user: 'admin', password: 'qb-password-fixture' });
    const info = await qb.getTransferInfo();
    expect(info.dl_info_speed).toBe(1024);
    await qb.addTorrent({ urls: ['magnet:?xt=urn:btih:0123456789'], category: 'movies' });
    await qb.controlTorrents('pause', ['0123456789']);
    expect(loginCount).toBe(1);
    expect(seenPaths).toContain('/api/v2/torrents/add');
    expect(seenPaths).toContain('/api/v2/torrents/stop');
  });

  it('HttpNtfyConnector and HttpHealthchecksConnector send notifications and pings', async () => {
    const requests: Array<{ url: string; auth?: string; title?: string; body: string }> = [];
    const url = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          url: req.url ?? '/',
          auth: req.headers.authorization,
          title: typeof req.headers['title'] === 'string' ? req.headers['title'] : undefined,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200);
        res.end('ok');
      });
    });

    const ntfy = new HttpNtfyConnector({ url: `${url}/alerts`, token: 'ntfy-tok-fixture' });
    await ntfy.send({ title: 'Test Alert', message: 'Disk ok', priority: 3, tags: ['white_check_mark'] });

    const hc = new HttpHealthchecksConnector({ pingUrl: `${url}/hc/uuid-1` });
    expect(await hc.ping('start')).toBe(true);
    expect(await hc.ping('ok')).toBe(true);

    expect(requests.find((r) => r.url === '/alerts')?.auth).toBe('Bearer ntfy-tok-fixture');
    expect(requests.some((r) => r.url === '/hc/uuid-1/start')).toBe(true);
    expect(requests.some((r) => r.url === '/hc/uuid-1')).toBe(true);
  });
});
