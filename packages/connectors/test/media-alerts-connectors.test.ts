import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpHealthchecksConnector } from '../src/healthchecks.js';
import { HttpJackettConnector } from '../src/jackett.js';
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
        res.end(
          JSON.stringify({
            Items: [{ Id: 'm1', Name: 'Movie One', Type: 'Movie' }],
            TotalRecordCount: 1,
          }),
        );
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
        res.end(
          JSON.stringify({
            dl_info_speed: 1024,
            up_info_speed: 512,
            dl_info_data: 0,
            up_info_data: 0,
            connection_status: 'connected',
          }),
        );
        return;
      }
      if (req.url?.startsWith('/api/v2/torrents/info')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      if (req.url?.startsWith('/api/v2/torrents/files')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([{ index: 0, name: 'movie.mkv', size: 1000, progress: 1, priority: 1 }]),
        );
        return;
      }
      if (req.url?.startsWith('/api/v2/torrents/trackers')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              url: 'https://tracker.example.org/announce?passkey=secret',
              status: 2,
              num_peers: 5,
              msg: 'Working',
            },
          ]),
        );
        return;
      }
      if (req.url === '/api/v2/torrents/start') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('Ok.');
    });

    const qb = new HttpQbittorrentConnector({
      url,
      user: 'admin',
      password: 'qb-password-fixture',
    });
    const info = await qb.getTransferInfo();
    expect(info.dl_info_speed).toBe(1024);
    await qb.addTorrent({ urls: ['magnet:?xt=urn:btih:0123456789'], category: 'movies' });
    await qb.controlTorrents('pause', ['0123456789']);
    await qb.controlTorrents('resume', ['0123456789']);
    const files = await qb.getTorrentFiles('0123456789');
    const trackers = await qb.getTorrentTrackers('0123456789');
    await qb.addTorrentFile({
      filename: 'sample.torrent',
      data: new Uint8Array([1, 2, 3]),
      category: 'movies',
    });
    expect(loginCount).toBe(1);
    expect(files).toHaveLength(1);
    expect(trackers).toHaveLength(1);
    expect(seenPaths.filter((p) => p === '/api/v2/torrents/add')).toHaveLength(2);
    expect(seenPaths).toContain('/api/v2/torrents/stop');
    expect(seenPaths).toContain('/api/v2/torrents/start');
    expect(seenPaths).toContain('/api/v2/torrents/resume');
  });

  it('HttpJackettConnector lists indexers, merges parallel fast+timeout search, and safely resolves downloads', async () => {
    const secretKey = 'jackett-fixture-key-9999';
    const url = await startMockServer((req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (parsed.pathname === '/api/v2.0/indexers/all/results/torznab/api') {
        expect(parsed.searchParams.get('apikey')).toBe(secretKey);
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?>
          <indexers>
            <indexer id="idx-fast" configured="true"><title>FastIdx</title><caps><categories><category id="2000" name="Movies"/></categories></caps></indexer>
            <indexer id="idx-slow" configured="true"><title>SlowIdx</title><caps><categories><category id="2000" name="Movies"/></categories></caps></indexer>
          </indexers>`,
        );
        return;
      }
      if (parsed.pathname === '/api/v2.0/indexers/idx-fast/results') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            Indexers: [{ ID: 'idx-fast', Name: 'FastIdx', Status: 2, Results: 1, ElapsedTime: 25 }],
            Results: [
              {
                Title: 'Sample Release 1080p',
                Tracker: 'FastIdx',
                TrackerId: 'idx-fast',
                Size: 2_000_000_000,
                Seeders: 50,
                Peers: 4,
                CategoryDesc: 'Movies/HD',
                PublishDate: '2026-11-20T00:00:00Z',
                InfoHash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
                MagnetUri: null,
                Link: `${url}/dl/idx-fast/?jackett_apikey=${secretKey}&file=sample`,
              },
            ],
          }),
        );
        return;
      }
      if (parsed.pathname === '/api/v2.0/indexers/idx-slow/results') {
        // Deliberately stall past test timeoutMs
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200);
            res.end('{}');
          }
        }, 2_500);
        return;
      }
      if (parsed.pathname === '/dl/idx-fast/magnet') {
        res.writeHead(302, { location: 'magnet:?xt=urn:btih:aaaa1111' });
        res.end();
        return;
      }
      if (parsed.pathname === '/dl/idx-fast/') {
        res.writeHead(200, {
          'content-type': 'application/x-bittorrent',
          'content-disposition': 'attachment; filename="sample.torrent"',
        });
        res.end(Buffer.from('d8:announcee'));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const jkt = new HttpJackettConnector({ url, apiKey: secretKey, defaultTimeoutSeconds: 5 });
    const indexers = await jkt.listIndexers();
    expect(indexers.map((i) => i.id)).toEqual(['idx-fast', 'idx-slow']);

    const searchRes = await jkt.search({ query: 'Sample', timeoutMs: 1_000 });
    expect(searchRes.results).toHaveLength(1);
    expect(searchRes.results[0]?.seeders).toBe(50);
    expect(searchRes.indexers.find((i) => i.id === 'idx-fast')?.status).toBe('ok');
    const slowStat = searchRes.indexers.find((i) => i.id === 'idx-slow');
    expect(slowStat?.status).toBe('timeout');
    expect(slowStat?.error).not.toContain(secretKey);

    const torrentRes = await jkt.resolveDownload(`${url}/dl/idx-fast/?jackett_apikey=${secretKey}`);
    expect(torrentRes).toMatchObject({ kind: 'torrent', filename: 'sample.torrent' });

    const magnetRes = await jkt.resolveDownload(`${url}/dl/idx-fast/magnet`);
    expect(magnetRes).toEqual({ kind: 'magnet', magnetUri: 'magnet:?xt=urn:btih:aaaa1111' });

    await expect(jkt.resolveDownload('http://198.51.100.10:9117/evil')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
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
    await ntfy.send({
      title: 'Test Alert',
      message: 'Disk ok',
      priority: 3,
      tags: ['white_check_mark'],
    });

    const hc = new HttpHealthchecksConnector({ pingUrl: `${url}/hc/uuid-1` });
    expect(await hc.ping('start')).toBe(true);
    expect(await hc.ping('ok')).toBe(true);

    expect(requests.find((r) => r.url === '/alerts')?.auth).toBe('Bearer ntfy-tok-fixture');
    expect(requests.some((r) => r.url === '/hc/uuid-1/start')).toBe(true);
    expect(requests.some((r) => r.url === '/hc/uuid-1')).toBe(true);
  });
});
