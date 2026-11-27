import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import {
  createMockState,
  MockCloudflareConnector,
  MockDockerConnector,
  MockExecutor,
  MockHealthchecksConnector,
  MockNtfyConnector,
} from '@homemcp/mock';
import { Redactor } from '@homemcp/core';
import {
  createDefaultMockConfig,
  createGatewayDeps,
  buildMcpServer,
  type GatewayDeps,
} from '../src/server/factory.js';
import { HomemcpDb } from '../src/db/database.js';
import { AlertWatcher } from '../src/watcher/watcher.js';

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
        clientInfo: { name: 'p4-test', version: '1.0.0' },
      });
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      const res = await call('tools/call', { name, arguments: args });
      expect(res['error']).toBeUndefined();
      return res['result'] as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
        structuredContent: Record<string, unknown>;
      };
    },
  };
}

describe('Phase 4 Media, Downloads, Backup Actions, and AlertWatcher', () => {
  const openDbs: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const d of openDbs.splice(0)) {
      d.close();
    }
  });

  it('passes U6-run, backup_verify, backup_restore_test, U7 Jellyfin health/problems, and qBittorrent low-space guard', async () => {
    const deps: GatewayDeps = createGatewayDeps({ mock: true });
    openDbs.push(deps.db);
    const server = buildMcpServer(deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await ct.start();
    const client = createClient(ct);
    await client.init();

    // U6: backup_run, backup_verify, backup_restore_test
    const runRes = await client.callTool('backup_run', { set: 'vaultwarden' });
    expect(runRes.structuredContent['status']).toBe('succeeded');
    expect(runRes.structuredContent['exit_code']).toBe(0);

    const verifyRes = await client.callTool('backup_verify');
    expect(verifyRes.structuredContent['status']).toBe('succeeded');

    const rtRes = await client.callTool('backup_restore_test', { set: 'vaultwarden' });
    expect(rtRes.structuredContent['status']).toBe('succeeded');
    expect(String(rtRes.structuredContent['output'])).toContain('RESTORE_TEST=ok');

    // U7: Jellyfin health & problem finder & run task
    const jfHealth = await client.callTool('jellyfin_health');
    expect(jfHealth.structuredContent['healthy']).toBe(true);
    expect(jfHealth.structuredContent['active_transcodes']).toBe(1);

    const jfProblems = await client.callTool('jellyfin_find_problems', { limit: 50 });
    expect(jfProblems.content[0]?.text).toContain('[Fansub] Sample Anime S1');
    expect(jfProblems.content[0]?.text).toContain(
      '/mnt/storage/media/jellyfin/series/[Fansub] Sample Anime S1',
    );
    const unidentifiedList = jfProblems.structuredContent['unidentified'] as Array<
      Record<string, unknown>
    >;
    expect(unidentifiedList.some((u) => u['type'] === 'Movie')).toBe(true);
    expect(unidentifiedList.some((u) => u['type'] === 'Series')).toBe(true);
    expect(
      (jfProblems.structuredContent['naming_issues'] as unknown[]).length,
    ).toBeGreaterThanOrEqual(1);

    // Ensure registry redactor also scrubs secrets serialized into content[0].text
    const jfSearch = await client.callTool('jellyfin_search', { query: 'Sample' });
    expect(jfSearch.content[0]?.text).toContain('Sample Sci-Fi Movie');
    expect(jfSearch.content[0]?.text).not.toContain('mock-qbit-password');

    // Jellyfin item inspect, Identify search/apply, metadata edit, and refresh
    const seriesInspect = await client.callTool('jellyfin_item_inspect', { item_id: 'jf-s1' });
    expect(seriesInspect.structuredContent['total_children']).toBeGreaterThanOrEqual(1);
    expect(seriesInspect.structuredContent['untrusted_source']).toBe('jellyfin-metadata');

    const epSearchDenied = await client.callTool('jellyfin_identify_search', { item_id: 'jf-ep1' });
    expect(epSearchDenied.isError).toBe(true);
    expect((epSearchDenied.structuredContent['error'] as { code: string }).code).toBe(
      'INVALID_ARGUMENT',
    );

    const seriesIdentify = await client.callTool('jellyfin_identify_search', {
      item_id: 'jf-s1',
      name: 'Sample Anime',
      year: 2024,
    });
    expect(seriesIdentify.structuredContent['item_type']).toBe('Series');
    const jfCands = seriesIdentify.structuredContent['candidates'] as Array<
      Record<string, unknown>
    >;
    expect(jfCands.length).toBeGreaterThanOrEqual(1);
    const matchId = String(jfCands[0]?.['match_id']);

    const mismatchApply = await client.callTool('jellyfin_identify_apply', {
      item_id: 'jf-m2',
      match_id: matchId,
    });
    expect(mismatchApply.isError).toBe(true);
    expect((mismatchApply.structuredContent['error'] as { code: string }).code).toBe(
      'INVALID_ARGUMENT',
    );

    const seriesApply = await client.callTool('jellyfin_identify_apply', {
      item_id: 'jf-s1',
      match_id: matchId,
    });
    expect(seriesApply.structuredContent['applied']).toBe(true);

    const movieIdentify = await client.callTool('jellyfin_identify_search', {
      item_id: 'jf-m2',
      name: 'Sample Movie',
    });
    const movieMatchId = String(
      (movieIdentify.structuredContent['candidates'] as Array<Record<string, unknown>>)[0]?.[
        'match_id'
      ],
    );
    const movieApply = await client.callTool('jellyfin_identify_apply', {
      item_id: 'jf-m2',
      match_id: movieMatchId,
    });
    expect(movieApply.structuredContent['applied']).toBe(true);

    const metaUpdate = await client.callTool('jellyfin_item_update_metadata', {
      item_id: 'jf-s1',
      display_order: 'absolute',
      lock_data: true,
    });
    expect(metaUpdate.structuredContent['updated']).toBe(true);
    expect(metaUpdate.structuredContent['refresh_queued']).toBe(true);

    const epMetaUpdate = await client.callTool('jellyfin_item_update_metadata', {
      item_id: 'jf-ep1',
      parent_index_number: 1,
      index_number: 1,
      refresh_after: true,
    });
    expect(epMetaUpdate.structuredContent['updated']).toBe(true);

    const refreshRes = await client.callTool('jellyfin_refresh_item', {
      item_id: 'jf-s1',
      mode: 'full',
    });
    expect(refreshRes.structuredContent['queued']).toBe(true);

    const jfRunTask = await client.callTool('jellyfin_run_task', {
      task_id_or_name: 'Scan Media Library',
    });
    expect(jfRunTask.structuredContent['triggered']).toBe(true);

    // Media rename: seeding-safe qBittorrent file & folder rename + outside-save_path conflict guard
    const outsideMoveBlocked = await client.callTool('media_rename_plan', {
      moves: [
        {
          src: '/mnt/storage/media/jellyfin/series/[Fansub] Sample Anime S1/ep01.mkv',
          dst: '/mnt/storage/media/jellyfin/movies/ep01.mkv',
        },
      ],
    });
    expect(outsideMoveBlocked.isError).toBe(true);
    expect((outsideMoveBlocked.structuredContent['error'] as { code: string }).code).toBe(
      'CONFLICT',
    );

    const qbitFilePlan = await client.callTool('media_rename_plan', {
      moves: [
        {
          src: '/mnt/storage/media/jellyfin/series/[Fansub] Sample Anime S1/ep01.mkv',
          dst: '/mnt/storage/media/jellyfin/series/[Fansub] Sample Anime S1/Sample Anime - S01E01.mkv',
        },
      ],
    });
    expect(qbitFilePlan.structuredContent['qbit_preserved_count']).toBe(1);
    expect(qbitFilePlan.structuredContent['fs_move_count']).toBe(0);
    deps.confirmations.approveConfirmation(
      String(qbitFilePlan.structuredContent['confirmation_id']),
      {
        approvedBy: 'owner',
      },
    );
    const qbitFileApply = await client.callTool('media_rename_apply', {
      plan_id: String(qbitFilePlan.structuredContent['plan_id']),
    });
    expect(qbitFileApply.structuredContent['applied']).toBe(true);
    expect(qbitFileApply.structuredContent['qbit_renamed_count']).toBe(1);
    expect(qbitFileApply.structuredContent['jellyfin_scan_triggered']).toBe(true);

    const qbitFolderPlan = await client.callTool('media_rename_plan', {
      moves: [
        {
          src: '/mnt/storage/media/jellyfin/series/[Fansub] Sample Anime S1',
          dst: '/mnt/storage/media/jellyfin/series/Sample Anime (2024)',
        },
      ],
    });
    expect(qbitFolderPlan.structuredContent['qbit_preserved_count']).toBe(1);
    deps.confirmations.approveConfirmation(
      String(qbitFolderPlan.structuredContent['confirmation_id']),
      { approvedBy: 'owner' },
    );
    const qbitFolderApply = await client.callTool('media_rename_apply', {
      plan_id: String(qbitFolderPlan.structuredContent['plan_id']),
    });
    expect(qbitFolderApply.structuredContent['qbit_renamed_count']).toBe(1);
    const updatedSeriesFiles = await deps.qbittorrent!.getTorrentFiles(
      '11223344556677889900aabbccddeeff00112233',
    );
    expect(updatedSeriesFiles[0]?.name).toBe('Sample Anime (2024)/Sample Anime - S01E01.mkv');

    const fsPlan = await client.callTool('media_rename_plan', {
      moves: [
        {
          src: '/mnt/storage/media/jellyfin/movies/non_torrent_film.mkv',
          dst: '/mnt/storage/media/jellyfin/movies/Non Torrent Film (2024)/Non Torrent Film (2024).mkv',
        },
      ],
    });
    expect(fsPlan.structuredContent['qbit_preserved_count']).toBe(0);
    expect(fsPlan.structuredContent['fs_move_count']).toBe(1);

    // Downloads: valid add succeeds, huge min_free_bytes denied with CONFLICT
    const dlAddOk = await client.callTool('downloads_add', {
      url: 'magnet:?xt=urn:btih:abcdef0123456789',
      category: 'movies',
      min_free_bytes: 1_000_000,
    });
    expect(dlAddOk.structuredContent['added']).toBe(true);

    const dlDenied = await client.callTool('downloads_add', {
      url: 'magnet:?xt=urn:btih:abcdef0123456789',
      category: 'movies',
      min_free_bytes: 9_000_000_000_000, // 9 TB > mock 220 GB free
    });
    expect(dlDenied.isError).toBe(true);
    expect((dlDenied.structuredContent['error'] as { code: string }).code).toBe('CONFLICT');

    const dlStatus = await client.callTool('downloads_status', {
      query: 'Magnet',
      sort: 'recent',
      limit: 5,
    });
    expect(dlStatus.structuredContent['returned']).toBe(1);
    expect(
      ((dlStatus.structuredContent['torrents'] as Array<Record<string, unknown>>)[0] ?? {})['name'],
    ).toBe('Magnet Download');

    const dlInspect = await client.callTool('downloads_inspect', {
      hash_or_query: 'Magnet Download',
    });
    expect(dlInspect.structuredContent['matched']).toBe(true);
    expect(dlInspect.structuredContent['total_files']).toBe(1);
    expect(
      ((dlInspect.structuredContent['trackers'] as Array<Record<string, unknown>>)[0] ?? {})['url'],
    ).toBe('https://tracker.example.org/announce');

    // Jackett indexers, ranked search (sorted by seeders desc), and result_id handoff without leaking download_link/apikey
    const idxList = await client.callTool('downloads_indexers');
    expect((idxList.structuredContent['indexers'] as unknown[]).length).toBe(2);

    const searchRes = await client.callTool('downloads_search', {
      query: 'Big Buck Bunny',
      category: 'movies',
      wait_seconds: 10,
    });
    expect(searchRes.structuredContent['untrusted_source']).toBe('jackett-indexers');
    const hits = searchRes.structuredContent['results'] as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(2);
    expect(hits[0]?.['seeders']).toBe(185);
    expect(hits[0]?.['indexer_id']).toBe('indexer-slow');
    expect(JSON.stringify(searchRes)).not.toContain('jackett_apikey');
    expect(JSON.stringify(searchRes)).not.toContain('download_link');

    const slowId = String(hits[0]?.['result_id']);
    const fastId = String(hits[1]?.['result_id']);
    const addSlow = await client.callTool('downloads_add', {
      result_id: slowId,
      category: 'movies',
      min_free_bytes: 1_000_000,
    });
    expect(addSlow.structuredContent['added']).toBe(true);
    expect(addSlow.structuredContent['indexer']).toBe('Slow Indexer');

    const addFast = await client.callTool('downloads_add', {
      result_id: fastId,
      category: 'movies',
      min_free_bytes: 1_000_000,
    });
    expect(addFast.structuredContent['added']).toBe(true);

    await ct.close();
    await st.close();
  });

  it('U11: AlertWatcher transitions pending -> firing -> resolved, supports ack/snooze, and flushes offline ntfy queue with outage duration', async () => {
    const db = new HomemcpDb(':memory:');
    openDbs.push(db);
    const config = createDefaultMockConfig();
    const state = createMockState();
    const watcher = new AlertWatcher({
      db,
      config,
      redactor: new Redactor(),
      agent: new MockExecutor(state),
      docker: new MockDockerConnector(state),
      cloudflare: new MockCloudflareConnector(state),
      ntfy: new MockNtfyConnector(state),
      healthchecks: new MockHealthchecksConnector(state),
    });

    // Simulate power outage: battery offline AND ntfy unreachable
    state.acOnline = false;
    state.ntfyOnline = false;

    const t0 = Date.now();
    const ev1 = await watcher.evaluateOnce(t0);
    expect(ev1.pending).toBe(1); // power_on_battery has pending_seconds=60
    expect(state.ntfySent).toHaveLength(0);

    // 65 seconds later: transitions to firing -> queued because ntfy is still offline
    const ev2 = await watcher.evaluateOnce(t0 + 65_000);
    expect(ev2.firing).toBe(1);
    expect(state.ntfySent).toHaveLength(0);

    // Ack & snooze alert
    const open = watcher.listAlerts();
    expect(open).toHaveLength(1);
    watcher.ackAlert(open[0]!.id, 'owner');
    watcher.snoozeAlert(open[0]!.id, '1h');
    expect(watcher.listAlerts()[0]!.acked_by).toBe('owner');
    expect(watcher.listAlerts()[0]!.snoozed_until).toBeTruthy();

    // Connectivity + AC power restored!
    state.ntfyOnline = true;
    state.acOnline = true;
    const ev3 = await watcher.evaluateOnce(t0 + 130_000);
    expect(ev3.resolved_count).toBe(1);
    expect(ev3.flushed_notifications).toBeGreaterThanOrEqual(1);
    expect(state.ntfySent.some((m) => m.message.includes('outage duration'))).toBe(true);
    expect(state.ntfySent.some((m) => m.title.includes('[RESOLVED]'))).toBe(true);
    expect(state.healthchecksPings.length).toBe(3);
  });
});
