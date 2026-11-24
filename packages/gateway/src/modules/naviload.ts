import * as z from 'zod/v4';
import type { NaviloadConnector } from '@homemcp/connectors';
import { HomemcpError } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';
import { reconcileWaitingMusicJobs } from './music.js';

function requireNaviload(deps: GatewayDeps): NaviloadConnector {
  if (!deps.naviload) {
    throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'NaviLoad connector not configured');
  }
  return deps.naviload;
}

export function registerNaviloadModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'naviload_health',
    toolset: 'naviload',
    tier: 'T0',
    description:
      'Returns NaviLoad /healthz, queue depth, pending review count, and failed track count. Read-only.',
    annotations: {
      title: 'NaviLoad Health',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      health: z.record(z.string(), z.unknown()),
    }),
    handler: async () => {
      const nl = requireNaviload(deps);
      const health = await nl.health();
      const statusStr = typeof health['status'] === 'string' ? health['status'] : 'ok';
      const qDepth = typeof health['queue_depth'] === 'number' ? health['queue_depth'] : 0;
      return {
        summary: `NaviLoad status: ${statusStr}, queue: ${qDepth}`,
        structured: { health },
      };
    },
  });

  registry.registerTool({
    name: 'naviload_search_youtube',
    toolset: 'naviload',
    tier: 'T0',
    description:
      'Searches YouTube via NaviLoad for candidate tracks with duration, channel, and already-downloaded hints. Read-only.',
    annotations: {
      title: 'Search YouTube (NaviLoad)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).default(5),
      })
      .strict(),
    outputSchema: z.object({
      results: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const nl = requireNaviload(deps);
      const results = await nl.searchYoutube(args.query, args.limit);
      return {
        summary: `Found ${results.length} YouTube candidates for "${args.query}"`,
        structured: { results: results as unknown as Array<Record<string, unknown>> },
      };
    },
  });

  registry.registerTool({
    name: 'naviload_inspect',
    toolset: 'naviload',
    tier: 'T0',
    description: 'Inspects a YouTube URL or playlist via NaviLoad without downloading. Read-only.',
    annotations: {
      title: 'Inspect YouTube URL',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({ url: z.string().url() }).strict(),
    outputSchema: z.object({
      inspection: z.record(z.string(), z.unknown()),
    }),
    handler: async (args) => {
      const nl = requireNaviload(deps);
      const inspection = await nl.inspectUrl(args.url);
      return {
        summary: `Inspected ${args.url}`,
        structured: { inspection },
      };
    },
  });

  registry.registerTool({
    name: 'naviload_download',
    toolset: 'naviload',
    tier: 'T1',
    description: 'Queues YouTube URLs for download into NaviLoad staging.',
    annotations: {
      title: 'Queue NaviLoad Download',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        urls: z.array(z.string().url()).min(1).max(25),
        quality: z.string().optional(),
      })
      .strict(),
    outputSchema: z.object({
      queued: z.number().int(),
      job_id: z.string().optional(),
      items: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const nl = requireNaviload(deps);
      const res = await nl.downloadTracks({ urls: args.urls, quality: args.quality });
      return {
        summary: `Queued ${res.queued} URL(s) in NaviLoad`,
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'naviload_queue',
    toolset: 'naviload',
    tier: 'T0',
    description: 'Lists active, pending-review, failed, and saved tracks in NaviLoad. Read-only.',
    annotations: {
      title: 'NaviLoad Queue',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      tracks: z.array(z.record(z.string(), z.unknown())),
      queue_depth: z.number().int().optional(),
    }),
    handler: async () => {
      const nl = requireNaviload(deps);
      const res = await nl.getStatus();
      return {
        summary: `NaviLoad: ${res.tracks.length} tracks (${res.queue_depth ?? 0} active/pending)`,
        structured: {
          tracks: res.tracks as unknown as Array<Record<string, unknown>>,
          ...(res.queue_depth !== undefined ? { queue_depth: res.queue_depth } : {}),
        },
      };
    },
  });

  registry.registerTool({
    name: 'naviload_review_list',
    toolset: 'naviload',
    tier: 'T0',
    description:
      'Lists NaviLoad tracks awaiting human metadata review alongside AcoustID/MusicBrainz suggestions. Read-only.',
    annotations: {
      title: 'List Pending Metadata Reviews',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      pending: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const nl = requireNaviload(deps);
      const res = await nl.getStatus();
      const pending = res.tracks.filter(
        (t) => t.status === 'pending_review' || t.status === 'review',
      );
      return {
        summary: `${pending.length} track(s) pending metadata review`,
        structured: { pending: pending as unknown as Array<Record<string, unknown>> },
      };
    },
  });

  registry.registerTool({
    name: 'naviload_review_decide',
    toolset: 'naviload',
    tier: 'T1',
    description:
      'Applies an explicit human-selected metadata tag policy (keep_youtube, suggestion, or manual) to a staged NaviLoad track. Enforces human review: rejects calls without user_confirmed_decision=true or interactive elicitation.',
    annotations: {
      title: 'Decide Track Metadata Review',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        track_id: z.string().min(1),
        policy: z.enum(['keep_youtube', 'suggestion', 'manual']),
        suggestion_index: z.number().int().min(0).optional(),
        manual_tags: z
          .object({
            title: z.string().optional(),
            artist: z.string().optional(),
            album: z.string().optional(),
          })
          .optional(),
        artwork_policy: z.enum(['db_then_youtube', 'youtube']).optional(),
        user_confirmed_decision: z.boolean().default(false),
      })
      .strict(),
    outputSchema: z.object({
      ok: z.boolean(),
      track_id: z.string(),
      policy: z.string(),
      result: z.record(z.string(), z.unknown()),
    }),
    handler: async (args, ctx) => {
      const nl = requireNaviload(deps);
      let confirmedByUser = args.user_confirmed_decision;

      if (!confirmedByUser) {
        // Check if MCP client supports 2025 interactive elicitation
        try {
          const maybeElicit = (
            ctx.mcpCtx.mcpReq as unknown as {
              elicitInput?: (
                p: unknown,
              ) => Promise<{ action: string; content?: Record<string, unknown> }>;
            }
          ).elicitInput;
          if (typeof maybeElicit === 'function') {
            const elicitRes = await maybeElicit({
              mode: 'form',
              message: `Confirm metadata policy "${args.policy}" for NaviLoad track ${args.track_id}?`,
              requestedSchema: {
                type: 'object',
                properties: {
                  approve: { type: 'boolean', title: 'Approve metadata decision' },
                },
                required: ['approve'],
              },
            });
            confirmedByUser =
              elicitRes.action === 'accept' && elicitRes.content?.['approve'] === true;
          }
        } catch {
          confirmedByUser = false;
        }
      }

      if (!confirmedByUser) {
        throw new HomemcpError(
          'CONFIRMATION_REQUIRED',
          'Human review decision required: inspect naviload_review_list, confirm the tag policy with the user, and pass user_confirmed_decision: true.',
        );
      }

      if (args.policy === 'suggestion' && args.suggestion_index === undefined) {
        throw new HomemcpError(
          'INVALID_ARGUMENT',
          'suggestion_index is required when policy is "suggestion"',
        );
      }

      const result = await nl.reviewTrack({
        trackId: args.track_id,
        policy: args.policy,
        suggestionIndex: args.suggestion_index,
        manualTags: args.manual_tags,
        artworkPolicy: args.artwork_policy,
      });

      return {
        summary: `Applied metadata policy "${args.policy}" to track ${args.track_id}; call naviload_save to publish`,
        structured: {
          ok: true,
          track_id: args.track_id,
          policy: args.policy,
          result,
        },
      };
    },
  });

  registry.registerTool({
    name: 'naviload_save',
    toolset: 'naviload',
    tier: 'T1',
    description:
      'Publishes a reviewed NaviLoad track into the Navidrome music library and reconciles any waiting playlist build jobs.',
    annotations: {
      title: 'Save Reviewed Track',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({ track_id: z.string().min(1) }).strict(),
    outputSchema: z.object({
      ok: z.boolean(),
      track_id: z.string(),
      playlists_updated: z.number().int(),
      result: z.record(z.string(), z.unknown()),
    }),
    handler: async (args) => {
      const nl = requireNaviload(deps);
      const statusBefore = await nl.getStatus();
      const target = statusBefore.tracks.find((t) => t.id === args.track_id);
      if (target && (target.status === 'pending_review' || target.status === 'review')) {
        throw new HomemcpError(
          'CONFLICT',
          `Track ${args.track_id} is still pending_review; run naviload_review_decide first`,
        );
      }
      const result = await nl.confirmTrack(args.track_id);
      const playlistsUpdated = await reconcileWaitingMusicJobs(deps);
      return {
        summary: `Saved track ${args.track_id} to music library (${playlistsUpdated} waiting playlist job(s) updated)`,
        structured: {
          ok: true,
          track_id: args.track_id,
          playlists_updated: playlistsUpdated,
          result,
        },
      };
    },
  });

  registry.registerTool({
    name: 'naviload_cancel',
    toolset: 'naviload',
    tier: 'T1',
    description: 'Cancels a queued or staged NaviLoad track.',
    annotations: {
      title: 'Cancel NaviLoad Track',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ track_id: z.string().min(1) }).strict(),
    outputSchema: z.object({
      ok: z.boolean(),
      track_id: z.string(),
      result: z.record(z.string(), z.unknown()),
    }),
    handler: async (args) => {
      const nl = requireNaviload(deps);
      const result = await nl.cancelTrack(args.track_id);
      return {
        summary: `Cancelled NaviLoad track ${args.track_id}`,
        structured: { ok: true, track_id: args.track_id, result },
      };
    },
  });

  registry.registerTool({
    name: 'naviload_retry',
    toolset: 'naviload',
    tier: 'T1',
    description: 'Retries a failed NaviLoad track download.',
    annotations: {
      title: 'Retry NaviLoad Track',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({ track_id: z.string().min(1) }).strict(),
    outputSchema: z.object({
      ok: z.boolean(),
      track_id: z.string(),
      result: z.record(z.string(), z.unknown()),
    }),
    handler: async (args) => {
      const nl = requireNaviload(deps);
      const result = await nl.retryTrack(args.track_id);
      return {
        summary: `Retried NaviLoad track ${args.track_id}`,
        structured: { ok: true, track_id: args.track_id, result },
      };
    },
  });
}
