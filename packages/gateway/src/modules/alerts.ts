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
    description: 'Acknowledges an active alert so repeat notifications are suppressed while investigated.',
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
        duration: z.string().regex(/^\d+[smhd]$/).default('2h'),
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
    description: 'Lists configured alert rules, severities, thresholds, and pending windows. Read-only.',
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
}
