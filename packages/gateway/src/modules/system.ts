import * as z from 'zod/v4';
import { formatUntrustedText, wrapUntrusted } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

function computeDaysUntilFull(
  history: Array<{ ts: string; payload: unknown }>,
  mountpoint: string,
  sizeBytes: number,
  usedBytes: number,
): { growth_bytes_per_day?: number | undefined; days_until_full?: number | undefined } {
  const points: Array<{ x: number; y: number }> = [];
  for (const snap of history) {
    const p = snap.payload as { filesystems?: Array<{ mountpoint: string; used_bytes: number }> };
    const fs = p.filesystems?.find((f) => f.mountpoint === mountpoint);
    const t = Date.parse(snap.ts);
    if (fs && Number.isFinite(t)) {
      points.push({ x: t / 86_400_000, y: fs.used_bytes });
    }
  }
  points.push({ x: Date.now() / 86_400_000, y: usedBytes });
  if (points.length < 2) return {};

  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  if (den <= 0) return {};
  const slope = Math.round(num / den);
  const remaining = Math.max(0, sizeBytes - usedBytes);
  const days = slope > 0 ? Math.round(remaining / slope) : undefined;
  return {
    growth_bytes_per_day: slope,
    ...(days !== undefined ? { days_until_full: days } : {}),
  };
}

