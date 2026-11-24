import * as z from 'zod/v4';
import { parseDurationMs } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

export function registerBackupModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'backup_status',
    toolset: 'backup',
    tier: 'T0',
    description:
      'Reports backup freshness per configured set against RPO, last restore test status, and R2 repository size vs budget. Read-only. Example: backup_status({ set: "vaultwarden" }).',
    annotations: {
      title: 'Backup Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ set: z.string().optional() }).strict(),
    outputSchema: z.object({
      sets: z.record(z.string(), z.unknown()),
      repo_size_bytes: z.number(),
      budget_bytes: z.number(),
      within_budget: z.boolean(),
    }),
    handler: async ({ set }) => {
      const data = await deps.agent.call<{
        status: Record<string, Record<string, unknown>>;
        stats: { total_size?: number };
      }>('backup.read_status');

      const configured = deps.config.modules.backup?.sets ?? {};
      const budget = deps.config.modules.backup?.budgetBytes ?? 7_000_000_000;
      const totalSize = Number(data.stats.total_size ?? 0);
      const nowMs = Date.now();

      const outSets: Record<string, unknown> = {};
      const keys = set ? [set] : Object.keys({ ...configured, ...data.status });
      for (const k of keys) {
        if (k === '_maintenance') {
          outSets[k] = data.status[k];
          continue;
        }
        const entry = data.status[k] ?? {};
        const lastSuccess =
          typeof entry['last_success'] === 'string' ? entry['last_success'] : undefined;
        const ageSec = lastSuccess ? Math.floor((nowMs - Date.parse(lastSuccess)) / 1000) : null;
        const rpoExpr = configured[k]?.rpo;
        const rpoSec = rpoExpr ? Math.floor(parseDurationMs(rpoExpr) / 1000) : null;
        const stale =
          entry['last_status'] !== 'success' ||
          ageSec === null ||
          (rpoSec !== null && ageSec > rpoSec);

        outSets[k] = {
          ...entry,
          age_seconds: ageSec,
          rpo_seconds: rpoSec,
          stale,
        };
      }

      return {
        summary: `Backup repo size ${Math.round(totalSize / 1e6)} MB / ${Math.round(budget / 1e6)} MB budget`,
        structured: {
          sets: outSets,
          repo_size_bytes: totalSize,
          budget_bytes: budget,
          within_budget: totalSize <= budget,
        },
      };
    },
  });

  registry.registerTool({
    name: 'backup_snapshots',
    toolset: 'backup',
    tier: 'T0',
    description:
      'Lists restic backup snapshots from the exported snapshots.json metadata. Optionally filters by backup set tag. Read-only. Example: backup_snapshots({ set: "vaultwarden" }).',
    annotations: {
      title: 'List Backup Snapshots',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        set: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    outputSchema: z.object({
      snapshots: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async ({ set, limit }) => {
      const data = await deps.agent.call<{
        snapshots: Array<{ id?: string; time?: string; tags?: string[]; paths?: string[] }>;
      }>('backup.read_status');
      let snaps = data.snapshots;
      if (set) {
        snaps = snaps.filter((s) => s.tags?.includes(`set=${set}`));
      }
      snaps = snaps.slice(-limit).reverse();
      return {
        summary: `Returned ${snaps.length} snapshots`,
        structured: { snapshots: snaps },
      };
    },
  });
}
