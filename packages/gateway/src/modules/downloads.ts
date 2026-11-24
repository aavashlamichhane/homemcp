import * as z from 'zod/v4';
import type { QbittorrentConnector } from '@homemcp/connectors';
import { HomemcpError } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

function requireQbit(deps: GatewayDeps): QbittorrentConnector {
  if (!deps.qbittorrent) {
    throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'qBittorrent connector not configured');
  }
  return deps.qbittorrent;
}

export function registerDownloadsModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'downloads_status',
    toolset: 'downloads',
    tier: 'T0',
    description:
      'Shows qBittorrent transfer speeds, connection state, active/stalled torrents, and target storage disk free space. Read-only.',
    annotations: {
      title: 'Downloads Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        filter: z.enum(['all', 'downloading', 'seeding', 'completed', 'paused', 'active', 'stalled']).default('all'),
      })
      .strict(),
    outputSchema: z.object({
      transfer: z.record(z.string(), z.unknown()),
      torrents: z.array(z.record(z.string(), z.unknown())),
      categories: z.record(z.string(), z.string()),
    }),
    handler: async (args) => {
      const qb = requireQbit(deps);
      const [transfer, torrents] = await Promise.all([
        qb.getTransferInfo(),
        qb.listTorrents(args.filter === 'all' ? undefined : args.filter),
      ]);
      const categories = deps.config.modules.qbittorrent?.categories ?? {};
      return {
        summary: `qBittorrent (${transfer.connection_status}): ${torrents.length} torrent(s), DL ${Math.round(transfer.dl_info_speed / 1024)} KB/s, UL ${Math.round(transfer.up_info_speed / 1024)} KB/s`,
        structured: {
          transfer: transfer as unknown as Record<string, unknown>,
          torrents: torrents as unknown as Array<Record<string, unknown>>,
          categories,
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
        .filter((f) => savePath === f.mountpoint || savePath.startsWith(f.mountpoint === '/' ? '/' : `${f.mountpoint}/`))
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
}
