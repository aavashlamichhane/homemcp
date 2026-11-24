import * as z from 'zod/v4';
import type { JellyfinConnector } from '@homemcp/connectors';
import { HomemcpError } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

function requireJellyfin(deps: GatewayDeps): JellyfinConnector {
  if (!deps.jellyfin) {
    throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Jellyfin connector not configured');
  }
  return deps.jellyfin;
}

export function registerMediaModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'jellyfin_health',
    toolset: 'media',
    tier: 'T0',
    description:
      'Reports Jellyfin /health status, version, active playback/transcode count, hardware acceleration usage, failed scheduled tasks, and container health. Read-only.',
    annotations: {
      title: 'Jellyfin Health',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      healthy: z.boolean(),
      version: z.string(),
      server_name: z.string(),
      active_sessions: z.number().int(),
      active_transcodes: z.number().int(),
      failed_tasks: z.array(z.string()),
      libraries: z.array(z.string()),
    }),
    handler: async () => {
      const jf = requireJellyfin(deps);
      const [health, info, sessions, tasks, libraries] = await Promise.all([
        jf.getHealth(),
        jf.getSystemInfo(),
        jf.getSessions(),
        jf.getScheduledTasks(),
        jf.getLibraries(),
      ]);
      const transcodes = sessions.filter(
        (s) => s.PlayState?.PlayMethod === 'Transcode' || Boolean(s.TranscodingInfo && !s.TranscodingInfo.IsVideoDirect),
      );
      const failedTasks = tasks
        .filter((t) => t.LastExecutionResult?.Status === 'Failed')
        .map((t) => t.Name);

      return {
        summary: `Jellyfin ${info.Version} (${health.ok ? 'healthy' : 'unhealthy'}), ${sessions.length} active session(s) (${transcodes.length} transcoding)`,
        structured: {
          healthy: health.ok,
          version: info.Version,
          server_name: info.ServerName,
          active_sessions: sessions.length,
          active_transcodes: transcodes.length,
          failed_tasks: failedTasks,
          libraries: libraries.map((l) => l.Name),
        },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_sessions',
    toolset: 'media',
    tier: 'T0',
    description: 'Lists active Jellyfin playback sessions including codec, hardware acceleration, and transcode reasons. Read-only.',
    annotations: {
      title: 'Jellyfin Sessions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      sessions: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const jf = requireJellyfin(deps);
      const sessions = await jf.getSessions();
      return {
        summary: `${sessions.length} active Jellyfin session(s)`,
        structured: { sessions: sessions as unknown as Array<Record<string, unknown>> },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_libraries',
    toolset: 'media',
    tier: 'T0',
    description: 'Lists configured Jellyfin virtual folders and refresh states. Read-only.',
    annotations: {
      title: 'Jellyfin Libraries',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      libraries: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const jf = requireJellyfin(deps);
      const libraries = await jf.getLibraries();
      return {
        summary: `${libraries.length} Jellyfin library folder(s)`,
        structured: { libraries: libraries as unknown as Array<Record<string, unknown>> },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_search',
    toolset: 'media',
    tier: 'T0',
    description: 'Searches Jellyfin library items by title or media type. Read-only.',
    annotations: {
      title: 'Search Jellyfin Library',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        query: z.string().min(1),
        types: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      })
      .strict(),
    outputSchema: z.object({
      total: z.number().int(),
      items: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const jf = requireJellyfin(deps);
      const res = await jf.searchItems({
        searchTerm: args.query,
        includeItemTypes: args.types,
        limit: args.limit,
      });
      return {
        summary: `Found ${res.Items.length} Jellyfin item(s) for "${args.query}"`,
        structured: {
          total: res.TotalRecordCount,
          items: res.Items as unknown as Array<Record<string, unknown>>,
        },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_recently_added',
    toolset: 'media',
    tier: 'T0',
    description: 'Lists recently added items in Jellyfin. Read-only.',
    annotations: {
      title: 'Recently Added (Jellyfin)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        limit: z.number().int().min(1).max(50).default(20),
        types: z.string().optional(),
      })
      .strict(),
    outputSchema: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const jf = requireJellyfin(deps);
      const res = await jf.searchItems({
        includeItemTypes: args.types,
        limit: args.limit,
        sortBy: 'DateCreated',
        sortOrder: 'Descending',
      });
      return {
        summary: `Returned ${res.Items.length} recently added Jellyfin item(s)`,
        structured: { items: res.Items as unknown as Array<Record<string, unknown>> },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_find_problems',
    toolset: 'media',
    tier: 'T0',
    description:
      'Scans Jellyfin library items for unidentified entries (missing ProviderIds), missing primary images, duplicate TMDB IDs, and non-standard Movie/Episode filenames. Read-only.',
    annotations: {
      title: 'Find Jellyfin Library Problems',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(200) }).strict(),
    outputSchema: z.object({
      scanned: z.number().int(),
      unidentified: z.array(z.record(z.string(), z.unknown())),
      missing_images: z.array(z.record(z.string(), z.unknown())),
      naming_issues: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const jf = requireJellyfin(deps);
      const res = await jf.searchItems({
        includeItemTypes: 'Movie,Episode',
        limit: args.limit,
      });
      const unidentified: Array<Record<string, unknown>> = [];
      const missingImages: Array<Record<string, unknown>> = [];
      const namingIssues: Array<Record<string, unknown>> = [];

      for (const item of res.Items) {
        const hasProvider = Boolean(item.ProviderIds && Object.keys(item.ProviderIds).length > 0);
        if (!hasProvider) {
          unidentified.push({ id: item.Id, name: item.Name, type: item.Type, path: item.Path });
        }
        if (!item.ImageTags?.['Primary']) {
          missingImages.push({ id: item.Id, name: item.Name, type: item.Type });
        }
        if (item.Type === 'Movie' && item.Path && !/\(\d{4}\)/.test(item.Path)) {
          namingIssues.push({ id: item.Id, name: item.Name, path: item.Path, issue: 'Missing (Year) in movie filename/dir' });
        }
      }

      return {
        summary: `Scanned ${res.Items.length} items: ${unidentified.length} unidentified, ${missingImages.length} missing images, ${namingIssues.length} naming issues`,
        structured: {
          scanned: res.Items.length,
          unidentified,
          missing_images: missingImages,
          naming_issues: namingIssues,
        },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_activity_log',
    toolset: 'media',
    tier: 'T0',
    description: 'Returns recent Jellyfin authentication and admin activity log entries. Read-only.',
    annotations: {
      title: 'Jellyfin Activity Log',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict(),
    outputSchema: z.object({
      entries: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const jf = requireJellyfin(deps);
      const entries = await jf.getActivityLog(args.limit);
      return {
        summary: `Returned ${entries.length} Jellyfin activity entries`,
        structured: { entries },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_scheduled_tasks',
    toolset: 'media',
    tier: 'T0',
    description: 'Lists Jellyfin scheduled tasks and last execution results. Read-only.',
    annotations: {
      title: 'Jellyfin Scheduled Tasks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      tasks: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const jf = requireJellyfin(deps);
      const tasks = await jf.getScheduledTasks();
      return {
        summary: `${tasks.length} Jellyfin scheduled tasks`,
        structured: { tasks: tasks as unknown as Array<Record<string, unknown>> },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_users',
    toolset: 'media',
    tier: 'T0',
    description: 'Lists configured Jellyfin user accounts and admin flags (redacted). Read-only.',
    annotations: {
      title: 'Jellyfin Users',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      users: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const jf = requireJellyfin(deps);
      const users = await jf.getUsers();
      return {
        summary: `${users.length} Jellyfin user(s)`,
        structured: { users },
      };
    },
  });

  registry.registerTool({
    name: 'jellyfin_run_task',
    toolset: 'media',
    tier: 'T1',
    description: 'Triggers a Jellyfin scheduled task by ID or exact task name (e.g., Scan Media Library).',
    annotations: {
      title: 'Run Jellyfin Task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ task_id_or_name: z.string().min(1) }).strict(),
    outputSchema: z.object({
      triggered: z.boolean(),
      task_id: z.string(),
      task_name: z.string(),
    }),
    handler: async (args) => {
      const jf = requireJellyfin(deps);
      const tasks = await jf.getScheduledTasks();
      const found = tasks.find(
        (t) =>
          t.Id === args.task_id_or_name ||
          t.Name.toLowerCase() === args.task_id_or_name.toLowerCase(),
      );
      if (!found) {
        throw new HomemcpError('NOT_FOUND', `Jellyfin task not found: ${args.task_id_or_name}`);
      }
      await jf.runScheduledTask(found.Id);
      return {
        summary: `Triggered Jellyfin task "${found.Name}" (${found.Id})`,
        structured: { triggered: true, task_id: found.Id, task_name: found.Name },
      };
    },
  });
}