export function registerSystemModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'system_health',
    toolset: 'system',
    tier: 'T0',
    description:
      'Returns CPU load, RAM/swap usage, thermal zone temperatures, battery/AC power status, uptime, reboot-required flag, failed systemd units, and OOM kill count (24h). Read-only. Example: system_health().',
    annotations: {
      title: 'System Health',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async () => {
      const data = await deps.agent.call<Record<string, unknown>>('system.health');
      return {
        summary: `CPU ${String(data['cpu_percent'])}%, uptime ${Math.round(Number(data['uptime_seconds'] ?? 0) / 3600)}h, reboot_required=${String(data['reboot_required'])}`,
        structured: data,
      };
    },
  });

  registry.registerTool({
    name: 'system_metrics_history',
    toolset: 'system',
    tier: 'T0',
    description:
      'Queries sysstat historical metrics (cpu, mem, io, net, load) via sadf, downsampled to <=120 points. Read-only. Example: system_metrics_history({ group: "cpu" }).',
    annotations: {
      title: 'System Metrics History',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        group: z.enum(['cpu', 'mem', 'io', 'net', 'load']).default('cpu'),
        day: z
          .string()
          .regex(/^\d{2}$/)
          .optional(),
        max_points: z.number().int().min(10).max(120).default(120),
      })
      .strict(),
    outputSchema: z.object({
      group: z.string(),
      points: z.array(z.record(z.string(), z.unknown())),
      truncated: z.boolean(),
    }),
    handler: async (args) => {
      const data = await deps.agent.call<{
        group: string;
        points: Array<Record<string, unknown>>;
        truncated: boolean;
      }>('system.metrics_history', args);
      return {
        summary: `Returned ${data.points.length} ${data.group} sysstat points`,
        structured: data,
      };
    },
  });

  registry.registerTool({
    name: 'system_disks',
    toolset: 'system',
    tier: 'T0',
    description:
      'Returns mounted filesystems (bytes, inodes), growth forecast (days_until_full) from daily snapshots, and SMART health summary. Read-only. Example: system_disks().',
    annotations: {
      title: 'Disks & SMART Summary',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      filesystems: z.array(
        z.object({
          filesystem: z.string(),
          mountpoint: z.string(),
          size_bytes: z.number(),
          used_bytes: z.number(),
          available_bytes: z.number(),
          use_percent: z.number(),
          growth_bytes_per_day: z.number().optional(),
          days_until_full: z.number().optional(),
        }),
      ),
      smart_summary: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const data = await deps.agent.call<{
        filesystems: Array<{
          filesystem: string;
          mountpoint: string;
          size_bytes: number;
          used_bytes: number;
          available_bytes: number;
          use_percent: number;
        }>;
        smart_summary: Array<Record<string, unknown>>;
      }>('system.disks');

      const history = deps.db.getMetricSnapshots('disk', 90);
      const todayPrefix = new Date().toISOString().slice(0, 10);
      if (!history.some((h) => h.ts.startsWith(todayPrefix))) {
        deps.db.insertMetricSnapshot('disk', { filesystems: data.filesystems });
      }

      const filesystems = data.filesystems.map((fs) => ({
        ...fs,
        ...computeDaysUntilFull(history, fs.mountpoint, fs.size_bytes, fs.used_bytes),
      }));

      return {
        summary: filesystems
          .map(
            (f) =>
              `${f.mountpoint}: ${f.use_percent}% used (${Math.round(f.available_bytes / 1e9)} GB free)`,
          )
          .join('\n'),
        structured: { filesystems, smart_summary: data.smart_summary },
      };
    },
  });

  registry.registerTool({
    name: 'system_smart_details',
    toolset: 'system',
    tier: 'T0',
    description:
      'Returns detailed SMART attributes for one block device (e.g., sda, sdb) from the exported status snapshot. Read-only. Example: system_smart_details({ device: "sda" }).',
    annotations: {
      title: 'SMART Details',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ device: z.string().regex(/^[a-z0-9_-]+$/) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async ({ device }) => {
      const data = await deps.agent.call<Record<string, unknown>>('system.smart_details', {
        device,
      });
      return {
        summary: `SMART ${device} (${String(data['model'])}): passed=${String(data['passed'])}`,
        structured: data,
      };
    },
  });

  registry.registerTool({
    name: 'system_processes',
    toolset: 'system',
    tier: 'T0',
    description:
      'Lists top N host processes sorted by CPU or memory usage with secret redaction. Read-only. Example: system_processes({ sort_by: "cpu", limit: 15 }).',
    annotations: {
      title: 'Top Processes',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        sort_by: z.enum(['cpu', 'mem']).default('cpu'),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
    outputSchema: z.object({
      processes: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const data = await deps.agent.call<{ processes: Array<Record<string, unknown>> }>(
        'system.processes',
        args,
      );
      return {
        summary: `Top ${data.processes.length} processes by ${args.sort_by}`,
        structured: data,
      };
    },
  });

  registry.registerTool({
    name: 'system_logs_query',
    toolset: 'system',
    tier: 'T0',
    description:
      'Queries journald logs by unit, priority, time range, or grep pattern. Log messages are wrapped as untrusted data and redacted. Read-only. Example: system_logs_query({ unit: "docker.service", limit: 100 }).',
    annotations: {
      title: 'Query System Logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        unit: z.string().optional(),
        priority: z.number().int().min(0).max(7).optional(),
        since: z.string().default('-24h'),
        until: z.string().optional(),
        grep: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(200),
      })
      .strict(),
    outputSchema: z.object({
      untrusted_source: z.string(),
      untrusted_data: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const data = await deps.agent.call<{
        entries: Array<{ ts: string; unit: string; priority: number; message: string }>;
      }>('system.logs_query', args);
      const text = data.entries
        .slice(0, 50)
        .map((e) => `${e.ts} [${e.unit}] p${e.priority}: ${e.message}`)
        .join('\n');
      return {
        summary: formatUntrustedText('journald', text || '(no matching entries)'),
        structured: wrapUntrusted('journald', data.entries),
      };
    },
  });

  registry.registerTool({
    name: 'system_errors_summary',
    toolset: 'system',
    tier: 'T0',
    description:
      'Deduplicates journald error/critical signatures over 24h or 7d and flags known-noise patterns. Read-only. Example: system_errors_summary({ since: "24h" }).',
    annotations: {
      title: 'System Errors Summary',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        since: z.enum(['24h', '7d']).default('24h'),
        limit: z.number().int().min(1).max(100).default(30),
      })
      .strict(),
    outputSchema: z.object({
      since: z.string(),
      total_errors: z.number().int(),
      untrusted_source: z.string(),
      untrusted_data: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const data = await deps.agent.call<{
        since: string;
        total_errors: number;
        signatures: Array<Record<string, unknown>>;
      }>('system.errors_summary', args);
      const wrapped = wrapUntrusted('journald', data.signatures);
      return {
        summary: `${data.total_errors} total errors (${data.signatures.length} unique signatures) over ${data.since}`,
        structured: {
          since: data.since,
          total_errors: data.total_errors,
          ...wrapped,
        },
      };
    },
  });

  registry.registerTool({
    name: 'system_updates',
    toolset: 'system',
    tier: 'T0',
    description:
      'Checks pending apt package updates (highlighting security updates), unattended-upgrades last run, and reboot-required status. Read-only. Example: system_updates().',
    annotations: {
      title: 'OS Updates Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async () => {
      const data = await deps.agent.call<Record<string, unknown>>('system.updates');
      return {
        summary: `${String(data['upgradable_count'])} upgradable packages (${String(data['security_count'])} security), reboot_required=${String(data['reboot_required'])}`,
        structured: data,
      };
    },
  });

  registry.registerTool({
    name: 'system_security_audit',
    toolset: 'system',
    tier: 'T0',
    description:
      'Reports UFW firewall status, effective sshd settings, listening sockets (flagging wildcard binds), failed SSH logins, and Tailscale break-glass state. Read-only. Example: system_security_audit().',
    annotations: {
      title: 'Host Security Audit',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async () => {
      const data = await deps.agent.call<{
        ufw_status: string;
        listening_sockets: Array<{ wildcard: boolean }>;
        failed_ssh_logins_24h: number;
        tailscale: { backend_state: string };
      }>('system.security_audit');
      const wildcards = data.listening_sockets.filter((s) => s.wildcard).length;
      return {
        summary: `UFW: ${data.ufw_status.split('\n')[0] ?? 'unknown'}, Wildcard sockets: ${wildcards}, Failed SSH (24h): ${data.failed_ssh_logins_24h}, Tailscale: ${data.tailscale.backend_state}`,
        structured: data,
      };
    },
  });

  registry.registerTool({
    name: 'system_network',
    toolset: 'system',
    tier: 'T0',
    description:
      'Lists host network interfaces, IP addresses, routing table, and DNS nameservers. Read-only. Example: system_network().',
    annotations: {
      title: 'Host Network Info',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async () => {
      const data = await deps.agent.call<{ interfaces: Array<{ name: string; state: string }> }>(
        'system.network',
      );
      return {
        summary: `Interfaces: ${data.interfaces.map((i) => `${i.name}(${i.state})`).join(', ')}`,
        structured: data,
      };
    },
  });

  registry.registerTool({
    name: 'system_services',
    toolset: 'system',
    tier: 'T0',
    description:
      'Checks status, PID, restarts, and memory of allowlisted host systemd services. Read-only. Example: system_services().',
    annotations: {
      title: 'Systemd Services Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        units: z.array(z.string()).optional(),
      })
      .strict(),
    outputSchema: z.object({
      services: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async (args) => {
      const data = await deps.agent.call<{
        services: Array<{ unit: string; active_state: string; sub_state: string }>;
      }>('system.services', args);
      return {
        summary: data.services.map((s) => `${s.unit}: ${s.active_state}/${s.sub_state}`).join('\n'),
        structured: data,
      };
    },
  });

  registry.registerTool({
    name: 'system_service_action',
    toolset: 'system',
    tier: 'T2',
    description:
      'Starts, stops, or restarts an allowlisted host systemd unit (protected units always denied). Plan-first when plan_id is omitted.',
    annotations: {
      title: 'Systemd Service Action',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        unit: z.string().min(1),
        action: z.enum(['start', 'stop', 'restart']),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'system_service_action',
          tier: 'T2',
          payload: { unit: args.unit, action: args.action },
          summary: `${args.action} systemd unit ${args.unit}`,
          diff: `systemctl ${args.action} ${args.unit}`,
          sideEffects: [`Systemd unit ${args.unit} will ${args.action}`],
          rollback: [`systemctl ${args.action === 'stop' ? 'start' : 'restart'} ${args.unit}`],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Plan ${plan.id} created; confirm at ${publicUrl}/confirm/${chal.id}`,
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
        expectedTool: 'system_service_action',
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
      const p = gate.plan.payload as { unit: string; action: string };
      const res = await deps.agent.call<{ unit: string; action: string; ok: boolean }>(
        'system.service_action',
        p,
      );
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Executed systemctl ${res.action} ${res.unit}`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'system_reboot',
    toolset: 'system',
    tier: 'T3',
    description:
      'Schedules a host reboot in 1 minute with an ntfy alert. Requires T3 passkey confirmation via /confirm/:id.',
    annotations: {
      title: 'Reboot Host',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({ plan_id: z.string().optional(), reason: z.string().default('kernel updates') })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'system_reboot',
          tier: 'T3',
          payload: { reason: args.reason },
          summary: `Reboot homelab host in 1 minute (reason: ${args.reason})`,
          diff: 'shutdown -r +1',
          sideEffects: ['All containers and SSH sessions will disconnect for ~2-3 minutes'],
          rollback: ['Host comes back automatically via systemd'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Reboot plan ${plan.id} requires passkey confirmation at ${publicUrl}/confirm/${chal.id}`,
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
        expectedTool: 'system_reboot',
        tier: 'T3',
        auth: ctx.auth,
        mcpCtx: ctx.mcpCtx,
        publicUrl: deps.config.server.publicUrl,
      });
      if (!gate.approved) {
        return {
          summary: `Passkey confirmation required at ${gate.confirmUrl}`,
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
      const res = await deps.agent.call<{ scheduled: boolean; message: string }>(
        'system.reboot',
        {},
      );
      deps.plans.markApplied(gate.plan.id);
      await deps.watcher.sendOrQueueNotification({
        title: 'Host Reboot Scheduled',
        message: `Reboot triggered by ${ctx.auth.subject}: ${args.reason}`,
        priority: 4,
        tags: ['warning', 'arrows_counterclockwise'],
      });
      return {
        summary: res.message,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
