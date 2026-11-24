import * as z from 'zod/v4';
import type { QbitTorrent, QbittorrentConnector } from '@homemcp/connectors';
import { HomemcpError } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

function requireQbit(deps: GatewayDeps): QbittorrentConnector {
  if (!deps.qbittorrent) {
    throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'qBittorrent connector not configured');
  }
  return deps.qbittorrent;
}

function projectTorrent(t: QbitTorrent) {
  return {
    hash: t.hash,
    name: t.name,
    state: t.state,
    progress_pct: Math.round(t.progress * 1000) / 10,
    size_bytes: t.size,
    amount_left_bytes: t.amount_left ?? Math.max(0, Math.round(t.size * (1 - t.progress))),
    dlspeed_bps: t.dlspeed,
    upspeed_bps: t.upspeed,
    eta_seconds: t.eta,
    ratio: Math.round(t.ratio * 100) / 100,
    category: t.category,
    save_path: t.save_path,
    added_at: t.added_on && t.added_on > 0 ? new Date(t.added_on * 1000).toISOString() : null,
    completed_at:
      t.completion_on && t.completion_on > 0
        ? new Date(t.completion_on * 1000).toISOString()
        : null,
  };
}

function sanitizeTrackerUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('**')) return trimmed;
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return trimmed.split('?')[0] ?? trimmed;
  }
}

function formatTorrentLine(p: ReturnType<typeof projectTorrent>): string {
  const sizeMb = (p.size_bytes / (1024 * 1024)).toFixed(1);
  return `- ${p.name} [${p.state}, ${p.progress_pct}%, ${sizeMb} MB, cat=${p.category || 'none'}, hash=${p.hash.slice(0, 8)}]`;
}

