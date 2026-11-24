import * as z from 'zod/v4';
import { HomemcpError, parseDurationMs } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

export function registerCoreModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'homemcp_overview',
    toolset: 'core',
    tier: 'T0',
    description:
      'Start here. Summarizes host health, unhealthy/restarting containers, disk usage, backup freshness, pending OS updates, and stale/dead routes, with drill-down hints. Read-only. Example: call homemcp_overview() first for any status question.',
    annotations: {
      title: 'Server Overview',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      health: z.object({
        cpu_percent: z.number(),
        load_avg: z.tuple([z.number(), z.number(), z.number()]),
        mem_used_percent: z.number(),
        max_temp_c: z.number().optional(),
        ac_online: z.boolean().optional(),
        battery_percent: z.number().optional(),
        reboot_required: z.boolean(),
        failed_units: z.array(z.string()),
      }),
      containers: z.object({
        total: z.number().int(),
        running: z.number().int(),
        unhealthy: z.array(z.string()),
        restarting: z.array(z.string()),
      }),
      disks: z.array(
        z.object({
          mountpoint: z.string(),
          use_percent: z.number(),
          available_bytes: z.number(),
        }),
      ),
      backups: z.array(
        z.object({
          set: z.string(),
          last_status: z.string(),
          age_seconds: z.number().optional(),
          stale: z.boolean(),
        }),
      ),
      updates: z.object({
        upgradable_count: z.number().int(),
        security_count: z.number().int(),
      }),
      hints: z.array(z.string()),
    }),
    handler: async () => {
      const [sysHealth, sysDisks, sysUpdates, backupData, containers] = await Promise.all([
        deps.agent.call<{
          load_avg: [number, number, number];
          cpu_percent: number;
          mem_total_bytes: number;
          mem_available_bytes: number;
          temperatures: Array<{ label: string; temp_c: number }>;
          battery?: { ac_online?: boolean; capacity_percent?: number };
          reboot_required: boolean;
          failed_units: string[];
        }>('system.health'),
        deps.agent.call<{
          filesystems: Array<{ mountpoint: string; use_percent: number; available_bytes: number }>;
        }>('system.disks'),
        deps.agent.call<{ upgradable_count: number; security_count: number }>('system.updates'),
        deps.agent.call<{
          status: Record<string, { last_status?: string; last_success?: string }>;
        }>('backup.read_status'),
        deps.docker ? deps.docker.listContainers(true) : Promise.resolve([]),
      ]);

      const memUsedPct =
        sysHealth.mem_total_bytes > 0
          ? Math.round(
              ((sysHealth.mem_total_bytes - sysHealth.mem_available_bytes) /
                sysHealth.mem_total_bytes) *
                1000,
            ) / 10
          : 0;
      const maxTemp =
        sysHealth.temperatures.length > 0
          ? Math.max(...sysHealth.temperatures.map((t) => t.temp_c))
          : undefined;

      const unhealthy = containers
        .filter((c) => c.Status.toLowerCase().includes('unhealthy'))
        .map((c) => c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12));
      const restarting = containers
        .filter((c) => c.State === 'restarting')
        .map((c) => c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12));
      const runningCount = containers.filter((c) => c.State === 'running').length;

      const configuredSets = deps.config.modules.backup?.sets ?? {};
      const nowMs = Date.now();
      const backups = Object.entries(configuredSets).map(([setName, cfg]) => {
        const st = backupData.status[setName];
        const lastSuccess = st?.last_success;
        const ageSec = lastSuccess
          ? Math.floor((nowMs - Date.parse(lastSuccess)) / 1000)
          : undefined;
        const rpoSec = Math.floor(parseDurationMs(cfg.rpo) / 1000);
        const stale = ageSec === undefined || ageSec > rpoSec || st?.last_status !== 'success';
        return {
          set: setName,
          last_status: st?.last_status ?? 'missing',
          ...(ageSec !== undefined ? { age_seconds: ageSec } : {}),
          stale,
        };
      });

      const hints: string[] = [];
      if (unhealthy.length > 0)
        hints.push(
          `Inspect unhealthy containers with docker_service_profile: ${unhealthy.join(', ')}`,
        );
      if (sysHealth.failed_units.length > 0)
        hints.push(`Check failed systemd units via system_logs_query`);
      if (backups.some((b) => b.stale))
        hints.push(`Stale backups detected; inspect with backup_status`);
      if (sysDisks.filesystems.some((d) => d.use_percent >= 85))
        hints.push(`Disk >=85%; run system_disks`);
      if (sysUpdates.security_count > 0)
        hints.push(`${sysUpdates.security_count} security updates pending; run system_updates`);

      const summary = [
        `CPU ${sysHealth.cpu_percent}%, Load ${sysHealth.load_avg.join('/')}, Mem ${memUsedPct}%${maxTemp !== undefined ? `, MaxTemp ${maxTemp}°C` : ''}`,
        `Containers: ${runningCount}/${containers.length} running (unhealthy: ${unhealthy.length}, restarting: ${restarting.length})`,
        `Backups: ${backups.filter((b) => !b.stale).length}/${backups.length} fresh`,
        `Updates: ${sysUpdates.upgradable_count} upgradable (${sysUpdates.security_count} security)`,
        ...(hints.length > 0 ? [`Hints: ${hints.join(' | ')}`] : []),
      ].join('\n');

      return {
        summary,
        structured: {
          health: {
            cpu_percent: sysHealth.cpu_percent,
            load_avg: sysHealth.load_avg,
            mem_used_percent: memUsedPct,
            ...(maxTemp !== undefined ? { max_temp_c: maxTemp } : {}),
            ...(sysHealth.battery?.ac_online !== undefined
              ? { ac_online: sysHealth.battery.ac_online }
              : {}),
            ...(sysHealth.battery?.capacity_percent !== undefined
              ? { battery_percent: sysHealth.battery.capacity_percent }
              : {}),
            reboot_required: sysHealth.reboot_required,
            failed_units: sysHealth.failed_units,
          },
          containers: {
            total: containers.length,
            running: runningCount,
            unhealthy,
            restarting,
          },
          disks: sysDisks.filesystems,
          backups,
          updates: sysUpdates,
          hints,
        },
      };
    },
  });

  registry.registerTool({
    name: 'homemcp_capabilities',
    toolset: 'core',
    tier: 'T0',
    description:
      'Lists enabled toolsets, registered tools, connector readiness, caller scopes, and server version. Read-only. Example: homemcp_capabilities().',
    annotations: {
      title: 'Server Capabilities',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      version: z.string(),
      mock_mode: z.boolean(),
      caller: z.object({
        subject: z.string(),
        client_id: z.string(),
        token_kind: z.string(),
        scopes: z.array(z.string()),
      }),
      enabled_toolsets: z.array(z.string()),
      connectors: z.record(z.string(), z.boolean()),
      tool_count: z.number().int(),
    }),
    handler: (_args, ctx) => {
      return Promise.resolve({
        summary: `homemcp v${deps.version} (${deps.isMock ? 'mock' : 'live'}), ${registry.listTools().length} tools registered`,
        structured: {
          version: deps.version,
          mock_mode: deps.isMock,
          caller: {
            subject: ctx.auth.subject,
            client_id: ctx.auth.clientId,
            token_kind: ctx.auth.tokenKind,
            scopes: [...ctx.auth.scopes],
          },
          enabled_toolsets: [...deps.config.server.toolsets],
          connectors: {
            agent: true,
            docker: Boolean(deps.docker),
            npm: Boolean(deps.npm),
            cloudflare: Boolean(deps.cloudflare),
            vaultwarden: Boolean(deps.vaultwarden),
            subsonic: Boolean(deps.subsonic),
            naviload: Boolean(deps.naviload),
          },
          tool_count: registry.listTools().length,
        },
      });
    },
  });

  registry.registerTool({
    name: 'audit_query',
    toolset: 'core',
    tier: 'T0',
    scope: 'homemcp:audit',
    description:
      'Filters the homemcp audit log by tool, status, or start timestamp. Requires homemcp:audit scope. Read-only. Example: audit_query({ limit: 20 }).',
    annotations: {
      title: 'Query Audit Log',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        tool: z.string().optional(),
        status: z.enum(['ok', 'error']).optional(),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    outputSchema: z.object({
      entries: z.array(
        z.object({
          id: z.string(),
          ts: z.string(),
          subject: z.string(),
          client_id: z.string(),
          token_kind: z.string(),
          tool: z.string(),
          args_redacted: z.string(),
          tier: z.string(),
          status: z.string(),
          error_code: z.string().nullable().optional(),
          duration_ms: z.number().int(),
        }),
      ),
    }),
    handler: (args) => {
      const entries = deps.db.queryAudit({
        tool: args.tool,
        status: args.status,
        since: args.since,
        limit: args.limit,
      });
      return Promise.resolve({
        summary: `Returned ${entries.length} audit entries`,
        structured: { entries },
      });
    },
  });

  registry.registerTool({
    name: 'jobs_list',
    toolset: 'core',
    tier: 'T0',
    description:
      'Lists background and async jobs tracked by homemcp (e.g., playlist downloads, backups, updates). Read-only. Example: jobs_list({ status: "running" }).',
    annotations: {
      title: 'List Background Jobs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        status: z
          .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'waiting_user'])
          .optional(),
        kind: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    outputSchema: z.object({
      jobs: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          status: z.string(),
          progress: z.number().int(),
          created_by: z.string(),
          created_at: z.string(),
          finished_at: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    }),
    handler: (args) => {
      const jobs = deps.jobs.listJobs({
        status: args.status,
        kind: args.kind,
        limit: args.limit,
      });
      return Promise.resolve({
        summary: `${jobs.length} jobs found`,
        structured: {
          jobs: jobs.map((j) => ({
            id: j.id,
            kind: j.kind,
            status: j.status,
            progress: j.progress,
            created_by: j.created_by,
            created_at: j.created_at,
            ...(j.finished_at ? { finished_at: j.finished_at } : {}),
            ...(j.error ? { error: j.error } : {}),
          })),
        },
      });
    },
  });

  registry.registerTool({
    name: 'jobs_get',
    toolset: 'core',
    tier: 'T0',
    description:
      'Returns detailed step logs, progress percentage, and redacted output for a single background job. Read-only. Example: jobs_get({ job_id: "job_123" }).',
    annotations: {
      title: 'Get Background Job',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ job_id: z.string().min(1) }).strict(),
    outputSchema: z.object({
      id: z.string(),
      kind: z.string(),
      status: z.string(),
      progress: z.number().int(),
      steps: z.array(z.object({ ts: z.string(), message: z.string() })),
      created_by: z.string(),
      created_at: z.string(),
      started_at: z.string().optional(),
      finished_at: z.string().optional(),
      result_redacted: z.unknown().optional(),
      error: z.string().optional(),
      cancel_requested: z.boolean(),
    }),
    handler: (args) => {
      const job = deps.jobs.getJob(args.job_id);
      if (!job) {
        throw new HomemcpError('NOT_FOUND', `Job not found: ${args.job_id}`);
      }
      return Promise.resolve({
        summary: `Job ${job.id} (${job.kind}): ${job.status} (${job.progress}%)`,
        structured: job,
      });
    },
  });

  registry.registerTool({
    name: 'jobs_cancel',
    toolset: 'core',
    tier: 'T1',
    description:
      'Requests cancellation of a queued, running, or waiting background job. Example: jobs_cancel({ job_id: "job_123" }).',
    annotations: {
      title: 'Cancel Background Job',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ job_id: z.string().min(1) }).strict(),
    outputSchema: z.object({
      id: z.string(),
      status: z.string(),
      cancel_requested: z.boolean(),
    }),
    handler: (args) => {
      const job = deps.jobs.requestCancel(args.job_id);
      return Promise.resolve({
        summary: `Job ${job.id}: ${job.status} (cancel requested)`,
        structured: {
          id: job.id,
          status: job.status,
          cancel_requested: job.cancel_requested,
        },
        jobId: job.id,
      });
    },
  });
}
