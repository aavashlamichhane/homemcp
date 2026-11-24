import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import {
  extractYoutubeIdFromPath,
  matchRequestedTracks,
  type NaviloadSearchCandidate,
  type SubsonicConnector,
} from '@homemcp/connectors';
import { HomemcpError } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

function requireSubsonic(deps: GatewayDeps): SubsonicConnector {
  if (!deps.subsonic) {
    throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Navidrome Subsonic connector not configured');
  }
  return deps.subsonic;
}

function scoreYoutubeCandidate(c: NaviloadSearchCandidate): number {
  let score = 0.5;
  if (c.is_topic_channel || /-\s*topic$/i.test(c.channel)) score += 0.3;
  if (c.duration_seconds >= 90 && c.duration_seconds <= 600) score += 0.15;
  if (/live|cover|remix|karaoke|slowed|reverb/i.test(c.title)) score -= 0.2;
  if (c.already_in_library) score += 0.05;
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

interface StoredBuildPlaylistPlan {
  name: string;
  comment?: string | undefined;
  public?: boolean | undefined;
  matched_song_ids: string[];
  candidates_by_request: Array<{
    artist: string;
    title: string;
    candidates: Array<NaviloadSearchCandidate & { score: number }>;
  }>;
}

export async function reconcileWaitingMusicJobs(deps: GatewayDeps): Promise<number> {
  if (!deps.subsonic || !deps.naviload) return 0;
  const waitingJobs = deps.jobs.listJobs({
    status: 'waiting_user',
    kind: 'music_build_playlist',
    limit: 20,
  });
  if (waitingJobs.length === 0) return 0;

  let updatedPlaylists = 0;
  const nlStatus = await deps.naviload.getStatus();

  for (const job of waitingJobs) {
    const items = deps.db.listMusicJobItems(job.id);
    if (items.length === 0) continue;

    let anySavedNewly = false;
    let pendingCount = 0;
    const savedVideoIds: string[] = [];

    for (const item of items) {
      if (item.state === 'playlist_added') continue;
      const trk = nlStatus.tracks.find(
        (t) =>
          (item.naviload_track_id && t.id === item.naviload_track_id) ||
          t.video_id === item.video_id,
      );
      if (!trk) {
        pendingCount++;
        continue;
      }
      if (trk.status === 'saved') {
        deps.db.updateMusicJobItem(item.id, { state: 'saved', naviloadTrackId: trk.id });
        savedVideoIds.push(item.video_id);
        anySavedNewly = true;
      } else if (trk.status !== 'cancelled' && trk.status !== 'failed') {
        pendingCount++;
      }
    }

    if (anySavedNewly) {
      await deps.subsonic.startScan(false);
      const searchRes = await deps.subsonic.search3('', {
        songCount: 500,
        albumCount: 0,
        artistCount: 0,
      });
      const songIdsToAdd: string[] = [];
      let playlistId: string | undefined;

      for (const item of deps.db.listMusicJobItems(job.id)) {
        playlistId = playlistId ?? item.playlist_id ?? undefined;
        if (!savedVideoIds.includes(item.video_id) && item.state !== 'saved') continue;
        const foundSong = searchRes.songs.find(
          (s) => extractYoutubeIdFromPath(s.path) === item.video_id,
        );
        if (foundSong) {
          songIdsToAdd.push(foundSong.id);
          deps.db.updateMusicJobItem(item.id, { state: 'playlist_added', songId: foundSong.id });
        }
      }

      if (playlistId && songIdsToAdd.length > 0) {
        await deps.subsonic.updatePlaylist({ playlistId, songIdToAdd: songIdsToAdd });
        updatedPlaylists++;
      }
    }

    if (pendingCount === 0) {
      deps.jobs.updateJob(job.id, {
        status: 'succeeded',
        progress: 100,
        finishedAt: new Date().toISOString(),
        appendStep: 'All downloaded tracks scanned and added to playlist',
      });
    }
  }
  return updatedPlaylists;
}

export function registerMusicModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'music_search',
    toolset: 'music',
    tier: 'T0',
    description:
      'Searches Navidrome artists, albums, and songs via Subsonic search3. Read-only. Example: music_search({ query: "Midnight City" }).',
    annotations: {
      title: 'Search Music Library',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        query: z.string(),
        song_count: z.number().int().min(1).max(100).default(20),
        album_count: z.number().int().min(0).max(50).default(10),
        artist_count: z.number().int().min(0).max(50).default(10),
      })
      .strict(),
    outputSchema: z.object({
      songs: z.array(z.record(z.string(), z.unknown())),
      albums: z.array(z.record(z.string(), z.unknown())),
      artists: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const sub = requireSubsonic(deps);
      const res = await sub.search3(args.query, {
        songCount: args.song_count,
        albumCount: args.album_count,
        artistCount: args.artist_count,
      });
      return {
        summary: `Found ${res.songs.length} songs, ${res.albums.length} albums, ${res.artists.length} artists`,
        structured: {
          songs: res.songs as unknown as Array<Record<string, unknown>>,
          albums: res.albums,
          artists: res.artists,
        },
      };
    },
  });

  registry.registerTool({
    name: 'music_find_tracks',
    toolset: 'music',
    tier: 'T0',
    description:
      'Batch-matches requested tracks [{artist, title, video_id?}] against Navidrome using Unicode NFKD, feat./video suffix stripping, YouTube ID matching, and artist/title swap tolerance. Read-only.',
    annotations: {
      title: 'Batch Match Tracks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        tracks: z
          .array(
            z.object({
              artist: z.string(),
              title: z.string(),
              video_id: z.string().optional(),
            }),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    outputSchema: z.object({
      matched_count: z.number().int(),
      missing_count: z.number().int(),
      results: z.array(
        z.object({
          requested: z.object({
            artist: z.string(),
            title: z.string(),
            video_id: z.string().optional(),
          }),
          matched: z.boolean(),
          confidence: z.number(),
          match_reason: z.string().optional(),
          track: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    }),
    handler: async (args) => {
      const sub = requireSubsonic(deps);
      const allSongs = await sub.search3('', { songCount: 1000, albumCount: 0, artistCount: 0 });
      const results = matchRequestedTracks(args.tracks, allSongs.songs);
      const matchedCount = results.filter((r) => r.matched).length;
      return {
        summary: `Matched ${matchedCount}/${results.length} tracks in library`,
        structured: {
          matched_count: matchedCount,
          missing_count: results.length - matchedCount,
          results: results.map((r) => ({
            requested: r.requested,
            matched: r.matched,
            confidence: r.confidence,
            ...(r.match_reason ? { match_reason: r.match_reason } : {}),
            ...(r.track ? { track: r.track as unknown as Record<string, unknown> } : {}),
          })),
        },
      };
    },
  });

  registry.registerTool({
    name: 'music_library_stats',
    toolset: 'music',
    tier: 'T0',
    description: 'Returns Navidrome artist/playlist counts and library scan status. Read-only.',
    annotations: {
      title: 'Music Library Stats',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      artist_count: z.number().int(),
      playlist_count: z.number().int(),
      scan_status: z.record(z.string(), z.unknown()),
    }),
    handler: async () => {
      const sub = requireSubsonic(deps);
      const [artists, playlists, scanStatus] = await Promise.all([
        sub.getArtists(),
        sub.getPlaylists(),
        sub.getScanStatus(),
      ]);
      return {
        summary: `Navidrome: ${artists.length} artists, ${playlists.length} playlists (tracks indexed: ${scanStatus.count ?? 'unknown'})`,
        structured: {
          artist_count: artists.length,
          playlist_count: playlists.length,
          scan_status: scanStatus as unknown as Record<string, unknown>,
        },
      };
    },
  });

  registry.registerTool({
    name: 'music_recently_added',
    toolset: 'music',
    tier: 'T0',
    description: 'Lists recently added or frequent albums in Navidrome. Read-only.',
    annotations: {
      title: 'Recently Added Music',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        type: z.enum(['newest', 'recent', 'frequent']).default('newest'),
        size: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
    outputSchema: z.object({
      albums: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const sub = requireSubsonic(deps);
      const albums = await sub.getAlbumList2(args.type, args.size);
      return {
        summary: `Returned ${albums.length} ${args.type} albums`,
        structured: { albums },
      };
    },
  });

  registry.registerTool({
    name: 'music_now_playing',
    toolset: 'music',
    tier: 'T0',
    description: 'Shows active music playback sessions in Navidrome. Read-only.',
    annotations: {
      title: 'Now Playing (Navidrome)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      entries: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const sub = requireSubsonic(deps);
      const entries = await sub.getNowPlaying();
      return {
        summary: `${entries.length} active playback entries`,
        structured: { entries },
      };
    },
  });

  registry.registerTool({
    name: 'music_playlists_list',
    toolset: 'music',
    tier: 'T0',
    description: 'Lists playlists in Navidrome with track counts and durations. Read-only.',
    annotations: {
      title: 'List Music Playlists',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      playlists: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const sub = requireSubsonic(deps);
      const playlists = await sub.getPlaylists();
      return {
        summary: `${playlists.length} playlists in Navidrome`,
        structured: { playlists: playlists as unknown as Array<Record<string, unknown>> },
      };
    },
  });

  registry.registerTool({
    name: 'music_playlist_get',
    toolset: 'music',
    tier: 'T0',
    description: 'Fetches a single Navidrome playlist and all its track entries. Read-only.',
    annotations: {
      title: 'Get Music Playlist',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ id: z.string().min(1) }).strict(),
    outputSchema: z.object({
      playlist: z.record(z.string(), z.unknown()),
    }),
    handler: async (args) => {
      const sub = requireSubsonic(deps);
      const playlist = await sub.getPlaylist(args.id);
      return {
        summary: `Playlist "${playlist.name}": ${playlist.songCount} songs`,
        structured: { playlist: playlist as unknown as Record<string, unknown> },
      };
    },
  });

  registry.registerTool({
    name: 'music_playlist_create',
    toolset: 'music',
    tier: 'T1',
    description: 'Creates a new Navidrome playlist with optional initial song IDs.',
    annotations: {
      title: 'Create Music Playlist',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        name: z.string().min(1).max(120),
        song_ids: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    outputSchema: z.object({
      playlist: z.record(z.string(), z.unknown()),
    }),
    handler: async (args) => {
      const sub = requireSubsonic(deps);
      const playlist = await sub.createPlaylist(args.name, args.song_ids);
      return {
        summary: `Created playlist "${playlist.name}" (${playlist.id}) with ${playlist.songCount} songs`,
        structured: { playlist: playlist as unknown as Record<string, unknown> },
      };
    },
  });

  registry.registerTool({
    name: 'music_playlist_update',
    toolset: 'music',
    tier: 'T1',
    description: 'Updates a Navidrome playlist (rename, comment, visibility, add/remove songs).',
    annotations: {
      title: 'Update Music Playlist',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        playlist_id: z.string().min(1),
        name: z.string().min(1).optional(),
        comment: z.string().optional(),
        public: z.boolean().optional(),
        song_ids_to_add: z.array(z.string().min(1)).optional(),
        song_indexes_to_remove: z.array(z.number().int().min(0)).optional(),
      })
      .strict(),
    outputSchema: z.object({
      updated: z.boolean(),
      playlist_id: z.string(),
    }),
    handler: async (args) => {
      const sub = requireSubsonic(deps);
      await sub.updatePlaylist({
        playlistId: args.playlist_id,
        name: args.name,
        comment: args.comment,
        public: args.public,
        songIdToAdd: args.song_ids_to_add,
        songIndexToRemove: args.song_indexes_to_remove,
      });
      return {
        summary: `Updated playlist ${args.playlist_id}`,
        structured: { updated: true, playlist_id: args.playlist_id },
      };
    },
  });

  registry.registerTool({
    name: 'music_scan',
    toolset: 'music',
    tier: 'T1',
    description: 'Triggers a Navidrome library scan and returns current scan status.',
    annotations: {
      title: 'Scan Music Library',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ full_scan: z.boolean().default(false) }).strict(),
    outputSchema: z.object({
      scan_status: z.record(z.string(), z.unknown()),
    }),
    handler: async (args) => {
      const sub = requireSubsonic(deps);
      const status = await sub.startScan(args.full_scan);
      return {
        summary: `Navidrome scan ${status.scanning ? 'running' : 'completed'} (${status.count ?? 0} tracks)`,
        structured: { scan_status: status as unknown as Record<string, unknown> },
      };
    },
  });

  registry.registerTool({
    name: 'music_build_playlist',
    toolset: 'music',
    tier: 'T0',
    description:
      'Plans a playlist from requested songs: matches tracks already in Navidrome, searches NaviLoad for YouTube candidates for missing tracks, scores official/Topic channels, and returns a plan_id to pass to music_build_playlist_apply.',
    annotations: {
      title: 'Build Playlist Plan',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        name: z.string().min(1).max(120),
        comment: z.string().optional(),
        public: z.boolean().optional(),
        tracks: z
          .array(
            z.object({
              artist: z.string().min(1),
              title: z.string().min(1),
              video_id: z.string().optional(),
            }),
          )
          .min(1)
          .max(50),
      })
      .strict(),
    outputSchema: z.object({
      plan_id: z.string(),
      playlist_name: z.string(),
      matched: z.array(
        z.object({
          artist: z.string(),
          title: z.string(),
          song_id: z.string(),
          confidence: z.number(),
        }),
      ),
      missing: z.array(
        z.object({
          artist: z.string(),
          title: z.string(),
          candidates: z.array(
            z.object({
              video_id: z.string(),
              url: z.string(),
              title: z.string(),
              channel: z.string(),
              duration_seconds: z.number(),
              score: z.number(),
            }),
          ),
        }),
      ),
    }),
    handler: async (args, ctx) => {
      const sub = requireSubsonic(deps);
      const nl = deps.naviload;
      const library = await sub.search3('', { songCount: 1000, albumCount: 0, artistCount: 0 });
      const matches = matchRequestedTracks(args.tracks, library.songs);

      const matched = matches
        .filter(
          (m): m is typeof m & { track: NonNullable<typeof m.track> } =>
            m.matched && Boolean(m.track),
        )
        .map((m) => ({
          artist: m.track.artist,
          title: m.track.title,
          song_id: m.track.id,
          confidence: m.confidence,
        }));

      const missingReqs = matches.filter((m) => !m.matched).map((m) => m.requested);
      const missing = await Promise.all(
        missingReqs.map(async (req) => {
          const rawCands = nl ? await nl.searchYoutube(`${req.artist} ${req.title}`, 3) : [];
          const scored = rawCands
            .map((c) => ({ ...c, score: scoreYoutubeCandidate(c) }))
            .sort((a, b) => b.score - a.score);
          return {
            artist: req.artist,
            title: req.title,
            candidates: scored,
          };
        }),
      );

      const planPayload: StoredBuildPlaylistPlan = {
        name: args.name,
        comment: args.comment,
        public: args.public,
        matched_song_ids: matched.map((m) => m.song_id),
        candidates_by_request: missing,
      };
      const payloadJson = JSON.stringify(planPayload);
      const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
      const planId = `plplan_${randomUUID().slice(0, 12)}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();

      deps.db.db
        .prepare(
          `INSERT INTO plans (id, tool, payload_json, payload_hash, summary, diff, side_effects_json, rollback_json, tier, created_by, created_at, expires_at, status)
           VALUES (?, 'music_build_playlist', ?, ?, ?, '', '[]', '[]', 'T1', ?, ?, ?, 'draft')`,
        )
        .run(
          planId,
          payloadJson,
          payloadHash,
          `Playlist "${args.name}": ${matched.length} matched, ${missing.length} missing`,
          ctx.auth.subject,
          now.toISOString(),
          expiresAt,
        );

      return {
        summary: `Playlist "${args.name}" plan ${planId}: ${matched.length} in library, ${missing.length} missing`,
        structured: {
          plan_id: planId,
          playlist_name: args.name,
          matched,
          missing: missing.map((m) => ({
            artist: m.artist,
            title: m.title,
            candidates: m.candidates.map((c) => ({
              video_id: c.video_id,
              url: c.url,
              title: c.title,
              channel: c.channel,
              duration_seconds: c.duration_seconds,
              score: c.score,
            })),
          })),
        },
        planId,
      };
    },
  });

  registry.registerTool({
    name: 'music_build_playlist_apply',
    toolset: 'music',
    tier: 'T1',
    description:
      'Executes a playlist build plan: creates the Navidrome playlist immediately with matched tracks, queues selected YouTube downloads via NaviLoad as a tracked background job, and pauses at waiting_user if any downloaded tracks await human tag review.',
    annotations: {
      title: 'Apply Build Playlist Plan',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        picks: z
          .array(
            z.object({
              url: z.string().url(),
              video_id: z.string().min(1),
              skip: z.boolean().default(false),
            }),
          )
          .default([]),
        quality: z.string().optional(),
      })
      .strict(),
    outputSchema: z.object({
      playlist_id: z.string(),
      playlist_name: z.string(),
      initial_song_count: z.number().int(),
      queued_downloads: z.number().int(),
      job_id: z.string().optional(),
      status: z.string(),
      pending_review_track_ids: z.array(z.string()),
    }),
    handler: async (args, ctx) => {
      const sub = requireSubsonic(deps);
      const row = deps.db.db.prepare('SELECT * FROM plans WHERE id = ?').get(args.plan_id) as
        { payload_json: string; status: string; expires_at: string } | undefined;
      if (!row) {
        throw new HomemcpError('NOT_FOUND', `Playlist plan not found: ${args.plan_id}`);
      }
      if (row.status !== 'draft') {
        throw new HomemcpError('CONFLICT', `Plan ${args.plan_id} already ${row.status}`);
      }
      if (Date.parse(row.expires_at) < Date.now()) {
        throw new HomemcpError('CONFLICT', `Plan ${args.plan_id} has expired`);
      }

      const plan = JSON.parse(row.payload_json) as StoredBuildPlaylistPlan;
      deps.db.db.prepare("UPDATE plans SET status = 'applied' WHERE id = ?").run(args.plan_id);

      const playlist = await sub.createPlaylist(plan.name, plan.matched_song_ids);
      const selected = args.picks.filter((p) => !p.skip);

      if (selected.length === 0) {
        return {
          summary: `Created playlist "${playlist.name}" (${playlist.id}) with ${playlist.songCount} tracks; 0 downloads queued`,
          structured: {
            playlist_id: playlist.id,
            playlist_name: playlist.name,
            initial_song_count: playlist.songCount,
            queued_downloads: 0,
            status: 'completed',
            pending_review_track_ids: [],
          },
          planId: args.plan_id,
        };
      }

      if (!deps.naviload) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'NaviLoad connector not configured');
      }

      const dlRes = await deps.naviload.downloadTracks({
        urls: selected.map((s) => s.url),
        quality: args.quality,
      });

      const pendingTrackIds: string[] = [];
      const job = deps.jobs.startBackground(
        'music_build_playlist',
        ctx.auth.subject,
        async (jctx) => {
          await jctx.addStep(
            `Created playlist "${playlist.name}" (${playlist.id}) with ${playlist.songCount} existing tracks`,
            25,
          );

          for (let i = 0; i < selected.length; i++) {
            const sel = selected[i]!;
            const itemRec = dlRes.items[i];
            const trackId = typeof itemRec?.['id'] === 'string' ? itemRec['id'] : undefined;
            const trackState =
              typeof itemRec?.['status'] === 'string' ? itemRec['status'] : 'queued';
            if (trackId && trackState === 'pending_review') {
              pendingTrackIds.push(trackId);
            }
            deps.db.insertMusicJobItem({
              jobId: jctx.jobId,
              playlistId: playlist.id,
              playlistName: playlist.name,
              videoId: sel.video_id,
              naviloadTrackId: trackId,
              state: trackState,
            });
          }

          const nlStatus = await deps.naviload!.getStatus();
          const needsReview = nlStatus.tracks.filter(
            (t) => selected.some((s) => s.video_id === t.video_id) && t.status === 'pending_review',
          );
          if (needsReview.length > 0) {
            await jctx.setProgress(
              60,
              `Waiting for human metadata review on ${needsReview.length} tracks via naviload_review_list`,
            );
            jctx.markWaitingUser(
              `Downloads staged in NaviLoad awaiting human review: ${needsReview.map((t) => t.id).join(', ')}`,
              {
                playlist_id: playlist.id,
                pending_review_track_ids: needsReview.map((t) => t.id),
              },
            );
            return;
          }

          await sub.startScan(false);
          await jctx.setProgress(100, 'Navidrome scan triggered');
          return { playlist_id: playlist.id };
        },
      );

      await deps.jobs.waitForJob(job.id);
      const latestJob = deps.jobs.getJob(job.id)!;

      return {
        summary: `Created "${playlist.name}" (${playlist.songCount} tracks) and queued ${selected.length} downloads (job ${job.id}: ${latestJob.status})`,
        structured: {
          playlist_id: playlist.id,
          playlist_name: playlist.name,
          initial_song_count: playlist.songCount,
          queued_downloads: selected.length,
          job_id: job.id,
          status: latestJob.status,
          pending_review_track_ids: pendingTrackIds,
        },
        planId: args.plan_id,
        jobId: job.id,
      };
    },
  });

  registry.registerTool({
    name: 'music_playlist_delete',
    toolset: 'music',
    tier: 'T2',
    description: 'Deletes a Navidrome playlist (plan-first + confirmation required).',
    annotations: {
      title: 'Delete Music Playlist',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({ playlist_id: z.string().min(1), plan_id: z.string().optional() })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const sub = requireSubsonic(deps);
      if (!args.plan_id) {
        const pl = await sub.getPlaylist(args.playlist_id);
        const plan = deps.plans.createPlan({
          tool: 'music_playlist_delete',
          tier: 'T2',
          payload: { playlist_id: pl.id, name: pl.name },
          summary: `Delete Navidrome playlist "${pl.name}" (${pl.songCount} songs)`,
          diff: `- playlist "${pl.name}" (${pl.id})`,
          sideEffects: ['Playlist definition deleted from Navidrome (audio files untouched)'],
          rollback: ['Recreate playlist with music_playlist_create'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Plan ${plan.id} created for deleting playlist "${pl.name}"`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: plan.id,
            confirmation_id: chal.id,
            confirm_url: `${publicUrl}/confirm/${chal.id}`,
          },
          planId: plan.id,
          confirmationId: chal.id,
        };
      }
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'music_playlist_delete',
        tier: 'T2',
        auth: ctx.auth,
        mcpCtx: ctx.mcpCtx,
        publicUrl: deps.config.server.publicUrl,
      });
      if (!gate.approved) {
        return {
          summary: `Confirmation required at ${gate.confirmUrl}`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: gate.plan.id,
            confirmation_id: gate.confirmationId,
            confirm_url: gate.confirmUrl,
          },
          planId: gate.plan.id,
          confirmationId: gate.confirmationId,
        };
      }
      const p = gate.plan.payload as { playlist_id: string };
      await sub.deletePlaylist(p.playlist_id);
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Deleted playlist ${p.playlist_id}`,
        structured: { applied: true, status: 'applied', deleted_playlist_id: p.playlist_id },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'music_smart_playlist_create',
    toolset: 'music',
    tier: 'T1',
    description:
      'Creates a Navidrome Smart Playlist (.nsp) JSON rule file in the stacks/navidrome directory and triggers a library scan.',
    annotations: {
      title: 'Create Smart Playlist (.nsp)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        filename: z.string().regex(/^[A-Za-z0-9_-]+\.nsp$/),
        name: z.string().min(1),
        comment: z.string().optional(),
        all: z.array(z.record(z.string(), z.unknown())).optional(),
        any: z.array(z.record(z.string(), z.unknown())).optional(),
        sort: z.string().default('lastPlayed'),
        order: z.enum(['asc', 'desc']).default('desc'),
        limit: z.number().int().min(1).max(500).default(50),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args) => {
      if (!args.all && !args.any) {
        throw new HomemcpError(
          'INVALID_ARGUMENT',
          'Smart playlist requires at least "all" or "any" rule array',
        );
      }
      const nspDoc = {
        name: args.name,
        ...(args.comment ? { comment: args.comment } : {}),
        ...(args.all ? { all: args.all } : {}),
        ...(args.any ? { any: args.any } : {}),
        sort: args.sort,
        order: args.order,
        limit: args.limit,
      };
      const targetPath = `${deps.config.policy.roots.stacks}/navidrome/${args.filename}`;
      await deps.agent.call('files.write', {
        path: targetPath,
        content: `${JSON.stringify(nspDoc, null, 2)}\n`,
      });
      if (deps.subsonic) {
        await deps.subsonic.startScan(false);
      }
      return {
        summary: `Created smart playlist ${args.filename} at ${targetPath}`,
        structured: { created: true, path: targetPath, name: args.name },
      };
    },
  });
}