export function registerDownloadsModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'downloads_status',
    toolset: 'downloads',
    tier: 'T0',
    description:
      'Searches, filters, sorts, and lists qBittorrent torrents along with transfer speeds and configured categories. Read-only.',
    annotations: {
      title: 'Downloads Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        filter: z
          .enum(['all', 'downloading', 'seeding', 'completed', 'paused', 'active', 'stalled'])
          .default('all'),
        query: z.string().min(1).optional(),
        category: z.string().min(1).optional(),
        sort: z.enum(['recent', 'completed', 'name', 'progress', 'size']).default('recent'),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
    outputSchema: z.object({
      transfer: z.record(z.string(), z.unknown()),
      total_matched: z.number().int(),
      returned: z.number().int(),
      torrents: z.array(z.record(z.string(), z.unknown())),
      categories: z.record(z.string(), z.string()),
    }),
    handler: async (args) => {
      const qb = requireQbit(deps);
      const [transfer, rawTorrents] = await Promise.all([
        qb.getTransferInfo(),
        qb.listTorrents(args.filter === 'all' ? undefined : args.filter),
      ]);
      const qLower = args.query?.trim().toLowerCase();
      const filtered = rawTorrents.filter((t) => {
        if (qLower && !t.name.toLowerCase().includes(qLower)) return false;
        if (args.category && t.category !== args.category) return false;
        return true;
      });
      filtered.sort((a, b) => {
        switch (args.sort) {
          case 'completed':
            return (b.completion_on ?? 0) - (a.completion_on ?? 0);
          case 'name':
            return a.name.localeCompare(b.name);
          case 'progress':
            return b.progress - a.progress;
          case 'size':
            return b.size - a.size;
          case 'recent':
          default:
            return (b.added_on ?? 0) - (a.added_on ?? 0);
        }
      });

      const projected = filtered.slice(0, args.limit).map(projectTorrent);
      const categories = deps.config.modules.qbittorrent?.categories ?? {};
      const header = `qBittorrent (${transfer.connection_status}): ${projected.length}/${filtered.length} torrent(s), DL ${Math.round(transfer.dl_info_speed / 1024)} KB/s, UL ${Math.round(transfer.up_info_speed / 1024)} KB/s`;
      const lines = projected.slice(0, 15).map(formatTorrentLine);
      return {
        summary: lines.length > 0 ? `${header}\n${lines.join('\n')}` : header,
        structured: {
          transfer: transfer as unknown as Record<string, unknown>,
          total_matched: filtered.length,
          returned: projected.length,
          torrents: projected,
          categories,
        },
      };
    },
  });

  registry.registerTool({
    name: 'downloads_inspect',
    toolset: 'downloads',
    tier: 'T0',
    description:
      'Inspects a specific torrent by infohash or name query, returning completion timestamp, save path, files, and sanitized tracker states. Read-only.',
    annotations: {
      title: 'Inspect Download',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        hash_or_query: z.string().min(2),
      })
      .strict(),
    outputSchema: z.object({
      matched: z.boolean(),
      torrent: z.record(z.string(), z.unknown()).optional(),
      files: z.array(z.record(z.string(), z.unknown())).optional(),
      total_files: z.number().int().optional(),
      trackers: z.array(z.record(z.string(), z.unknown())).optional(),
      total_matches: z.number().int().optional(),
      matches: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
    handler: async (args) => {
      const qb = requireQbit(deps);
      const all = await qb.listTorrents();
      const needle = args.hash_or_query.trim().toLowerCase();

      const exact = all.find((t) => t.hash.toLowerCase() === needle);
      const matches = exact
        ? [exact]
        : needle.length >= 8 && /^[0-9a-f]+$/.test(needle)
          ? all.filter((t) => t.hash.toLowerCase().startsWith(needle))
          : all.filter((t) => t.name.toLowerCase().includes(needle));

      if (matches.length === 0) {
        throw new HomemcpError('NOT_FOUND', `No torrent matched "${args.hash_or_query}"`);
      }

      if (matches.length > 1) {
        const sorted = [...matches].sort((a, b) => (b.added_on ?? 0) - (a.added_on ?? 0));
        const compact = sorted.slice(0, 10).map(projectTorrent);
        return {
          summary: `Found ${matches.length} torrents matching "${args.hash_or_query}":\n${compact.map(formatTorrentLine).join('\n')}`,
          structured: {
            matched: false,
            total_matches: matches.length,
            matches: compact,
          },
        };
      }

      const target = matches[0]!;
      const [files, trackers] = await Promise.all([
        qb.getTorrentFiles(target.hash),
        qb.getTorrentTrackers(target.hash),
      ]);
      const proj = projectTorrent(target);
      const projectedFiles = files.slice(0, 50).map((f) => ({
        index: f.index,
        name: f.name,
        size_bytes: f.size,
        progress_pct: Math.round(f.progress * 1000) / 10,
        priority: f.priority,
      }));
      const projectedTrackers = trackers.map((tr) => ({
        url: sanitizeTrackerUrl(tr.url),
        status: tr.status,
        num_peers: tr.num_peers,
        msg: tr.msg,
      }));
      const sizeMb = (proj.size_bytes / (1024 * 1024)).toFixed(1);
      return {
        summary: `"${proj.name}" [${proj.state}, ${proj.progress_pct}%, ${sizeMb} MB, cat=${proj.category || 'none'}, completed=${proj.completed_at ?? 'in_progress'}, path=${proj.save_path}, files=${files.length}, hash=${proj.hash}]`,
        structured: {
          matched: true,
          torrent: proj,
          files: projectedFiles,
          total_files: files.length,
          trackers: projectedTrackers,
        },
      };
    },
  });

  registry.registerTool({
    name: 'downloads_add',
    toolset: 'downloads',
    tier: 'T1',
    description:
      'Adds a magnet link or torrent URL to qBittorrent under a configured category (e.g., movies, series, anime) after verifying target filesystem free space is above safety threshold.',
    annotations: {
      title: 'Add Download',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        url: z.string().min(8),
        category: z.string().min(1),
        min_free_bytes: z.number().int().positive().default(10_000_000_000),
      })
      .strict(),
    outputSchema: z.object({
      added: z.boolean(),
      category: z.string(),
      save_path: z.string(),
      available_bytes: z.number(),
    }),
    handler: async (args) => {
      const qb = requireQbit(deps);
      const categories = deps.config.modules.qbittorrent?.categories ?? {};
      const savePath = categories[args.category];
      if (!savePath) {
        throw new HomemcpError(
          'INVALID_ARGUMENT',
          `Unknown category "${args.category}". Allowed: ${Object.keys(categories).join(', ') || 'none configured'}`,
        );
      }

      const disks = await deps.agent.call<{
        filesystems: Array<{ mountpoint: string; available_bytes: number }>;
      }>('system.disks');

      // Find deepest matching mountpoint for savePath
      const matchingFs = [...disks.filesystems]
        .filter(
          (f) =>
            savePath === f.mountpoint ||
            savePath.startsWith(f.mountpoint === '/' ? '/' : `${f.mountpoint}/`),
        )
        .sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];

      const avail = matchingFs?.available_bytes ?? 0;
      if (avail < args.min_free_bytes) {
        throw new HomemcpError(
          'CONFLICT',
          `Insufficient free space on ${matchingFs?.mountpoint ?? 'target disk'}: ${avail} bytes available (< ${args.min_free_bytes} bytes required)`,
        );
      }

      await qb.addTorrent({
        urls: [args.url],
        category: args.category,
        savepath: savePath,
      });

      return {
        summary: `Queued download under "${args.category}" (${savePath})`,
        structured: {
          added: true,
          category: args.category,
          save_path: savePath,
          available_bytes: avail,
        },
      };
    },
  });

  registry.registerTool({
    name: 'downloads_control',
    toolset: 'downloads',
    tier: 'T1',
    description: 'Pauses, resumes, or forces recheck on one or more torrents by infohash.',
    annotations: {
      title: 'Control Downloads',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        action: z.enum(['pause', 'resume', 'recheck']),
        hashes: z.array(z.string().min(8)).min(1).max(50),
      })
      .strict(),
    outputSchema: z.object({
      action: z.string(),
      count: z.number().int(),
    }),
    handler: async (args) => {
      const qb = requireQbit(deps);
      await qb.controlTorrents(args.action, args.hashes);
      return {
        summary: `Executed "${args.action}" on ${args.hashes.length} torrent(s)`,
        structured: { action: args.action, count: args.hashes.length },
      };
    },
  });

  registry.registerTool({
    name: 'downloads_remove',
    toolset: 'downloads',
    tier: 'T2',
    description:
      'Removes torrents from qBittorrent (plan-first; deleting downloaded files requires T3 passkey confirmation).',
    annotations: {
      title: 'Remove Downloads',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        hashes: z.array(z.string().min(8)).min(1).max(25),
        delete_files: z.boolean().default(false),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const qb = requireQbit(deps);
      const tier = args.delete_files ? 'T3' : 'T2';
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'downloads_remove',
          tier,
          payload: { hashes: args.hashes, delete_files: args.delete_files },
          summary: `Remove ${args.hashes.length} torrent(s) (${args.delete_files ? 'WITH FILES DELETED' : 'keep files on disk'})`,
          diff: `delete_torrents(${args.hashes.join(', ')}, delete_files=${args.delete_files})`,
          sideEffects: [
            args.delete_files
              ? 'Permanently deletes torrent payload files from disk'
              : 'Removes torrent entries from qBittorrent (files kept)',
          ],
          rollback: [args.delete_files ? 'Irreversible disk deletion' : 'Re-add .torrent/magnet'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Plan ${plan.id} created`,
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
        expectedTool: 'downloads_remove',
        tier: args.delete_files ? 'T3' : 'T2',
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
      const p = gate.plan.payload as { hashes: string[]; delete_files: boolean };
      await qb.deleteTorrents(p.hashes, Boolean(p.delete_files));
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Removed ${p.hashes.length} torrent(s)`,
        structured: { applied: true, status: 'applied', removed: p.hashes.length },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
