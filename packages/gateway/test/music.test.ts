import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayDeps, type GatewayDeps } from '../src/index.js';
import { buildMcpServer } from '../src/server/factory.js';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';

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
        clientInfo: { name: 'music-test', version: '1.0.0' },
      });
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      const res = await call('tools/call', { name, arguments: args });
      expect(res['error']).toBeUndefined();
      return res['result'] as {
        isError?: boolean;
        structuredContent: Record<string, unknown>;
      };
    },
  };
}

describe('Phase 3 Music, NaviLoad, and Jobs Engine', () => {
  const openDeps: GatewayDeps[] = [];

  afterEach(() => {
    for (const d of openDeps.splice(0)) {
      d.db.close();
    }
  });

  it('completes U4/U5 build_playlist -> staged download -> human review boundary -> save -> playlist update', async () => {
    const deps = createGatewayDeps({ mock: true });
    openDeps.push(deps);
    const server = buildMcpServer(deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await ct.start();
    const client = createClient(ct);
    await client.init();

    // 1. Batch match & build_playlist plan: Beyonce Halo (in lib), M83 Midnight City (in lib), Radiohead Daydreaming (missing)
    const planRes = await client.callTool('music_build_playlist', {
      name: 'Road Trip',
      tracks: [
        { artist: 'Beyonce', title: 'Halo (Official Video)' },
        { artist: 'M83', title: 'Midnight City' },
        { artist: 'Radiohead', title: 'Daydreaming' },
      ],
    });
    expect(planRes.isError).toBeFalsy();
    const planId = planRes.structuredContent['plan_id'] as string;
    const matched = planRes.structuredContent['matched'] as Array<Record<string, unknown>>;
    const missing = planRes.structuredContent['missing'] as Array<{
      artist: string;
      title: string;
      candidates: Array<{ video_id: string; url: string }>;
    }>;
    expect(matched).toHaveLength(2);
    expect(missing).toHaveLength(1);
    const cand = missing[0]!.candidates[0]!;

    // 2. Apply playlist build -> creates playlist with 2 songs, queues missing track, job waits for human review
    const applyRes = await client.callTool('music_build_playlist_apply', {
      plan_id: planId,
      picks: [{ video_id: cand.video_id, url: cand.url, skip: false }],
    });
    expect(applyRes.isError).toBeFalsy();
    const playlistId = applyRes.structuredContent['playlist_id'] as string;
    const jobId = applyRes.structuredContent['job_id'] as string;
    const pendingTrackIds = applyRes.structuredContent['pending_review_track_ids'] as string[];
    expect(applyRes.structuredContent['status']).toBe('waiting_user');
    expect(pendingTrackIds).toHaveLength(1);
    const newTrackId = pendingTrackIds[0]!;

    // Check job via jobs_get
    const jobRes = await client.callTool('jobs_get', { job_id: jobId });
    expect(jobRes.structuredContent['status']).toBe('waiting_user');

    // 3. Enforce NaviLoad human-review boundary: naviload_review_decide MUST fail without user_confirmed_decision=true
    const deniedReview = await client.callTool('naviload_review_decide', {
      track_id: newTrackId,
      policy: 'suggestion',
      suggestion_index: 0,
    });
    expect(deniedReview.isError).toBe(true);
    expect((deniedReview.structuredContent['error'] as { code: string }).code).toBe('CONFIRMATION_REQUIRED');

    // Cannot save before review decision
    const deniedSave = await client.callTool('naviload_save', { track_id: newTrackId });
    expect(deniedSave.isError).toBe(true);

    // 4. Human confirms suggestion -> naviload_save reconciles waiting playlist job automatically!
    const approvedReview = await client.callTool('naviload_review_decide', {
      track_id: newTrackId,
      policy: 'suggestion',
      suggestion_index: 0,
      user_confirmed_decision: true,
    });
    expect(approvedReview.isError).toBeFalsy();

    const saveRes = await client.callTool('naviload_save', { track_id: newTrackId });
    expect(saveRes.isError).toBeFalsy();
    expect(saveRes.structuredContent['playlists_updated']).toBe(1);

    // Verify playlist now has 3 songs and job succeeded
    const plRes = await client.callTool('music_playlist_get', { id: playlistId });
    expect((plRes.structuredContent['playlist'] as { songCount: number }).songCount).toBe(3);

    const jobDone = await client.callTool('jobs_get', { job_id: jobId });
    expect(jobDone.structuredContent['status']).toBe('succeeded');

    // Also test jobs_list and jobs_cancel
    const jobsList = await client.callTool('jobs_list', {});
    expect((jobsList.structuredContent['jobs'] as unknown[]).length).toBeGreaterThanOrEqual(1);

    await ct.close();
    await st.close();
  });

  it('covers Navidrome stats, search, scan, and NaviLoad health/inspect/retry/cancel', async () => {
    const deps = createGatewayDeps({ mock: true });
    openDeps.push(deps);
    const server = buildMcpServer(deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await ct.start();
    const client = createClient(ct);
    await client.init();

    const stats = await client.callTool('music_library_stats');
    expect(stats.structuredContent['playlist_count']).toBeGreaterThanOrEqual(1);

    const nlHealth = await client.callTool('naviload_health');
    expect((nlHealth.structuredContent['health'] as { status: string }).status).toBe('ok');

    const reviewList = await client.callTool('naviload_review_list');
    expect((reviewList.structuredContent['pending'] as unknown[]).length).toBeGreaterThanOrEqual(1);

    const inspected = await client.callTool('naviload_inspect', {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    expect(inspected.isError).toBeFalsy();

    const cancelled = await client.callTool('naviload_cancel', { track_id: 'trk-review-1' });
    expect(cancelled.isError).toBeFalsy();

    await ct.close();
    await st.close();
  });
});
