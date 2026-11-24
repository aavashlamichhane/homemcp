import * as z from 'zod/v4';
import { formatUntrustedText, HomemcpError, wrapUntrusted } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

export function registerDockerModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'docker_list_services',
    toolset: 'docker',
    tier: 'T0',
    description:
      'Lists all running/stopped containers, Compose projects, and dormant stacks discovered on disk (including policy findings). Read-only. Example: docker_list_services().',
    annotations: {
      title: 'List Docker Services & Stacks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      containers: z.array(z.record(z.string(), z.unknown())),
      dormant_stacks: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const [containers, scan] = await Promise.all([
        deps.docker ? deps.docker.listContainers(true) : Promise.resolve([]),
        deps.agent.call<{
          stacks: Array<{ name: string; dir: string; services: unknown[]; policy_allowed: boolean }>;
        }>('stacks.scan'),
      ]);

      const activeDirs = new Set(
        containers
          .map((c) => c.Labels['com.docker.compose.project.working_dir'])
          .filter((d): d is string => Boolean(d)),
      );
      const activeProjects = new Set(
        containers
          .map((c) => c.Labels['com.docker.compose.project'])
          .filter((p): p is string => Boolean(p)),
      );

      const dormant = scan.stacks.filter(
        (s) => !activeDirs.has(s.dir) && !activeProjects.has(s.name),
      );

      const formattedContainers = containers.map((c) => ({
        name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
        image: c.Image,
        state: c.State,
        status: c.Status,
        project: c.Labels['com.docker.compose.project'] ?? null,
        ports: c.Ports.map((p) => `${p.IP ?? '*'}:${p.PublicPort ?? ''}->${p.PrivatePort}/${p.Type}`),
      }));

      return {
        summary: `${formattedContainers.length} containers (${formattedContainers.filter((c) => c.state === 'running').length} running), ${dormant.length} dormant stacks`,
        structured: {
          containers: formattedContainers,
          dormant_stacks: dormant,
        },
      };
    },
  });

  registry.registerTool({
    name: 'docker_service_profile',
    toolset: 'docker',
    tier: 'T0',
    description:
      'Deep profile of one container/service ("tell me everything"): redacted compose definition, image digest/version, env keys only, mounts, networks, health, logs summary, NPM/Cloudflare routes, and update check. Read-only. Example: docker_service_profile({ name: "navidrome" }).',
    annotations: {
      title: 'Docker Service Profile',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({ name: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async ({ name }) => {
      if (!deps.docker) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Docker connector is not configured');
      }
      const [inspected, images, logs, scan, npmHosts] = await Promise.all([
        deps.docker.inspectContainer(name),
        deps.docker.listImages(),
        deps.docker.getContainerLogs(name, { tail: 100 }).catch(() => ''),
        deps.agent.call<{
          stacks: Array<{
            name: string;
            dir: string;
            compose_yaml_redacted_source?: string;
            env_files: unknown[];
          }>;
        }>('stacks.scan'),
        deps.npm ? deps.npm.listProxyHosts().catch(() => []) : Promise.resolve([]),
      ]);

      const workingDir = inspected.Config.Labels['com.docker.compose.project.working_dir'];
      const projectName = inspected.Config.Labels['com.docker.compose.project'] ?? inspected.Name;
      const stack = scan.stacks.find((s) => s.dir === workingDir || s.name === projectName);

      const imgObj = images.find((im) => im['Id'] === inspected.Image);
      const repoDigests = Array.isArray(imgObj?.['RepoDigests'])
        ? (imgObj['RepoDigests'] as string[])
        : [];
      const updateInfo = await deps.ociRegistry.checkImageUpdate(
        inspected.Config.Image,
        repoDigests,
      );

      const hostPorts = new Set(
        Object.values(inspected.Ports)
          .flat()
          .filter((p): p is { HostIp: string; HostPort: string } => Boolean(p))
          .map((p) => Number(p.HostPort)),
      );
      const matchingRoutes = npmHosts
        .filter((h) => hostPorts.has(h.forward_port) || h.forward_host === inspected.Name)
        .flatMap((h) => h.domain_names);

      const errorLines = logs
        .split('\n')
        .filter((l) => /\b(err|error|fatal|panic|warn)\b/i.test(l))
        .slice(-20);

      return {
        summary: `${inspected.Name}: ${inspected.State.Status}, image=${inspected.Config.Image}, update=${String(updateInfo.update_available)}, routes=${matchingRoutes.join(', ') || 'none'}`,
        structured: {
          container: inspected,
          update: updateInfo,
          stack_compose: stack?.compose_yaml_redacted_source ?? null,
          env_files: stack?.env_files ?? [],
          routes: matchingRoutes,
          untrusted_log_errors: wrapUntrusted(`docker logs:${inspected.Name}`, errorLines),
        },
      };
    },
  });

  registry.registerTool({
    name: 'docker_logs',
    toolset: 'docker',
    tier: 'T0',
    description:
      'Fetches container stdout/stderr logs with tail/since/until/grep filtering, secret redaction, and untrusted-data fencing. Read-only. Example: docker_logs({ name: "navidrome", tail: 100 }).',
    annotations: {
      title: 'Docker Container Logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        name: z.string().min(1),
        tail: z.number().int().min(1).max(2000).default(200),
        since: z.number().int().optional(),
        until: z.number().int().optional(),
        grep: z.string().optional(),
      })
      .strict(),
    outputSchema: z.object({
      name: z.string(),
      untrusted_source: z.string(),
      untrusted_data: z.string(),
    }),
    handler: async ({ name, tail, since, until, grep }) => {
      if (!deps.docker) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Docker connector is not configured');
      }
      let raw = await deps.docker.getContainerLogs(name, { tail, since, until });
      if (grep) {
        const needle = grep.toLowerCase();
        raw = raw
          .split('\n')
          .filter((l) => l.toLowerCase().includes(needle))
          .join('\n');
      }
      return {
        summary: formatUntrustedText(`docker logs (${name})`, raw || '(empty)'),
        structured: {
          name,
          ...wrapUntrusted(`docker logs (${name})`, raw),
        },
      };
    },
  });

  registry.registerTool({
    name: 'docker_stats',
    toolset: 'docker',
    tier: 'T0',
    description:
      'Returns one-shot CPU and memory stats for running containers (or one named container). Read-only. Example: docker_stats().',
    annotations: {
      title: 'Docker Container Stats',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ name: z.string().optional() }).strict(),
    outputSchema: z.object({
      stats: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async ({ name }) => {
      if (!deps.docker) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Docker connector is not configured');
      }
      const targets = name
        ? [name]
        : (await deps.docker.listContainers(false)).map(
            (c) => c.Names[0]?.replace(/^\//, '') ?? c.Id,
          );
      const stats = await Promise.all(
        targets.map(async (t) => {
          const s = await deps.docker!.getContainerStats(t);
          const mem = (s['memory_stats'] as { usage?: number; limit?: number } | undefined) ?? {};
          return {
            name: t,
            mem_usage_bytes: mem.usage ?? 0,
            mem_limit_bytes: mem.limit ?? 0,
          };
        }),
      );
      return {
        summary: stats.map((s) => `${s.name}: ${Math.round(s.mem_usage_bytes / 1e6)} MB`).join('\n'),
        structured: { stats },
      };
    },
  });

  registry.registerTool({
    name: 'docker_events',
    toolset: 'docker',
    tier: 'T0',
    description:
      'Returns recent Docker engine events (die, oom, restart, health_status) over the last N minutes. Read-only. Example: docker_events({ minutes: 60 }).',
    annotations: {
      title: 'Docker Engine Events',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ minutes: z.number().int().min(1).max(1440).default(60) }).strict(),
    outputSchema: z.object({ events: z.array(z.record(z.string(), z.unknown())) }),
    handler: async ({ minutes }) => {
      if (!deps.docker) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Docker connector is not configured');
      }
      const since = Math.floor(Date.now() / 1000) - minutes * 60;
      const events = await deps.docker.getEvents(since);
      return {
        summary: `${events.length} Docker events in the last ${minutes} minutes`,
        structured: { events },
      };
    },
  });

  registry.registerTool({
    name: 'docker_check_updates',
    toolset: 'docker',
    tier: 'T0',
    description:
      'Compares running container image digests against remote OCI registries (Docker Hub, GHCR, LSIO) to detect available updates. Read-only. Example: docker_check_updates().',
    annotations: {
      title: 'Check Container Image Updates',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    outputSchema: z.object({
      results: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      if (!deps.docker) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Docker connector is not configured');
      }
      const [containers, images] = await Promise.all([
        deps.docker.listContainers(false),
        deps.docker.listImages(),
      ]);
      const results = await Promise.all(
        containers.map(async (c) => {
          const img = images.find((i) => i['Id'] === c.ImageID);
          const digests = Array.isArray(img?.['RepoDigests'])
            ? (img['RepoDigests'] as string[])
            : [];
          const check = await deps.ociRegistry.checkImageUpdate(c.Image, digests);
          return {
            container: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
            ...check,
          };
        }),
      );
      const avail = results.filter((r) => r.update_available === true).length;
      return {
        summary: `Checked ${results.length} containers; ${avail} updates available`,
        structured: { results },
      };
    },
  });

  registry.registerTool({
    name: 'docker_disk_usage',
    toolset: 'docker',
    tier: 'T0',
    description:
      'Reports Docker disk usage breakdown across images, containers, and volumes (`system df`). Read-only. Example: docker_disk_usage().',
    annotations: {
      title: 'Docker Disk Usage',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async () => {
      if (!deps.docker) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Docker connector is not configured');
      }
      const df = await deps.docker.getSystemDf();
      const images = Array.isArray(df['Images']) ? df['Images'].length : 0;
      const volumes = Array.isArray(df['Volumes']) ? df['Volumes'].length : 0;
      return {
        summary: `Docker DF: ${images} images, ${volumes} volumes`,
        structured: df,
      };
    },
  });

  registry.registerTool({
    name: 'docker_container_action',
    toolset: 'docker',
    tier: 'T2',
    description:
      'Starts, stops, or restarts a Docker container. Protected containers require T3 passkey confirmation + override_protected=true; plan-first when plan_id is omitted.',
    annotations: {
      title: 'Docker Container Action',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        name: z.string().min(1),
        action: z.enum(['start', 'stop', 'restart']),
        override_protected: z.boolean().default(false),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const tier = args.override_protected ? 'T3' : 'T2';
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'docker_container_action',
          tier,
          payload: { name: args.name, action: args.action, override_protected: args.override_protected },
          summary: `Execute docker ${args.action} on "${args.name}"`,
          diff: `container ${args.name}: ${args.action}`,
          sideEffects: [`Container "${args.name}" will ${args.action}`],
          rollback: [`Run docker_container_action(${args.name}, ${args.action === 'stop' ? 'start' : 'restart'})`],
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
        expectedTool: 'docker_container_action',
        tier,
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
      const p = gate.plan.payload as { name: string; action: string; override_protected?: boolean };
      const res = await deps.agent.call<{ name: string; action: string; ok: boolean }>(
        'docker.container_action',
        { name: p.name, action: p.action, override_protected: Boolean(p.override_protected) },
      );
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Executed ${res.action} on container ${res.name}`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'docker_update_service',
    toolset: 'docker',
    tier: 'T2',
    description:
      'Safely updates a Compose service with 120s health gate and automatic rollback to prior image digest on failure. Pass only stack_dir + service first to generate a plan, then re-call with plan_id after confirmation.',
    annotations: {
      title: 'Update Docker Service (With Rollback)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        stack_dir: z.string().min(1),
        service: z.string().min(1),
        target_image: z.string().optional(),
        health_timeout_seconds: z.number().int().min(5).max(300).default(120),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'docker_update_service',
          tier: 'T2',
          payload: {
            stack_dir: args.stack_dir,
            service: args.service,
            target_image: args.target_image,
            health_timeout_seconds: args.health_timeout_seconds,
          },
          summary: `Pull & recreate ${args.service} in ${args.stack_dir} (auto-rollback if healthcheck fails within ${args.health_timeout_seconds}s)`,
          diff: `service ${args.service}: compose pull -> up -d -> ${args.health_timeout_seconds}s health gate`,
          sideEffects: [`Brief restart of service "${args.service}"`],
          rollback: ['Automatic revert to previous image digest if health gate fails'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Update plan ${plan.id} ready; confirm at ${publicUrl}/confirm/${chal.id}`,
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
        expectedTool: 'docker_update_service',
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

      const p = gate.plan.payload as {
        stack_dir: string;
        service: string;
        target_image?: string;
        health_timeout_seconds?: number;
      };
      const res = await deps.agent.call<{
        service: string;
        previous_digests: Record<string, string>;
        updated: boolean;
        rolled_back: boolean;
        reason?: string;
      }>('docker.compose_update', p);
      deps.plans.markApplied(gate.plan.id);

      if (res.rolled_back) {
        await deps.watcher.sendOrQueueNotification({
          title: `Update Rolled Back: ${res.service}`,
          message: res.reason ?? 'Health gate failed after update',
          priority: 4,
          tags: ['warning', 'docker'],
        });
      }

      return {
        summary: res.rolled_back
          ? `Update for ${res.service} ROLLED BACK: ${res.reason ?? 'health gate failed'}`
          : `Service ${res.service} updated and passed health gate`,
        structured: { applied: true, status: res.rolled_back ? 'rolled_back' : 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'docker_rollback_service',
    toolset: 'docker',
    tier: 'T2',
    description:
      'Rolls back a Docker Compose service to a specified previous image digest (plan-first if plan_id omitted).',
    annotations: {
      title: 'Rollback Docker Service',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        stack_dir: z.string().min(1),
        service: z.string().min(1),
        previous_image: z.string().min(1),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'docker_rollback_service',
          tier: 'T2',
          payload: { stack_dir: args.stack_dir, service: args.service, target_image: args.previous_image },
          summary: `Rollback ${args.service} to ${args.previous_image}`,
          diff: `service ${args.service} -> ${args.previous_image}`,
          sideEffects: [`Restarts ${args.service} on pinned prior image`],
          rollback: ['Re-run docker_update_service'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Rollback plan ${plan.id} created`,
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
        expectedTool: 'docker_rollback_service',
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
      const p = gate.plan.payload;
      const res = await deps.agent.call<Record<string, unknown>>('docker.compose_update', p);
      deps.plans.markApplied(gate.plan.id);
      const svcName = typeof p['service'] === 'string' ? p['service'] : '';
      return {
        summary: `Rolled back ${svcName}`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'docker_prune_plan',
    toolset: 'docker',
    tier: 'T0',
    description:
      'Previews Docker prune (stopped containers, dangling images, unused networks; NEVER volumes) and creates a plan_id for docker_prune_apply. Read-only.',
    annotations: {
      title: 'Plan Docker Prune',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ include_build_cache: z.boolean().default(false) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const preview = await deps.agent.call<{ applied: boolean; reclaimed_summary: string }>(
        'docker.prune',
        { apply: false, include_build_cache: args.include_build_cache },
      );
      const plan = deps.plans.createPlan({
        tool: 'docker_prune_apply',
        tier: 'T2',
        payload: { include_build_cache: args.include_build_cache },
        summary: `Prune unused Docker containers, dangling images, and unused networks${args.include_build_cache ? ' + build cache' : ''} (volumes untouched)`,
        diff: preview.reclaimed_summary,
        sideEffects: ['Removes stopped containers and dangling images'],
        rollback: ['Pull images again if needed (volumes are never pruned)'],
        createdBy: ctx.auth.subject,
      });
      const chal = deps.confirmations.createChallenge(plan.id, 'url');
      const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
      return {
        summary: `Docker prune plan ${plan.id} created; confirm at ${publicUrl}/confirm/${chal.id}`,
        structured: {
          plan_id: plan.id,
          confirmation_id: chal.id,
          confirm_url: `${publicUrl}/confirm/${chal.id}`,
          preview: preview.reclaimed_summary,
        },
        planId: plan.id,
        confirmationId: chal.id,
      };
    },
  });

  registry.registerTool({
    name: 'docker_prune_apply',
    toolset: 'docker',
    tier: 'T2',
    description: 'Executes a confirmed Docker prune plan (never deletes volumes).',
    annotations: {
      title: 'Apply Docker Prune',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({ plan_id: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'docker_prune_apply',
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
      const p = gate.plan.payload as { include_build_cache?: boolean };
      const res = await deps.agent.call<{ applied: boolean; reclaimed_summary: string }>(
        'docker.prune',
        { apply: true, include_build_cache: Boolean(p.include_build_cache) },
      );
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Docker prune completed`,
        structured: { status: 'applied', reclaimed_summary: res.reclaimed_summary, applied: true },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
