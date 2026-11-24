import * as z from 'zod/v4';
import type { GatewayDeps } from '../server/factory.js';

export function registerFilesModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'files_list',
    toolset: 'files',
    tier: 'T0',
    description: 'Lists directory entries within allowed stacks/media/shares roots. Read-only.',
    annotations: {
      title: 'List Directory',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args) => {
      const res = await deps.agent.call<{ path: string; entries: unknown[] }>('files.list', {
        path: args.path,
      });
      return {
        summary: `${res.entries.length} entries in ${res.path}`,
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'files_stat',
    toolset: 'files',
    tier: 'T0',
    description: 'Inspects file or directory metadata (type, size, octal mode, mtime). Read-only.',
    annotations: {
      title: 'Stat File',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args) => {
      const res = await deps.agent.call<Record<string, unknown>>('files.stat', { path: args.path });
      return {
        summary: `${String(res['path'])}: ${String(res['type'])} (${String(res['size_bytes'])} bytes)`,
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'files_search',
    toolset: 'files',
    tier: 'T0',
    description: 'Searches filenames matching a case-insensitive pattern within allowed roots (skips denied files). Read-only.',
    annotations: {
      title: 'Search Files',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        root: z.string().min(1),
        pattern: z.string().min(1),
        max_results: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    outputSchema: z.object({ matches: z.array(z.string()) }),
    handler: async (args) => {
      const res = await deps.agent.call<{ matches: string[] }>('files.search', args);
      return {
        summary: `Found ${res.matches.length} matching paths`,
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'files_disk_usage',
    toolset: 'files',
    tier: 'T0',
    description: 'Reports per-entry byte sizes under an allowed directory path. Read-only.',
    annotations: {
      title: 'Directory Disk Usage',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args) => {
      const res = await deps.agent.call<Record<string, unknown>>('files.disk_usage', { path: args.path });
      return {
        summary: `Disk usage for ${args.path}: ${String(res['total_bytes'])} bytes`,
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'files_read',
    toolset: 'files',
    tier: 'T0',
    description:
      'Reads a UTF-8 text file (<=256 KB) within allowed roots; strictly blocks .env, .key, .pem, and SSH/credential files and redacts output. Read-only.',
    annotations: {
      title: 'Read Text File',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args) => {
      const res = await deps.agent.call<{ path: string; content: string; size_bytes?: number }>(
        'files.read',
        { path: args.path },
      );
      return {
        summary: `Read ${res.path} (${res.content.length} chars)`,
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'files_mkdir',
    toolset: 'files',
    tier: 'T1',
    description: 'Creates a directory inside allowed roots.',
    annotations: {
      title: 'Create Directory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args) => {
      const res = await deps.agent.call<Record<string, unknown>>('files.mkdir', { path: args.path });
      return {
        summary: `Created directory ${args.path}`,
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'files_write_plan',
    toolset: 'files',
    tier: 'T0',
    description: 'Plans writing a non-secret file inside stack roots and returns a diff plan_id for files_write_apply. Read-only.',
    annotations: {
      title: 'Plan File Write',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: (args, ctx) => {
      const plan = deps.plans.createPlan({
        tool: 'files_write_apply',
        tier: 'T2',
        payload: { path: args.path, content: args.content },
        summary: `Write ${Buffer.byteLength(args.content, 'utf8')} bytes to ${args.path}`,
        diff: args.content.slice(0, 4000),
        sideEffects: [`Overwrites or creates ${args.path}`],
        rollback: ['Restore previous file content'],
        createdBy: ctx.auth.subject,
      });
      const chal = deps.confirmations.createChallenge(plan.id, 'url');
      const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
      return Promise.resolve({
        summary: `Write plan ${plan.id} created`,
        structured: {
          plan_id: plan.id,
          confirmation_id: chal.id,
          confirm_url: `${publicUrl}/confirm/${chal.id}`,
        },
        planId: plan.id,
        confirmationId: chal.id,
      });
    },
  });

  registry.registerTool({
    name: 'files_write_apply',
    toolset: 'files',
    tier: 'T2',
    description: 'Applies a confirmed file write plan via homemcpd.',
    annotations: {
      title: 'Apply File Write',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ plan_id: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'files_write_apply',
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
      const p = gate.plan.payload as { path: string; content: string };
      const res = await deps.agent.call<Record<string, unknown>>('files.write', p);
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Wrote ${p.path}`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'files_move',
    toolset: 'files',
    tier: 'T2',
    description: 'Moves/renames a file inside allowed roots (plan-first when overwrite=true or plan_id omitted).',
    annotations: {
      title: 'Move/Rename File',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        src: z.string().min(1),
        dst: z.string().min(1),
        overwrite: z.boolean().default(false),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'files_move',
          tier: 'T2',
          payload: { src: args.src, dst: args.dst, overwrite: args.overwrite },
          summary: `Move ${args.src} -> ${args.dst}`,
          diff: `- ${args.src}\n+ ${args.dst}`,
          sideEffects: [args.overwrite ? 'May overwrite destination path' : 'Moves path safely'],
          rollback: [`Move ${args.dst} back to ${args.src}`],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Move plan ${plan.id} created`,
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
        expectedTool: 'files_move',
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
      const p = gate.plan.payload as { src: string; dst: string; overwrite: boolean };
      const res = await deps.agent.call<Record<string, unknown>>('files.move', p);
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Moved ${p.src} -> ${p.dst}`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'files_trash',
    toolset: 'files',
    tier: 'T2',
    description: 'Moves a file or directory to `.trash` inside its root (30-day soft delete; plan-first).',
    annotations: {
      title: 'Trash File',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({ path: z.string().min(1), plan_id: z.string().optional() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'files_trash',
          tier: 'T2',
          payload: { path: args.path },
          summary: `Move ${args.path} to .trash/`,
          diff: `mv ${args.path} -> .trash/`,
          sideEffects: [`Moves ${args.path} into .trash/`],
          rollback: ['Restore from .trash/ via files_move'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Trash plan ${plan.id} created`,
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
        expectedTool: 'files_trash',
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
      const p = gate.plan.payload as { path: string };
      const res = await deps.agent.call<Record<string, unknown>>('files.trash', p);
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Moved ${p.path} to .trash/`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
