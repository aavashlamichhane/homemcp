import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { HomemcpError, validateComposePolicy } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

export function resolveTemplatesDir(): string {
  const candidates = [
    path.resolve(import.meta.dirname, '../../../../templates'),
    path.resolve(import.meta.dirname, '../../../templates'),
    path.resolve(import.meta.dirname, '../../templates'),
    path.resolve(process.cwd(), 'templates'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export interface StackTemplate {
  name: string;
  readme: string;
  compose_hbs: string;
  schema: {
    properties?: Record<string, { type?: string; default?: unknown; pattern?: string }>;
    secrets?: string[];
  };
}

export function loadStackTemplates(templatesDir = resolveTemplatesDir()): StackTemplate[] {
  if (!existsSync(templatesDir)) return [];
  const dirs = readdirSync(templatesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  return dirs.map((d) => {
    const dir = path.join(templatesDir, d.name);
    const compose_hbs = readFileSync(path.join(dir, 'compose.yml.hbs'), 'utf8');
    const schema = JSON.parse(readFileSync(path.join(dir, 'params.schema.json'), 'utf8')) as StackTemplate['schema'];
    const readme = existsSync(path.join(dir, 'README.md'))
      ? readFileSync(path.join(dir, 'README.md'), 'utf8')
      : '';
    return { name: d.name, readme, compose_hbs, schema };
  });
}

export function renderTemplateCompose(
  tpl: StackTemplate,
  params: Record<string, unknown>,
  stackName: string,
): { composeYaml: string; resolvedParams: Record<string, string | number | boolean> } {
  const resolved: Record<string, string | number | boolean> = {};
  for (const [k, prop] of Object.entries(tpl.schema.properties ?? {})) {
    const val = params[k] ?? prop.default;
    if (val !== undefined) {
      resolved[k] = typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' ? val : JSON.stringify(val);
    }
  }
  resolved['stack_name'] = stackName;

  const composeYaml = tpl.compose_hbs.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const val = resolved[key];
    return val !== undefined ? String(val) : '';
  });
  return { composeYaml, resolvedParams: resolved };
}

export function registerStacksModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'stacks_list',
    toolset: 'stacks',
    tier: 'T0',
    description:
      'Lists managed, adopted, and unmanaged stacks on disk alongside compose policy status and container status. Read-only.',
    annotations: {
      title: 'List Stacks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      stacks: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const scan = await deps.agent.call<{ stacks: Array<Record<string, unknown>> }>('stacks.scan');
      const metas = deps.db.db.prepare('SELECT * FROM stack_meta').all() as Array<Record<string, unknown>>;
      const metaMap = new Map(metas.map((m) => [String(m['name']), m]));

      const stacks = scan.stacks.map((s) => {
        const name = typeof s['name'] === 'string' ? s['name'] : '';
        const meta = metaMap.get(name);
        return {
          ...s,
          managed: meta ? Number(meta['managed'] ?? 0) === 1 : false,
          template: typeof meta?.['template'] === 'string' ? meta['template'] : null,
        };
      });
      return {
        summary: `${stacks.length} stack(s) on disk (${stacks.filter((s) => s.managed).length} managed)`,
        structured: { stacks },
      };
    },
  });

  registry.registerTool({
    name: 'stacks_get',
    toolset: 'stacks',
    tier: 'T0',
    description: 'Inspects one stack: redacted compose YAML, .env stats, policy findings, and management metadata. Read-only.',
    annotations: {
      title: 'Get Stack Details',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ name: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args) => {
      const scan = await deps.agent.call<{ stacks: Array<Record<string, unknown>> }>('stacks.scan');
      const stack = scan.stacks.find((s) => s['name'] === args.name);
      if (!stack) {
        throw new HomemcpError('NOT_FOUND', `Stack not found: ${args.name}`);
      }
      const meta = deps.db.db.prepare('SELECT * FROM stack_meta WHERE name = ?').get(args.name) as
        | Record<string, unknown>
        | undefined;
      return {
        summary: `Stack ${args.name} (${meta ? 'managed' : 'unmanaged'})`,
        structured: {
          ...stack,
          managed: Boolean(meta),
          template: typeof meta?.['template'] === 'string' ? meta['template'] : null,
        },
      };
    },
  });

  registry.registerTool({
    name: 'stacks_templates_list',
    toolset: 'stacks',
    tier: 'T0',
    description: 'Lists curated Compose service templates available in the homemcp catalog. Read-only.',
    annotations: {
      title: 'List Stack Templates',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      templates: z.array(
        z.object({
          name: z.string(),
          readme: z.string(),
          secrets: z.array(z.string()),
        }),
      ),
    }),
    handler: () => {
      const tpls = loadStackTemplates();
      return Promise.resolve({
        summary: `${tpls.length} curated stack templates available`,
        structured: {
          templates: tpls.map((t) => ({
            name: t.name,
            readme: t.readme.trim(),
            secrets: t.schema.secrets ?? [],
          })),
        },
      });
    },
  });

  registry.registerTool({
    name: 'stacks_template_get',
    toolset: 'stacks',
    tier: 'T0',
    description: 'Returns a curated template’s parameter schema, README, and Handlebars compose source. Read-only.',
    annotations: {
      title: 'Get Stack Template',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ name: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: (args) => {
      const tpl = loadStackTemplates().find((t) => t.name === args.name);
      if (!tpl) {
        throw new HomemcpError('NOT_FOUND', `Template not found: ${args.name}`);
      }
      return Promise.resolve({
        summary: `Template "${tpl.name}" (secrets: ${(tpl.schema.secrets ?? []).join(', ') || 'none'})`,
        structured: tpl as unknown as Record<string, unknown>,
      });
    },
  });

  registry.registerTool({
    name: 'stacks_validate',
    toolset: 'stacks',
    tier: 'T0',
    description: 'Validates candidate Docker Compose YAML against homemcp security policy without writing any files. Read-only.',
    annotations: {
      title: 'Validate Compose Policy',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ name: z.string().min(1), compose_yaml: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: (args) => {
      const stackDir = path.posix.join(deps.config.policy.roots.stacks, args.name);
      const res = validateComposePolicy(args.compose_yaml, {
        stackName: args.name,
        stackDir,
        allowedBindRoots: [stackDir, deps.config.policy.roots.media],
        allow: deps.config.policy.compose.allow,
      });
      return Promise.resolve({
        summary: `Policy validation for "${args.name}": allowed=${String(res.allowed)} (${res.violations.length} violations, ${res.warnings.length} warnings)`,
        structured: res as unknown as Record<string, unknown>,
      });
    },
  });

  registry.registerTool({
    name: 'stacks_plan',
    toolset: 'stacks',
    tier: 'T0',
    description:
      'Plans deploying a curated template or custom compose YAML: renders template, validates compose policy, checks port/name conflicts, and returns a plan_id for stacks_apply. Read-only.',
    annotations: {
      title: 'Plan Stack Deployment',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        template: z.string().optional(),
        params: z.record(z.string(), z.unknown()).default({}),
        compose_yaml: z.string().optional(),
        start: z.boolean().default(true),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: (args, ctx) => {
      let yaml = args.compose_yaml;
      let secretKeys: string[] = [];
      if (args.template) {
        const tpl = loadStackTemplates().find((t) => t.name === args.template);
        if (!tpl) {
          throw new HomemcpError('NOT_FOUND', `Template not found: ${args.template}`);
        }
        yaml = renderTemplateCompose(tpl, args.params, args.name).composeYaml;
        secretKeys = tpl.schema.secrets ?? [];
      }
      if (!yaml) {
        throw new HomemcpError('INVALID_ARGUMENT', 'Provide either template or compose_yaml');
      }

      const stackDir = path.posix.join(deps.config.policy.roots.stacks, args.name);
      const policy = validateComposePolicy(yaml, {
        stackName: args.name,
        stackDir,
        allowedBindRoots: [stackDir, deps.config.policy.roots.media],
        allow: deps.config.policy.compose.allow,
      });
      if (!policy.allowed) {
        throw new HomemcpError(
          'POLICY_DENIED',
          `Compose policy rejected "${args.name}": ${policy.violations.map((v) => v.message).join('; ')}`,
        );
      }

      const plan = deps.plans.createPlan({
        tool: 'stacks_apply',
        tier: 'T2',
        payload: {
          name: args.name,
          template: args.template ?? null,
          compose_yaml: yaml,
          secret_keys: secretKeys,
          start: args.start,
        },
        summary: `Deploy stack "${args.name}"${args.template ? ` from template "${args.template}"` : ''} into ${stackDir}`,
        diff: yaml,
        sideEffects: [
          `Writes ${stackDir}/docker-compose.yml`,
          ...(secretKeys.length > 0 ? [`Generates secrets (${secretKeys.join(', ')}) into 0600 .env (not shown to LLM)`] : []),
          ...(args.start ? ['Pulls container image(s) and runs docker compose up -d'] : []),
        ],
        rollback: [`Run stacks_remove for "${args.name}" (moves to .trash)`],
        createdBy: ctx.auth.subject,
      });
      const chal = deps.confirmations.createChallenge(plan.id, 'url');
      const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
      return Promise.resolve({
        summary: `Stack plan ${plan.id} created (policy passed, ${policy.warnings.length} warnings); confirm at ${publicUrl}/confirm/${chal.id}`,
        structured: {
          plan_id: plan.id,
          confirmation_id: chal.id,
          confirm_url: `${publicUrl}/confirm/${chal.id}`,
          policy,
          secret_keys_to_generate: secretKeys,
          diff: yaml,
        },
        planId: plan.id,
        confirmationId: chal.id,
      });
    },
  });

  registry.registerTool({
    name: 'stacks_apply',
    toolset: 'stacks',
    tier: 'T2',
    description:
      'Applies a confirmed stack plan: validates policy in homemcpd, writes compose, generates secrets cleanly to 0600 .env (values never returned), pulls, and starts.',
    annotations: {
      title: 'Apply Stack Plan',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({ plan_id: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'stacks_apply',
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
        name: string;
        template: string | null;
        compose_yaml: string;
        secret_keys: string[];
        start: boolean;
      };
      const res = await deps.agent.call<{
        name: string;
        stack_dir: string;
        generated_secret_keys: string[];
        started: boolean;
      }>('stacks.apply', {
        name: p.name,
        compose_yaml: p.compose_yaml,
        secret_keys: p.secret_keys,
        start: p.start,
      });

      deps.db.db
        .prepare(
          `INSERT OR REPLACE INTO stack_meta (name, root, managed, template, created_by, created_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(
          res.name,
          deps.config.policy.roots.stacks,
          p.template,
          ctx.auth.subject,
          new Date().toISOString(),
        );
      deps.plans.markApplied(gate.plan.id);

      return {
        summary: `Stack "${res.name}" deployed at ${res.stack_dir} (${res.generated_secret_keys.length} secret key(s) generated to 0600 .env)`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'stacks_up',
    toolset: 'stacks',
    tier: 'T1',
    description: 'Starts a stack (`docker compose up -d`) inside allowed stack roots.',
    annotations: {
      title: 'Start Stack',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ stack_dir: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args) => {
      const res = await deps.agent.call<Record<string, unknown>>('stacks.up', { stack_dir: args.stack_dir });
      return {
        summary: `Started stack at ${args.stack_dir}`,
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'stacks_down',
    toolset: 'stacks',
    tier: 'T2',
    description: 'Stops a stack (`docker compose down`) keeping volumes/data intact (plan-first).',
    annotations: {
      title: 'Stop Stack',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ stack_dir: z.string().min(1), plan_id: z.string().optional() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'stacks_down',
          tier: 'T2',
          payload: { stack_dir: args.stack_dir },
          summary: `Stop stack at ${args.stack_dir} (data preserved)`,
          diff: `docker compose -f ${args.stack_dir}/docker-compose.yml down`,
          sideEffects: ['Stops containers in stack (bind mounts & named volumes kept)'],
          rollback: [`Run stacks_up on ${args.stack_dir}`],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Plan ${plan.id} created`,
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
        expectedTool: 'stacks_down',
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
      const p = gate.plan.payload as { stack_dir: string };
      const res = await deps.agent.call<Record<string, unknown>>('stacks.down', { stack_dir: p.stack_dir });
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Stopped stack ${p.stack_dir}`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'stacks_remove',
    toolset: 'stacks',
    tier: 'T3',
    description:
      'Brings a stack down and moves its directory to `.trash/<name>-<ts>` (never deletes permanently). Requires T3 passkey confirmation.',
    annotations: {
      title: 'Remove Stack to Trash',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z.object({ stack_dir: z.string().min(1), plan_id: z.string().optional() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'stacks_remove',
          tier: 'T3',
          payload: { stack_dir: args.stack_dir },
          summary: `Down stack & move ${args.stack_dir} to .trash/`,
          diff: `mv ${args.stack_dir} -> .trash/`,
          sideEffects: ['Stops and removes containers; moves stack directory to .trash'],
          rollback: ['Move directory back from .trash and run stacks_up'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Removal plan ${plan.id} requires passkey confirmation at ${publicUrl}/confirm/${chal.id}`,
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
        expectedTool: 'stacks_remove',
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
      const p = gate.plan.payload as { stack_dir: string };
      const res = await deps.agent.call<Record<string, unknown>>('stacks.remove', { stack_dir: p.stack_dir });
      deps.db.db.prepare('DELETE FROM stack_meta WHERE name = ?').run(path.posix.basename(p.stack_dir));
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Moved stack ${p.stack_dir} to trash`,
        structured: { applied: true, status: 'applied', ...res },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'stacks_adopt',
    toolset: 'stacks',
    tier: 'T2',
    description: 'Registers an existing compose directory on disk under homemcp management (plan-first).',
    annotations: {
      title: 'Adopt Existing Stack',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ name: z.string().min(1), plan_id: z.string().optional() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      const scan = await deps.agent.call<{ stacks: Array<{ name: string; dir: string; root: string }> }>('stacks.scan');
      const stack = scan.stacks.find((s) => s.name === args.name);
      if (!stack) {
        throw new HomemcpError('NOT_FOUND', `Stack not found on disk: ${args.name}`);
      }
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'stacks_adopt',
          tier: 'T2',
          payload: { name: stack.name, root: stack.root },
          summary: `Adopt existing stack "${stack.name}" (${stack.dir}) into homemcp stack_meta`,
          diff: `+ stack_meta(${stack.name}, managed=true)`,
          sideEffects: ['Marks stack as managed in homemcp database'],
          rollback: ['Delete entry from stack_meta'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Plan ${plan.id} created`,
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
        expectedTool: 'stacks_adopt',
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
      const p = gate.plan.payload as { name: string; root: string };
      deps.db.db
        .prepare(
          `INSERT OR REPLACE INTO stack_meta (name, root, managed, template, created_by, created_at)
           VALUES (?, ?, 1, NULL, ?, ?)`,
        )
        .run(p.name, p.root, ctx.auth.subject, new Date().toISOString());
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Adopted stack "${p.name}"`,
        structured: { applied: true, status: 'applied', name: p.name },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
