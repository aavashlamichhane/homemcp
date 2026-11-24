import * as z from 'zod/v4';
import type { GatewayDeps } from '../server/factory.js';

export function registerAlertsModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'alerts_list',
    toolset: 'alerts',
    tier: 'T0',
    description: 'Lists open or recent alerts evaluated by the homemcp watcher. Read-only.',
    annotations: {
      title: 'List Alerts',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ include_resolved: z.boolean().default(false) }).strict(),
    outputSchema: z.object({
      alerts: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: (args) => {
      const alerts = deps.watcher.listAlerts({ includeResolved: args.include_resolved });
      return Promise.resolve({
        summary: `${alerts.length} alert(s) returned`,
        structured: { alerts: alerts as unknown as Array<Record<string, unknown>> },
      });
    },
  });

  registry.registerTool({
    name: 'alerts_ack',
    toolset: 'alerts',
    tier: 'T1',
    description:
      'Acknowledges an active alert so repeat notifications are suppressed while investigated.',
    annotations: {
      title: 'Acknowledge Alert',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ id: z.string().min(1) }).strict(),
    outputSchema: z.object({
      alert: z.record(z.string(), z.unknown()),
    }),
    handler: (args, ctx) => {
      const alert = deps.watcher.ackAlert(args.id, ctx.auth.subject);
      return Promise.resolve({
        summary: `Acknowledged alert ${alert.id} (${alert.rule})`,
        structured: { alert: alert as unknown as Record<string, unknown> },
      });
    },
  });

  registry.registerTool({
    name: 'alerts_snooze',
    toolset: 'alerts',
    tier: 'T1',
    description: 'Snoozes an alert for a duration (e.g., 2h, 30m).',
    annotations: {
      title: 'Snooze Alert',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        id: z.string().min(1),
        duration: z
          .string()
          .regex(/^\d+[smhd]$/)
          .default('2h'),
      })
      .strict(),
    outputSchema: z.object({
      alert: z.record(z.string(), z.unknown()),
    }),
    handler: (args) => {
      const alert = deps.watcher.snoozeAlert(args.id, args.duration);
      return Promise.resolve({
        summary: `Snoozed alert ${alert.id} until ${alert.snoozed_until ?? ''}`,
        structured: { alert: alert as unknown as Record<string, unknown> },
      });
    },
  });

  registry.registerTool({
    name: 'alerts_rules_list',
    toolset: 'alerts',
    tier: 'T0',
    description:
      'Lists configured alert rules, severities, thresholds, and pending windows. Read-only.',
    annotations: {
      title: 'List Alert Rules',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      rules: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: () => {
      const rules = deps.watcher.listRules();
      return Promise.resolve({
        summary: `${rules.length} alert rule(s) configured`,
        structured: { rules: rules as unknown as Array<Record<string, unknown>> },
      });
    },
  });

  registry.registerTool({
    name: 'alerts_test_notification',
    toolset: 'alerts',
    tier: 'T1',
    description: 'Sends a test push notification via ntfy (or queues if currently offline).',
    annotations: {
      title: 'Send Test Notification',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        title: z.string().default('homemcp Test Notification'),
        message: z.string().default('Notification channel verification from homemcp'),
      })
      .strict(),
    outputSchema: z.object({
      delivered: z.boolean(),
      queued: z.boolean(),
      flushed_count: z.number().int(),
    }),
    handler: async (args) => {
      const res = await deps.watcher.sendOrQueueNotification({
        title: args.title,
        message: args.message,
        priority: 3,
        tags: ['bell'],
      });
      return {
        summary: res.delivered
          ? `Notification delivered (flushed ${res.flushed_count} queued)`
          : res.queued
            ? 'Target unreachable; notification queued in SQLite for reconnect delivery'
            : 'ntfy connector not configured',
        structured: res,
      };
    },
  });

  registry.registerTool({
    name: 'alerts_rule_set',
    toolset: 'alerts',
    tier: 'T2',
    description:
      'Updates an alert rule threshold, severity, pending window, or enabled state (plan-first).',
    annotations: {
      title: 'Update Alert Rule',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        rule: z.string().min(1),
        severity: z.enum(['info', 'warning', 'critical']).optional(),
        enabled: z.boolean().optional(),
        pending_seconds: z.number().int().min(0).max(86_400).optional(),
        threshold: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'alerts_rule_set',
          tier: 'T2',
          payload: {
            rule: args.rule,
            severity: args.severity,
            enabled: args.enabled,
            pending_seconds: args.pending_seconds,
            threshold: args.threshold,
          },
          summary: `Update alert rule "${args.rule}"`,
          diff: JSON.stringify({
            severity: args.severity,
            enabled: args.enabled,
            threshold: args.threshold,
          }),
          sideEffects: [`Alert rule "${args.rule}" configuration changes`],
          rollback: ['Re-run alerts_rule_set with prior values'],
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
        expectedTool: 'alerts_rule_set',
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
        rule: string;
        severity?: 'info' | 'warning' | 'critical';
        enabled?: boolean;
        pending_seconds?: number;
        threshold?: Record<string, number | string | boolean>;
      };
      const updated = deps.watcher.setRule(p.rule, p);
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Updated alert rule ${updated.rule}`,
        structured: { applied: true, status: 'applied', rule: updated },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
