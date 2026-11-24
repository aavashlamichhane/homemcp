import { createHash } from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpNaviloadConnector } from '../src/naviload.js';
import { HttpSubsonicConnector } from '../src/subsonic.js';
import {
  extractYoutubeIdFromPath,
  matchRequestedTracks,
  normalizeTrackText,
} from '../src/track-matcher.js';

describe('Phase 3 music connectors & track matcher', () => {
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

  it('normalizes diacritics, feat., video tags, swaps, and matches 11-char YouTube IDs', () => {
    expect(normalizeTrackText('Beyoncé - Halo (Official Video) [abc123def45]')).toBe(
      'beyonce halo',
    );
    expect(
      normalizeTrackText('Daft Punk feat. Pharrell Williams - Get Lucky [Remastered 2024]'),
    ).toBe('daft punk get lucky');
    expect(extractYoutubeIdFromPath('/music/Artist/Track [dQw4w9WgXcQ].m4a')).toBe('dQw4w9WgXcQ');

    const library = [
      {
        id: 's1',
        title: 'Halo (Official Audio)',
        artist: 'Beyoncé feat. Someone',
        path: '/music/Beyonce/Halo [abcdef12345].m4a',
      },
      {
        id: 's2',
        title: 'Midnight City',
        artist: 'M83',
        path: '/music/M83/Midnight City.flac',
      },
      {
        id: 's3',
        title: 'Nights',
        artist: 'Frank Ocean',
        path: '/music/Frank Ocean/Nights.m4a',
      },
    ];

    const matches = matchRequestedTracks(
      [
        { artist: 'Anyone', title: 'Anything', video_id: 'abcdef12345' },
        { artist: 'M83', title: 'Midnight City (Official Video)' },
        { artist: 'Nights', title: 'Frank Ocean' }, // swapped Artist <-> Title
        { artist: 'Unrelated Artist', title: 'Totally Missing Song' },
      ],
      library,
    );

    expect(matches[0]).toMatchObject({
      matched: true,
      confidence: 1.0,
      match_reason: 'youtube_video_id',
    });
    expect(matches[1]).toMatchObject({ matched: true, track: { id: 's2' } });
    expect(matches[2]).toMatchObject({
      matched: true,
      match_reason: 'swapped_artist_title',
      track: { id: 's3' },
    });
    expect(matches[3]?.matched).toBe(false);
    expect(matches[3]?.confidence).toBeLessThan(0.78);
  });

  it('HttpSubsonicConnector signs requests with MD5 salted token and maps Subsonic errors', async () => {
    const seenQueries: URLSearchParams[] = [];
    const url = await startMockServer((req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      seenQueries.push(parsed.searchParams);
      if (parsed.pathname === '/rest/ping') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1' } }));
        return;
      }
      if (parsed.pathname === '/rest/search3') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            'subsonic-response': {
              status: 'ok',
              searchResult3: {
                artist: [],
                album: [],
                song: [{ id: 'song-1', title: 'Solar', artist: 'Artist One' }],
              },
            },
          }),
        );
        return;
      }
      if (parsed.pathname === '/rest/getSong') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            'subsonic-response': {
              status: 'failed',
              error: { code: 70, message: 'Song not found' },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const sub = new HttpSubsonicConnector({ url, user: 'mcp', password: 'subsonic-pass-fixture' });
    expect(await sub.ping()).toBe(true);
    const qs = seenQueries[0]!;
    expect(qs.get('u')).toBe('mcp');
    expect(qs.get('v')).toBe('1.16.1');
    expect(qs.get('c')).toBe('homemcp');
    expect(qs.get('f')).toBe('json');
    const salt = qs.get('s')!;
    const expectedToken = createHash('md5').update(`subsonic-pass-fixture${salt}`).digest('hex');
    expect(qs.get('t')).toBe(expectedToken);

    const sr = await sub.search3('Solar');
    expect(sr.songs).toHaveLength(1);
    expect(sr.songs[0]?.id).toBe('song-1');

    await expect(sub.getSong('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('HttpNaviloadConnector sends Bearer token and calls confirmed NaviLoad endpoints', async () => {
    const calls: Array<{ method: string; path: string; auth?: string; body?: unknown }> = [];
    const url = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        calls.push({
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          auth: req.headers.authorization,
          body: raw ? JSON.parse(raw) : undefined,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/healthz') {
          res.end(JSON.stringify({ status: 'ok', version: '1.2.0' }));
          return;
        }
        if (req.url?.startsWith('/api/search')) {
          res.end(
            JSON.stringify({
              results: [
                {
                  video_id: 'dQw4w9WgXcQ',
                  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                  title: 'Track One',
                  channel: 'Artist - Topic',
                  duration_seconds: 212,
                },
              ],
            }),
          );
          return;
        }
        if (req.url === '/api/status') {
          res.end(JSON.stringify({ tracks: [], queue_depth: 0 }));
          return;
        }
        if (req.url === '/api/library') {
          res.end(JSON.stringify([{ filename: 'Track One.m4a' }]));
          return;
        }
        res.end(JSON.stringify({ ok: true, queued: 1, items: [] }));
      });
    });

    const nl = new HttpNaviloadConnector({ url, token: 'naviload-fixture-token' });
    await nl.health();
    const searched = await nl.searchYoutube('Track One', 3);
    expect(searched).toHaveLength(1);
    await nl.inspectUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await nl.downloadTracks({
      urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
      quality: 'm4a',
    });
    await nl.getStatus();
    await nl.getLibrary();
    await nl.reviewTrack({ trackId: 'trk-1', policy: 'suggestion', suggestionIndex: 0 });
    await nl.confirmTrack('trk-1');
    await nl.cancelTrack('trk-1');
    await nl.retryTrack('trk-1');

    expect(calls.find((c) => c.path.startsWith('/api/search'))?.auth).toBe(
      'Bearer naviload-fixture-token',
    );
    expect(calls.some((c) => c.path === '/api/tracks/trk-1/confirm' && c.method === 'POST')).toBe(
      true,
    );
    expect(calls.some((c) => c.path === '/api/tracks/trk-1/review' && c.method === 'POST')).toBe(
      true,
    );
    expect(calls.some((c) => c.path === '/api/tracks/trk-1/cancel' && c.method === 'POST')).toBe(
      true,
    );
    expect(calls.some((c) => c.path === '/api/tracks/trk-1/retry' && c.method === 'POST')).toBe(
      true,
    );
  });

  it('HttpNaviloadConnector normalizes NaviLoad 2.3 {tracks, history} status and {items} library shapes', async () => {
    const url = await startMockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/status') {
        res.end(
          JSON.stringify({
            tracks: [
              {
                id: 't-active',
                title: 'Pending Song',
                status: 'review',
                candidates: [{ title: 'Clean Song', artist: 'Artist' }],
              },
            ],
            history: [
              {
                id: 't-saved',
                title: 'Saved Song',
                status: 'saved',
                saved_filename: 'Artist - Saved Song [abc123def45].m4a',
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/api/library') {
        res.end(JSON.stringify({ items: [{ id: 'abc123def45', title: 'Saved Song' }], offset: 0 }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });

    const nl = new HttpNaviloadConnector({ url, token: 'naviload-fixture-token' });
    const status = await nl.getStatus();
    expect(status.queue_depth).toBe(1);
    expect(status.tracks).toHaveLength(2);
    expect(status.tracks[0]?.suggestions).toEqual([{ title: 'Clean Song', artist: 'Artist' }]);
    expect(status.tracks[1]?.saved_filename).toBe('Artist - Saved Song [abc123def45].m4a');

    const lib = await nl.getLibrary();
    expect(lib).toEqual([{ id: 'abc123def45', title: 'Saved Song' }]);
  });
});
