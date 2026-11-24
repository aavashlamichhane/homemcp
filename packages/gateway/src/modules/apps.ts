import * as z from 'zod/v4';
import type { GatewayDeps } from '../server/factory.js';

export function registerAppsModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'apps_health',
    toolset: 'apps',
    tier: 'T0',
    description:
      'Runs configured HTTP health checks against self-hosted web apps (e.g., filebrowser, naviload, wordchain, browser-savepoint). Read-only. Example: apps_health().',
    annotations: {
      title: 'Self-Hosted Apps Health',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      checks: z.array(
        z.object({
          name: z.string(),
          url: z.string(),
          ok: z.boolean(),
          status_code: z.number().optional(),
          latency_ms: z.number(),
          error: z.string().optional(),
        }),
      ),
    }),
    handler: async () => {
      const configured = deps.config.modules.apps?.checks ?? [];
      const checks = await Promise.all(
        configured.map(async (chk) => {
          const res = await deps.httpProbe.probe(chk.url, { timeoutMs: 5_000 });
          return {
            name: chk.name,
            url: chk.url,
            ok: res.ok,
            ...(res.status_code !== undefined ? { status_code: res.status_code } : {}),
            latency_ms: res.latency_ms,
            ...(res.error ? { error: res.error } : {}),
          };
        }),
      );
      const okCount = checks.filter((c) => c.ok).length;
      return {
        summary: `${okCount}/${checks.length} apps healthy`,
        structured: { checks },
      };
    },
  });
}
