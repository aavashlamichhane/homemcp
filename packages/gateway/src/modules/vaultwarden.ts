import * as z from 'zod/v4';
import { HomemcpError } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

export function registerVaultwardenModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'vaultwarden_health',
    toolset: 'vaultwarden',
    tier: 'T0',
    description:
      'Checks Vaultwarden /alive endpoint, version vs upstream release, signups/admin-panel disabled flags, DOMAIN match against publicUrl, and backup freshness. Never reads vault contents. Read-only. Example: vaultwarden_health().',
    annotations: {
      title: 'Vaultwarden Health',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async () => {
      if (!deps.vaultwarden) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Vaultwarden connector is not configured');
      }
      const containerName = deps.config.modules.vaultwarden?.container ?? 'vaultwarden';
      const emptyBackup: { status: Record<string, Record<string, unknown>> } = { status: {} };
      const [inspected, backupData, stacksScan] = await Promise.all([
        deps.docker ? deps.docker.inspectContainer(containerName).catch(() => null) : Promise.resolve(null),
        deps.agent
          .call<{ status: Record<string, Record<string, unknown>> }>('backup.read_status')
          .catch(() => emptyBackup),
        deps.agent
          .call<{ stacks: Array<{ name: string; compose_yaml_redacted_source?: string }> }>('stacks.scan')
          .catch(() => ({ stacks: [] })),
      ]);

      const vwStack = stacksScan.stacks.find((s) => s.name.includes('vaultwarden'));
      const domainMatch = vwStack?.compose_yaml_redacted_source
        ? /DOMAIN:\s*['"]?([^'"\s\n]+)/.exec(vwStack.compose_yaml_redacted_source)?.[1]
        : deps.config.modules.vaultwarden?.publicUrl;

      const health = await deps.vaultwarden.checkHealth({
        ...(inspected?.Config.Labels ? { containerLabels: inspected.Config.Labels } : {}),
        ...(inspected?.Config.EnvKeys ? { containerEnvKeys: inspected.Config.EnvKeys } : {}),
        configuredDomain: domainMatch,
      });

      const vwBackup = backupData.status['vaultwarden'] ?? null;
      return {
        summary: `Vaultwarden alive=${String(health.alive)}, version=${health.version ?? 'unknown'}, admin_disabled=${String(health.admin_panel_disabled)}, domain_ok=${String(health.domain_matches_public_url)}`,
        structured: {
          ...health,
          backup: vwBackup,
        },
      };
    },
  });
}
