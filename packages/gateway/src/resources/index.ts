import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HomemcpError } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

function resolveRunbooksDir(): string {
  const candidates = [
    path.resolve(import.meta.dirname, '../../../../docs/runbooks'),
    path.resolve(import.meta.dirname, '../../../docs/runbooks'),
    path.resolve(process.cwd(), 'docs/runbooks'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function registerResources(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerResource({
    name: 'overview',
    uri: 'homemcp://overview',
    title: 'Server Overview',
    description: 'Snapshot of host health, containers, disks, and backups',
    mimeType: 'application/json',
    handler: async () => {
      const [health, disks, backup] = await Promise.all([
        deps.agent.call('system.health'),
        deps.agent.call('system.disks'),
        deps.agent.call('backup.read_status'),
      ]);
      return JSON.stringify({ health, disks, backup }, null, 2);
    },
  });

  registry.registerResource({
    name: 'system-health',
    uri: 'homemcp://system/health',
    title: 'System Health',
    description: 'Latest host health snapshot',
    mimeType: 'application/json',
    handler: async () => JSON.stringify(await deps.agent.call('system.health'), null, 2),
  });

  registry.registerResource({
    name: 'docker-services',
    uri: 'homemcp://docker/services',
    title: 'Docker Services',
    description: 'Running containers and scanned stacks',
    mimeType: 'application/json',
    handler: async () => {
      const [containers, scan] = await Promise.all([
        deps.docker ? deps.docker.listContainers(true) : Promise.resolve([]),
        deps.agent.call('stacks.scan'),
      ]);
      return JSON.stringify({ containers, scan }, null, 2);
    },
  });

  registry.registerResource({
    name: 'stack-compose',
    template: 'homemcp://stacks/{name}/compose',
    list: async () => {
      const scan = await deps.agent.call<{ stacks: Array<{ name: string }> }>('stacks.scan');
      return {
        resources: scan.stacks.map((s) => ({
          uri: `homemcp://stacks/${s.name}/compose`,
          name: `${s.name} compose`,
        })),
      };
    },
    title: 'Stack Compose File',
    description: 'Redacted Docker Compose YAML for a stack',
    mimeType: 'text/yaml',
    handler: async (_uri, vars) => {
      const scan = await deps.agent.call<{
        stacks: Array<{ name: string; compose_yaml_redacted_source?: string }>;
      }>('stacks.scan');
      const found = scan.stacks.find((s) => s.name === vars['name']);
      if (!found?.compose_yaml_redacted_source) {
        throw new HomemcpError('NOT_FOUND', `Stack compose not found: ${vars['name'] ?? ''}`);
      }
      return found.compose_yaml_redacted_source;
    },
  });

  registry.registerResource({
    name: 'network-routes',
    uri: 'homemcp://network/routes',
    title: 'Network Routes',
    description: 'NPM proxy hosts, Cloudflare tunnel ingress, and DNS records',
    mimeType: 'application/json',
    handler: async () => {
      const [hosts, ingress, dns] = await Promise.all([
        deps.npm ? deps.npm.listProxyHosts().catch(() => []) : Promise.resolve([]),
        deps.cloudflare
          ? deps.cloudflare.getTunnelConfig().catch(() => null)
          : Promise.resolve(null),
        deps.cloudflare ? deps.cloudflare.listDnsRecords().catch(() => []) : Promise.resolve([]),
      ]);
      return JSON.stringify({ hosts, ingress, dns }, null, 2);
    },
  });

  registry.registerResource({
    name: 'backup-status',
    uri: 'homemcp://backup/status',
    title: 'Backup Status',
    description: 'Restic backup status, snapshots, and repository statistics',
    mimeType: 'application/json',
    handler: async () => JSON.stringify(await deps.agent.call('backup.read_status'), null, 2),
  });

  registry.registerResource({
    name: 'audit-recent',
    uri: 'homemcp://audit/recent',
    title: 'Recent Audit Entries',
    description: 'Last 100 homemcp audit entries',
    mimeType: 'application/json',
    scope: 'homemcp:audit',
    handler: () => Promise.resolve(JSON.stringify(deps.db.queryAudit({ limit: 100 }), null, 2)),
  });

  registry.registerResource({
    name: 'alerts-open',
    uri: 'homemcp://alerts/open',
    title: 'Open Alerts',
    description: 'Currently pending and firing alerts evaluated by homemcp watcher',
    mimeType: 'application/json',
    handler: () =>
      Promise.resolve(JSON.stringify(deps.watcher.listAlerts({ includeResolved: false }), null, 2)),
  });

  registry.registerResource({
    name: 'docs-runbooks',
    template: 'homemcp://docs/runbooks/{topic}',
    title: 'Operational Runbooks',
    description:
      'Emergency & operational Markdown runbooks (restore-vaultwarden, rotate-tunnel-token, add-service, disk-full, break-glass)',
    mimeType: 'text/markdown',
    list: () => {
      const dir = resolveRunbooksDir();
      const files = existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.md'))
            .map((f) => f.replace(/\.md$/, ''))
        : [];
      return Promise.resolve({
        resources: files.map((topic) => ({
          uri: `homemcp://docs/runbooks/${topic}`,
          name: `Runbook: ${topic}`,
        })),
      });
    },
    handler: (_uri, vars) => {
      const topic = (vars['topic'] ?? '').replace(/[^a-z0-9-]/gi, '');
      const file = path.join(resolveRunbooksDir(), `${topic}.md`);
      if (!topic || !existsSync(file)) {
        throw new HomemcpError('NOT_FOUND', `Runbook not found: ${topic}`);
      }
      return Promise.resolve(readFileSync(file, 'utf8'));
    },
  });
}
