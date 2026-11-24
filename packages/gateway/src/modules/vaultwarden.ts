import * as z from 'zod/v4';
import { HomemcpError, parseDurationMs } from '@homemcp/core';
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
        deps.docker
          ? deps.docker.inspectContainer(containerName).catch(() => null)
          : Promise.resolve(null),
        deps.agent
          .call<{ status: Record<string, Record<string, unknown>> }>('backup.read_status')
          .catch(() => emptyBackup),
        deps.agent
          .call<{ stacks: Array<{ name: string; compose_yaml_redacted_source?: string }> }>(
            'stacks.scan',
          )
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

  registry.registerTool({
    name: 'vaultwarden_backup_status',
    toolset: 'vaultwarden',
    tier: 'T0',
    description:
      'Reports dedicated Vaultwarden backup freshness vs RPO, snapshot count, latest restore-test SQLite cipher check, schedule (every 6h), retention policy, and repo budget. Read-only. Never reads vault contents.',
    annotations: {
      title: 'Vaultwarden Backup Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      set: z.literal('vaultwarden'),
      last_status: z.string(),
      last_success: z.string().nullable(),
      last_snapshot: z.string().nullable(),
      last_bytes_added: z.number().nullable(),
      age_seconds: z.number().nullable(),
      rpo_seconds: z.number(),
      stale: z.boolean(),
      snapshot_count: z.number().int(),
      last_restore_test: z.record(z.string(), z.unknown()).nullable(),
      repo_size_bytes: z.number(),
      budget_bytes: z.number(),
      within_budget: z.boolean(),
      schedule: z.string(),
      retention_policy: z.string(),
      includes: z.array(z.string()),
    }),
    handler: async () => {
      const data = await deps.agent.call<{
        status: Record<string, Record<string, unknown>>;
        snapshots: Array<{ id?: string; time?: string; tags?: string[] }>;
        stats: { total_size?: number };
      }>('backup.read_status');

      const vw = data.status['vaultwarden'] ?? {};
      const lastSuccess = typeof vw['last_success'] === 'string' ? vw['last_success'] : null;
      const ageSec = lastSuccess ? Math.floor((Date.now() - Date.parse(lastSuccess)) / 1000) : null;
      const rpoExpr = deps.config.modules.backup?.sets['vaultwarden']?.rpo ?? '24h';
      const rpoSec = Math.floor(parseDurationMs(rpoExpr) / 1000);
      const lastStatus = typeof vw['last_status'] === 'string' ? vw['last_status'] : 'missing';
      const stale = lastStatus !== 'success' || ageSec === null || ageSec > rpoSec;

      const vwSnaps = data.snapshots.filter((s) => s.tags?.includes('set=vaultwarden'));
      const totalSize = Number(data.stats.total_size ?? 0);
      const budget = deps.config.modules.backup?.budgetBytes ?? 7_000_000_000;
      const lastRestore =
        vw['last_restore_test'] && typeof vw['last_restore_test'] === 'object'
          ? (vw['last_restore_test'] as Record<string, unknown>)
          : null;

      return {
        summary: `Vaultwarden backup: status=${lastStatus}, snapshots=${vwSnaps.length}, stale=${String(stale)}, repo=${Math.round(totalSize / 1e6)}MB/${Math.round(budget / 1e6)}MB`,
        structured: {
          set: 'vaultwarden' as const,
          last_status: lastStatus,
          last_success: lastSuccess,
          last_snapshot: typeof vw['last_snapshot'] === 'string' ? vw['last_snapshot'] : null,
          last_bytes_added:
            typeof vw['last_bytes_added'] === 'number' ? vw['last_bytes_added'] : null,
          age_seconds: ageSec,
          rpo_seconds: rpoSec,
          stale,
          snapshot_count: vwSnaps.length,
          last_restore_test: lastRestore,
          repo_size_bytes: totalSize,
          budget_bytes: budget,
          within_budget: totalSize <= budget,
          schedule: 'Every 6 hours (00:15, 06:15, 12:15, 18:15)',
          retention_policy: 'keep-last 4, keep-daily 14, keep-weekly 8, keep-monthly 12',
          includes: [
            'db.sqlite3 (consistent backup)',
            'rsa_key*',
            'config.json',
            'attachments/',
            'sends/',
          ],
        },
      };
    },
  });

  registry.registerTool({
    name: 'vaultwarden_backup_snapshots',
    toolset: 'vaultwarden',
    tier: 'T0',
    description:
      'Lists Restic encrypted snapshots specifically for Vaultwarden (newest first) with snapshot IDs and timestamps. Read-only.',
    annotations: {
      title: 'List Vaultwarden Backups',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(30) }).strict(),
    outputSchema: z.object({
      count: z.number().int(),
      snapshots: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async ({ limit }) => {
      const data = await deps.agent.call<{
        snapshots: Array<{ id?: string; time?: string; tags?: string[]; paths?: string[] }>;
      }>('backup.read_status');
      const snaps = data.snapshots
        .filter((s) => s.tags?.includes('set=vaultwarden'))
        .slice(-limit)
        .reverse();
      return {
        summary: `${snaps.length} Vaultwarden backup snapshot(s) found`,
        structured: {
          count: snaps.length,
          snapshots: snaps,
        },
      };
    },
  });

  registry.registerTool({
    name: 'vaultwarden_backup_run',
    toolset: 'vaultwarden',
    tier: 'T1',
    description:
      'Runs an immediate consistent Vaultwarden backup (`db.sqlite3`, RSA keys, config, attachments, sends) to R2 via homemcpd as a tracked job.',
    annotations: {
      title: 'Run Vaultwarden Backup',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    outputSchema: z.object({
      job_id: z.string(),
      set: z.literal('vaultwarden'),
      status: z.string(),
      exit_code: z.number().int(),
    }),
    handler: async (_args, ctx) => {
      let exitCode = 1;
      const job = deps.jobs.startBackground(
        'vaultwarden_backup_run',
        ctx.auth.subject,
        async (jctx) => {
          await jctx.addStep('Running consistent Vaultwarden Restic backup', 20);
          const res = await deps.agent.call<{ set: string; exit_code: number; output: string }>(
            'backup.run',
            { set: 'vaultwarden' },
          );
          exitCode = res.exit_code;
          if (res.exit_code !== 0) {
            throw new Error(`Vaultwarden backup failed: ${res.output}`);
          }
          await jctx.setProgress(100, 'Vaultwarden backup uploaded and verified');
          return res;
        },
      );
      await deps.jobs.waitForJob(job.id);
      const finalJob = deps.jobs.getJob(job.id)!;
      return {
        summary: `Vaultwarden backup ${finalJob.status} (job ${job.id})`,
        structured: {
          job_id: job.id,
          set: 'vaultwarden' as const,
          status: finalJob.status,
          exit_code: exitCode,
        },
        jobId: job.id,
      };
    },
  });

  registry.registerTool({
    name: 'vaultwarden_backup_test',
    toolset: 'vaultwarden',
    tier: 'T1',
    description:
      'Restores a Vaultwarden snapshot into a temporary directory, runs SQLite PRAGMA integrity_check, compares cipher/user counts against the live DB, and cleans up.',
    annotations: {
      title: 'Verify Vaultwarden Backup',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        snapshot_id: z
          .string()
          .regex(/^(?:latest|[a-f0-9]{6,64})$/)
          .default('latest'),
      })
      .strict(),
    outputSchema: z.object({
      job_id: z.string(),
      snapshot_id: z.string(),
      status: z.string(),
      exit_code: z.number().int(),
      output: z.string(),
    }),
    handler: async (args, ctx) => {
      let exitCode = 1;
      let output = '';
      const job = deps.jobs.startBackground(
        'vaultwarden_backup_test',
        ctx.auth.subject,
        async (jctx) => {
          await jctx.addStep(
            `Testing restore integrity of Vaultwarden snapshot ${args.snapshot_id}`,
            25,
          );
          const res = await deps.agent.call<{ set: string; exit_code: number; output: string }>(
            'backup.restore_test',
            { set: 'vaultwarden', snapshot_id: args.snapshot_id },
          );
          exitCode = res.exit_code;
          output = res.output;
          if (res.exit_code !== 0) {
            throw new Error(`Vaultwarden restore test failed: ${res.output}`);
          }
          return res;
        },
      );
      await deps.jobs.waitForJob(job.id);
      const finalJob = deps.jobs.getJob(job.id)!;
      return {
        summary: `Vaultwarden restore test (${args.snapshot_id}) ${finalJob.status}`,
        structured: {
          job_id: job.id,
          snapshot_id: args.snapshot_id,
          status: finalJob.status,
          exit_code: exitCode,
          output,
        },
        jobId: job.id,
      };
    },
  });

  registry.registerTool({
    name: 'vaultwarden_backup_restore_staging',
    toolset: 'vaultwarden',
    tier: 'T3',
    description:
      'Restores a Vaultwarden snapshot strictly to an isolated staging directory for inspection or manual recovery (never overwrites live Vaultwarden data). Requires T3 passkey confirmation.',
    annotations: {
      title: 'Restore Vaultwarden Snapshot to Staging',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        snapshot_id: z
          .string()
          .regex(/^(?:latest|[a-f0-9]{6,64})$/)
          .default('latest'),
        staging_subdir: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,40}$/)
          .default('vw-recovery'),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const stagingTarget = `/var/lib/homemcp/backup/staging-restore/${args.staging_subdir}`;
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'vaultwarden_backup_restore_staging',
          tier: 'T3',
          payload: {
            snapshot_id: args.snapshot_id,
            staging_subdir: args.staging_subdir,
            staging_target: stagingTarget,
          },
          summary: `Restore Vaultwarden snapshot "${args.snapshot_id}" strictly to staging ${stagingTarget} (live vault untouched)`,
          diff: `restic restore ${args.snapshot_id} (set=vaultwarden) -> ${stagingTarget} + PRAGMA integrity_check`,
          sideEffects: [`Writes restored Vaultwarden files into ${stagingTarget}`],
          rollback: [`Delete staging dir ${stagingTarget} when finished`],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Vaultwarden staging restore plan ${plan.id} requires passkey confirmation at ${publicUrl}/confirm/${chal.id}`,
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
        expectedTool: 'vaultwarden_backup_restore_staging',
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
      const p = gate.plan.payload as {
        snapshot_id: string;
        staging_subdir: string;
        staging_target: string;
      };
      const res = await deps.agent.call<{
        set: string;
        snapshot_id: string;
        staging_target: string;
        exit_code: number;
        output: string;
      }>('backup.restore_staging', {
        set: 'vaultwarden',
        snapshot_id: p.snapshot_id,
        staging_subdir: p.staging_subdir,
      });
      if (res.exit_code !== 0) {
        throw new HomemcpError('INTERNAL_ERROR', `Staging restore failed: ${res.output}`);
      }
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Restored Vaultwarden (${p.snapshot_id}) to staging ${p.staging_target}`,
        structured: {
          applied: true,
          status: 'applied',
          snapshot_id: res.snapshot_id,
          staging_target: res.staging_target,
          output: res.output,
        },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'vaultwarden_backup_prune_plan',
    toolset: 'vaultwarden',
    tier: 'T0',
    description:
      'Runs a dry-run retention check (`restic forget --dry-run`) on Vaultwarden snapshots and returns a plan_id to confirm pruning old snapshots.',
    annotations: {
      title: 'Plan Vaultwarden Backup Prune',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (_args, ctx) => {
      const preview = await deps.agent.call<{
        set: string;
        dry_run: boolean;
        exit_code: number;
        output: string;
      }>('backup.prune_set', { set: 'vaultwarden', dry_run: true });
      const plan = deps.plans.createPlan({
        tool: 'vaultwarden_backup_prune_apply',
        tier: 'T2',
        payload: { set: 'vaultwarden' },
        summary:
          'Apply Vaultwarden retention policy (keep-last 4, daily 14, weekly 8, monthly 12) and prune expired packs',
        diff: preview.output,
        sideEffects: ['Deletes expired Vaultwarden snapshots beyond retention window from R2'],
        rollback: ['Expired snapshot data removed by restic prune cannot be recovered'],
        createdBy: ctx.auth.subject,
      });
      const chal = deps.confirmations.createChallenge(plan.id, 'url');
      const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
      return {
        summary: `Vaultwarden prune plan ${plan.id} created; confirm at ${publicUrl}/confirm/${chal.id}`,
        structured: {
          plan_id: plan.id,
          confirmation_id: chal.id,
          confirm_url: `${publicUrl}/confirm/${chal.id}`,
          preview: preview.output,
        },
        planId: plan.id,
        confirmationId: chal.id,
      };
    },
  });

  registry.registerTool({
    name: 'vaultwarden_backup_prune_apply',
    toolset: 'vaultwarden',
    tier: 'T2',
    description: 'Executes a confirmed Vaultwarden retention prune plan via homemcpd.',
    annotations: {
      title: 'Apply Vaultwarden Backup Prune',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({ plan_id: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'vaultwarden_backup_prune_apply',
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
      const res = await deps.agent.call<{
        set: string;
        dry_run: boolean;
        exit_code: number;
        output: string;
      }>('backup.prune_set', { set: 'vaultwarden', dry_run: false });
      if (res.exit_code !== 0) {
        throw new HomemcpError('INTERNAL_ERROR', `Vaultwarden prune failed: ${res.output}`);
      }
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: 'Applied Vaultwarden retention policy and pruned expired snapshots',
        structured: {
          applied: true,
          status: 'applied',
          output: res.output,
        },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
