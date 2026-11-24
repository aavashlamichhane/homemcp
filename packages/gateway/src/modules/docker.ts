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
}
