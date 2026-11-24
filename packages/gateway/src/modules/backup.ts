import * as z from 'zod/v4';
import { HomemcpError, parseDurationMs } from '@homemcp/core';
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

  registry.registerTool({
    name: 'backup_run',
    toolset: 'backup',
    tier: 'T1',
    description:
      'Runs an on-demand restic backup for one configured set or "all" via homemcpd as a tracked background job.',
    annotations: {
      title: 'Run Restic Backup',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        set: z.enum([
          'vaultwarden',
          'configs',
          'npm',
          'navidrome',
          'system',
          'jellyfin',
          'userdata',
          'all',
        ]),
      })
      .strict(),
    outputSchema: z.object({
      job_id: z.string(),
      set: z.string(),
      status: z.string(),
      exit_code: z.number().int(),
    }),
    handler: async (args, ctx) => {
      let exitCode = 1;
      const job = deps.jobs.startBackground('backup_run', ctx.auth.subject, async (jctx) => {
        await jctx.addStep(`Starting backup set "${args.set}"`, 15);
        const res = await deps.agent.call<{ set: string; exit_code: number; output: string }>(
          'backup.run',
          { set: args.set },
        );
        exitCode = res.exit_code;
        if (res.exit_code !== 0) {
          throw new Error(`Backup failed (exit ${res.exit_code}): ${res.output}`);
        }
        await jctx.setProgress(100, `Backup "${args.set}" finished`);
        return res;
      });
      await deps.jobs.waitForJob(job.id);
      const finalJob = deps.jobs.getJob(job.id)!;
      return {
        summary: `Backup set "${args.set}" ${finalJob.status} (job ${job.id})`,
        structured: {
          job_id: job.id,
          set: args.set,
          status: finalJob.status,
          exit_code: exitCode,
        },
        jobId: job.id,
      };
    },
  });

  registry.registerTool({
    name: 'backup_verify',
    toolset: 'backup',
    tier: 'T1',
    description: 'Runs restic repository maintenance and integrity check (`homemcp-backup maint`) as a tracked job.',
    annotations: {
      title: 'Verify Backup Repository',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    outputSchema: z.object({
      job_id: z.string(),
      status: z.string(),
      exit_code: z.number().int(),
    }),
    handler: async (_args, ctx) => {
      let exitCode = 1;
      const job = deps.jobs.startBackground('backup_verify', ctx.auth.subject, async (jctx) => {
        await jctx.addStep('Running restic check & forget/prune', 20);
        const res = await deps.agent.call<{ exit_code: number; output: string }>('backup.verify');
        exitCode = res.exit_code;
        if (res.exit_code !== 0) {
          throw new Error(`Verify failed (exit ${res.exit_code}): ${res.output}`);
        }
        return res;
      });
      await deps.jobs.waitForJob(job.id);
      const finalJob = deps.jobs.getJob(job.id)!;
      return {
        summary: `Backup verification ${finalJob.status} (job ${job.id})`,
        structured: { job_id: job.id, status: finalJob.status, exit_code: exitCode },
        jobId: job.id,
      };
    },
  });

  registry.registerTool({
    name: 'backup_restore_test',
    toolset: 'backup',
    tier: 'T1',
    description:
      'Runs an automated temporary restore integrity test for Vaultwarden (`homemcp-backup restore-test vaultwarden`).',
    annotations: {
      title: 'Test Backup Restore',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ set: z.enum(['vaultwarden']).default('vaultwarden') }).strict(),
    outputSchema: z.object({
      job_id: z.string(),
      set: z.string(),
      status: z.string(),
      exit_code: z.number().int(),
      output: z.string(),
    }),
    handler: async (args, ctx) => {
      let exitCode = 1;
      let output = '';
      const job = deps.jobs.startBackground('backup_restore_test', ctx.auth.subject, async (jctx) => {
        await jctx.addStep(`Running temporary restore test for ${args.set}`, 25);
        const res = await deps.agent.call<{ set: string; exit_code: number; output: string }>(
          'backup.restore_test',
          { set: args.set },
        );
        exitCode = res.exit_code;
        output = res.output;
        if (res.exit_code !== 0) {
          throw new Error(`Restore test failed: ${res.output}`);
        }
        return res;
      });
      await deps.jobs.waitForJob(job.id);
      const finalJob = deps.jobs.getJob(job.id)!;
      return {
        summary: `Restore test (${args.set}) ${finalJob.status}`,
        structured: {
          job_id: job.id,
          set: args.set,
          status: finalJob.status,
          exit_code: exitCode,
          output,
        },
        jobId: job.id,
      };
    },
  });

  registry.registerTool({
    name: 'backup_restore',
    toolset: 'backup',
    tier: 'T3',
    description:
      'Restores a backup snapshot strictly into an isolated staging directory (never overwrites live data). Requires T3 passkey confirmation.',
    annotations: {
      title: 'Restore Backup to Staging',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        set: z.enum(['vaultwarden', 'configs', 'npm', 'navidrome', 'system', 'jellyfin', 'userdata']),
        staging_subdir: z.string().regex(/^[A-Za-z0-9_.-]+$/).default('manual-restore'),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const stagingTarget = `/var/lib/homemcp/backup/staging-restore/${args.staging_subdir}`;
      if (stagingTarget.includes('..') || !stagingTarget.startsWith('/var/lib/homemcp/backup/staging-restore/')) {
        throw new HomemcpError('POLICY_DENIED', 'Restore must target isolated staging directory only');
      }
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'backup_restore',
          tier: 'T3',
          payload: { set: args.set, staging_target: stagingTarget },
          summary: `Restore set "${args.set}" strictly to staging path ${stagingTarget}`,
          diff: `restore ${args.set} -> ${stagingTarget} (live data untouched)`,
          sideEffects: [`Writes restored snapshot files into ${stagingTarget}`],
          rollback: [`Remove ${stagingTarget} after inspection`],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Staging restore plan ${plan.id} requires passkey confirmation at ${publicUrl}/confirm/${chal.id}`,
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
        expectedTool: 'backup_restore',
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
      const p = gate.plan.payload as { set: string; staging_target: string };
      const res = await deps.agent.call<{ exit_code: number; output: string }>('backup.restore_test', {
        set: 'vaultwarden',
      });
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Restored "${p.set}" to staging ${p.staging_target}`,
        structured: {
          applied: true,
          status: 'applied',
          staging_target: p.staging_target,
          exit_code: res.exit_code,
          output: res.output,
        },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
