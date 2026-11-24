import { randomUUID } from 'node:crypto';
import type {
  AgentExecutor,
  CloudflareConnector,
  DockerConnector,
  HealthchecksConnector,
  NtfyConnector,
  NtfyPriority,
} from '@homemcp/connectors';
import { HomemcpError, parseDurationMs, type HomemcpConfig, type Redactor } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';

export type AlertState = 'ok' | 'pending' | 'firing' | 'resolved';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRuleRecord {
  rule: string;
  severity: AlertSeverity;
  enabled: boolean;
  threshold: Record<string, number | string | boolean>;
  pending_seconds: number;
  channel: string;
  updated_at: string;
}

export interface AlertRecord {
  id: string;
  rule: string;
  severity: AlertSeverity;
  state: AlertState;
  first_seen: string;
  last_seen: string;
  pending_since?: string | undefined;
  resolved_at?: string | undefined;
  acked_by?: string | undefined;
  acked_at?: string | undefined;
  snoozed_until?: string | undefined;
  summary: string;
  payload: Record<string, unknown>;
}

interface DefaultRuleSeed {
  rule: string;
  severity: AlertSeverity;
  threshold: Record<string, number | string | boolean>;
  pending_seconds: number;
}

const DEFAULT_RULES: readonly DefaultRuleSeed[] = [
  {
    rule: 'power_on_battery',
    severity: 'critical',
    threshold: { max_seconds_offline: 60 },
    pending_seconds: 60,
  },
  {
    rule: 'disk_space',
    severity: 'warning',
    threshold: { max_use_percent: 85 },
    pending_seconds: 0,
  },
  {
    rule: 'smart_health',
    severity: 'critical',
    threshold: { require_passed: true },
    pending_seconds: 0,
  },
  { rule: 'temperature', severity: 'warning', threshold: { max_temp_c: 85 }, pending_seconds: 300 },
  {
    rule: 'container_unhealthy',
    severity: 'warning',
    threshold: { allow_unhealthy: false },
    pending_seconds: 180,
  },
  {
    rule: 'backup_stale',
    severity: 'warning',
    threshold: { enforce_rpo: true },
    pending_seconds: 0,
  },
  {
    rule: 'backup_budget',
    severity: 'warning',
    threshold: { budget_bytes: 7_000_000_000 },
    pending_seconds: 0,
  },
  {
    rule: 'tunnel_connectors',
    severity: 'warning',
    threshold: { min_connections: 3 },
    pending_seconds: 60,
  },
  {
    rule: 'security_updates',
    severity: 'info',
    threshold: { max_security_count: 25 },
    pending_seconds: 0,
  },
];

export class AlertWatcher {
  private timer: NodeJS.Timeout | undefined;
  private offlineSinceMs: number | undefined;
  private lastDigestDate: string | undefined;

  public constructor(
    private readonly deps: {
      db: HomemcpDb;
      config: HomemcpConfig;
      redactor: Redactor;
      agent: AgentExecutor;
      docker?: DockerConnector | undefined;
      cloudflare?: CloudflareConnector | undefined;
      ntfy?: NtfyConnector | undefined;
      healthchecks?: HealthchecksConnector | undefined;
    },
  ) {
    this.seedRules();
  }

  private seedRules(): void {
    const now = new Date().toISOString();
    const stmt = this.deps.db.db.prepare(
      `INSERT OR IGNORE INTO alert_rules (rule, severity, enabled, threshold_json, pending_seconds, channel, updated_at)
       VALUES (?, ?, 1, ?, ?, 'ntfy', ?)`,
    );
    for (const r of DEFAULT_RULES) {
      stmt.run(r.rule, r.severity, JSON.stringify(r.threshold), r.pending_seconds, now);
    }
  }

  public listRules(): AlertRuleRecord[] {
    const rows = this.deps.db.db
      .prepare('SELECT * FROM alert_rules ORDER BY rule ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      rule: String(r['rule']),
      severity: String(r['severity']) as AlertSeverity,
      enabled: Number(r['enabled'] ?? 1) === 1,
      threshold: JSON.parse(String(r['threshold_json'])) as Record<
        string,
        number | string | boolean
      >,
      pending_seconds: Number(r['pending_seconds'] ?? 0),
      channel: typeof r['channel'] === 'string' ? r['channel'] : 'ntfy',
      updated_at: String(r['updated_at']),
    }));
  }

  public setRule(
    rule: string,
    patch: {
      severity?: AlertSeverity | undefined;
      enabled?: boolean | undefined;
      threshold?: Record<string, number | string | boolean> | undefined;
      pending_seconds?: number | undefined;
    },
  ): AlertRuleRecord {
    const existing = this.listRules().find((r) => r.rule === rule);
    if (!existing) {
      throw new HomemcpError('NOT_FOUND', `Alert rule not found: ${rule}`);
    }
    const next: AlertRuleRecord = {
      rule,
      severity: patch.severity ?? existing.severity,
      enabled: patch.enabled ?? existing.enabled,
      threshold: patch.threshold ?? existing.threshold,
      pending_seconds: patch.pending_seconds ?? existing.pending_seconds,
      channel: existing.channel,
      updated_at: new Date().toISOString(),
    };
    this.deps.db.db
      .prepare(
        `UPDATE alert_rules
         SET severity = ?, enabled = ?, threshold_json = ?, pending_seconds = ?, updated_at = ?
         WHERE rule = ?`,
      )
      .run(
        next.severity,
        next.enabled ? 1 : 0,
        JSON.stringify(next.threshold),
        next.pending_seconds,
        next.updated_at,
        rule,
      );
    return next;
  }

  public listAlerts(opts?: { includeResolved?: boolean | undefined }): AlertRecord[] {
    const where = opts?.includeResolved ? '' : "WHERE state IN ('pending', 'firing')";
    const rows = this.deps.db.db
      .prepare(`SELECT * FROM alerts ${where} ORDER BY last_seen DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r['id']),
      rule: String(r['rule']),
      severity: String(r['severity']) as AlertSeverity,
      state: String(r['state']) as AlertState,
      first_seen: String(r['first_seen']),
      last_seen: String(r['last_seen']),
      pending_since: typeof r['pending_since'] === 'string' ? r['pending_since'] : undefined,
      resolved_at: typeof r['resolved_at'] === 'string' ? r['resolved_at'] : undefined,
      acked_by: typeof r['acked_by'] === 'string' ? r['acked_by'] : undefined,
      acked_at: typeof r['acked_at'] === 'string' ? r['acked_at'] : undefined,
      snoozed_until: typeof r['snoozed_until'] === 'string' ? r['snoozed_until'] : undefined,
      summary: String(r['summary']),
      payload: JSON.parse(String(r['payload_json'])) as Record<string, unknown>,
    }));
  }

  public ackAlert(id: string, actor: string): AlertRecord {
    const found = this.listAlerts({ includeResolved: true }).find((a) => a.id === id);
    if (!found) {
      throw new HomemcpError('NOT_FOUND', `Alert not found: ${id}`);
    }
    const now = new Date().toISOString();
    this.deps.db.db
      .prepare('UPDATE alerts SET acked_by = ?, acked_at = ? WHERE id = ?')
      .run(actor, now, id);
    return { ...found, acked_by: actor, acked_at: now };
  }

  public snoozeAlert(id: string, duration: string): AlertRecord {
    const found = this.listAlerts({ includeResolved: true }).find((a) => a.id === id);
    if (!found) {
      throw new HomemcpError('NOT_FOUND', `Alert not found: ${id}`);
    }
    const ms = parseDurationMs(duration);
    const until = new Date(Date.now() + ms).toISOString();
    this.deps.db.db.prepare('UPDATE alerts SET snoozed_until = ? WHERE id = ?').run(until, id);
    return { ...found, snoozed_until: until };
  }

  public async sendOrQueueNotification(opts: {
    title: string;
    message: string;
    priority?: NtfyPriority | undefined;
    tags?: string[] | undefined;
  }): Promise<{ delivered: boolean; queued: boolean; flushed_count: number }> {
    const cleanTitle = this.deps.redactor.redactString(opts.title).text;
    const cleanMsg = this.deps.redactor.redactString(opts.message).text;
    const priority = opts.priority ?? 3;
    const tags = opts.tags ?? [];

    if (!this.deps.ntfy) {
      return { delivered: false, queued: false, flushed_count: 0 };
    }

    let flushed = 0;
    try {
      // First check if we have queued offline messages and try flushing them
      flushed = await this.flushOutboundQueue();
      await this.deps.ntfy.send({
        title: cleanTitle,
        message: cleanMsg,
        priority,
        tags,
      });
      this.offlineSinceMs = undefined;
      return { delivered: true, queued: false, flushed_count: flushed };
    } catch (err) {
      if (this.offlineSinceMs === undefined) {
        this.offlineSinceMs = Date.now();
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      this.deps.db.db
        .prepare(
          `INSERT INTO outbound_notifications (id, created_at, title, message, priority, tags_json, attempts, last_error)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          `notif_${randomUUID().slice(0, 12)}`,
          new Date().toISOString(),
          cleanTitle,
          cleanMsg,
          priority,
          JSON.stringify(tags),
          this.deps.redactor.redactString(errMsg).text,
        );
      return { delivered: false, queued: true, flushed_count: flushed };
    }
  }

  public async flushOutboundQueue(): Promise<number> {
    if (!this.deps.ntfy) return 0;
    const pending = this.deps.db.db
      .prepare(
        'SELECT * FROM outbound_notifications WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT 50',
      )
      .all() as Array<Record<string, unknown>>;
    if (pending.length === 0) return 0;

    let sentCount = 0;
    const outageSec =
      this.offlineSinceMs !== undefined
        ? Math.max(1, Math.round((Date.now() - this.offlineSinceMs) / 1000))
        : undefined;

    for (const row of pending) {
      const id = String(row['id']);
      const baseMsg = String(row['message']);
      const suffix =
        outageSec !== undefined && sentCount === 0
          ? `\n[Delivered after connectivity recovery; outage duration: ${outageSec}s]`
          : '';
      await this.deps.ntfy.send({
        title: String(row['title']),
        message: `${baseMsg}${suffix}`,
        priority: Number(row['priority'] ?? 3) as NtfyPriority,
        tags: JSON.parse(
          typeof row['tags_json'] === 'string' ? row['tags_json'] : '[]',
        ) as string[],
      });
      this.deps.db.db
        .prepare(
          'UPDATE outbound_notifications SET sent_at = ?, attempts = attempts + 1 WHERE id = ?',
        )
        .run(new Date().toISOString(), id);
      sentCount++;
    }
    this.offlineSinceMs = undefined;
    return sentCount;
  }

  public async evaluateOnce(nowMs = Date.now()): Promise<{
    firing: number;
    pending: number;
    resolved_count: number;
    flushed_notifications: number;
  }> {
    const flushedNotifications = await this.flushOutboundQueue().catch(() => 0);

    const [health, disks, updates, backupData, containers, tunnelStatus] = await Promise.all([
      this.deps.agent
        .call<{
          temperatures: Array<{ label: string; temp_c: number }>;
          battery?: { ac_online?: boolean };
        }>('system.health')
        .catch(() => null),
      this.deps.agent
        .call<{
          filesystems: Array<{ mountpoint: string; use_percent: number }>;
          smart_summary: Array<{ device: string; passed: boolean }>;
        }>('system.disks')
        .catch(() => null),
      this.deps.agent.call<{ security_count: number }>('system.updates').catch(() => null),
      this.deps.agent
        .call<{
          status: Record<string, { last_status?: string; last_success?: string }>;
          stats: { total_size?: number };
        }>('backup.read_status')
        .catch(() => null),
      this.deps.docker
        ? this.deps.docker.listContainers(true).catch(() => [])
        : Promise.resolve([]),
      this.deps.cloudflare
        ? this.deps.cloudflare.getTunnelStatus().catch(() => null)
        : Promise.resolve(null),
    ]);

    const rules = this.listRules();
    const findings = new Map<
      string,
      { breached: boolean; summary: string; payload: Record<string, unknown> }
    >();

    const maxTemp = health?.temperatures.length
      ? Math.max(...health.temperatures.map((t) => t.temp_c))
      : 0;
    const tempLimit = Number(
      rules.find((r) => r.rule === 'temperature')?.threshold['max_temp_c'] ?? 85,
    );
    findings.set('temperature', {
      breached: maxTemp > tempLimit,
      summary: `CPU package temperature ${maxTemp}°C (> ${tempLimit}°C)`,
      payload: { max_temp_c: maxTemp, threshold_c: tempLimit },
    });

    const onBattery = health?.battery?.ac_online === false;
    findings.set('power_on_battery', {
      breached: onBattery,
      summary: 'AC power offline; running on battery',
      payload: { ac_online: !onBattery },
    });

    const maxUse = disks?.filesystems.length
      ? Math.max(...disks.filesystems.map((d) => d.use_percent))
      : 0;
    const diskLimit = Number(
      rules.find((r) => r.rule === 'disk_space')?.threshold['max_use_percent'] ?? 85,
    );
    findings.set('disk_space', {
      breached: maxUse >= diskLimit,
      summary: `Disk usage at ${maxUse}% (>= ${diskLimit}%)`,
      payload: { max_use_percent: maxUse, threshold_percent: diskLimit },
    });

    const failedSmart = (disks?.smart_summary ?? []).filter((s) => !s.passed);
    findings.set('smart_health', {
      breached: failedSmart.length > 0,
      summary: `SMART health failed on: ${failedSmart.map((s) => s.device).join(', ')}`,
      payload: { failed_devices: failedSmart.map((s) => s.device) },
    });

    const unhealthy = containers
      .filter((c) => c.Status.toLowerCase().includes('unhealthy') || c.State === 'restarting')
      .map((c) => c.Names[0]?.replace(/^\//, '') ?? c.Id);
    findings.set('container_unhealthy', {
      breached: unhealthy.length > 0,
      summary: `Unhealthy/restarting containers: ${unhealthy.join(', ')}`,
      payload: { containers: unhealthy },
    });

    const configuredSets = this.deps.config.modules.backup?.sets ?? {};
    const staleSets: string[] = [];
    if (backupData) {
      for (const [setName, cfg] of Object.entries(configuredSets)) {
        const st = backupData.status[setName];
        const ageSec = st?.last_success
          ? Math.floor((nowMs - Date.parse(st.last_success)) / 1000)
          : Infinity;
        const rpoSec = Math.floor(parseDurationMs(cfg.rpo) / 1000);
        if (st?.last_status !== 'success' || ageSec > rpoSec) {
          staleSets.push(setName);
        }
      }
    }
    findings.set('backup_stale', {
      breached: staleSets.length > 0,
      summary: `Stale backups exceeding RPO: ${staleSets.join(', ')}`,
      payload: { stale_sets: staleSets },
    });

    const repoSize = Number(backupData?.stats.total_size ?? 0);
    const budgetBytes = Number(
      rules.find((r) => r.rule === 'backup_budget')?.threshold['budget_bytes'] ??
        this.deps.config.modules.backup?.budgetBytes ??
        7_000_000_000,
    );
    findings.set('backup_budget', {
      breached: repoSize > budgetBytes,
      summary: `Backup repo size ${repoSize} exceeds budget ${budgetBytes}`,
      payload: { repo_size_bytes: repoSize, budget_bytes: budgetBytes },
    });

    if (tunnelStatus) {
      const minConn = Number(
        rules.find((r) => r.rule === 'tunnel_connectors')?.threshold['min_connections'] ?? 3,
      );
      findings.set('tunnel_connectors', {
        breached: tunnelStatus.connections.length < minConn,
        summary: `Cloudflare tunnel connections ${tunnelStatus.connections.length} (< ${minConn})`,
        payload: { connections: tunnelStatus.connections.length, min_connections: minConn },
      });
    }

    const secCount = updates?.security_count ?? 0;
    const maxSec = Number(
      rules.find((r) => r.rule === 'security_updates')?.threshold['max_security_count'] ?? 25,
    );
    findings.set('security_updates', {
      breached: secCount > maxSec,
      summary: `${secCount} pending security updates (> ${maxSec})`,
      payload: { security_count: secCount, threshold: maxSec },
    });

    const nowIso = new Date(nowMs).toISOString();
    let resolvedCount = 0;

    for (const r of rules) {
      const finding = findings.get(r.rule);
      const existing = this.deps.db.db
        .prepare(
          "SELECT * FROM alerts WHERE rule = ? AND state IN ('pending', 'firing') ORDER BY last_seen DESC LIMIT 1",
        )
        .get(r.rule) as Record<string, unknown> | undefined;

      if (!r.enabled || !finding || !finding.breached) {
        if (existing) {
          const prevState = String(existing['state']);
          this.deps.db.db
            .prepare(
              "UPDATE alerts SET state = 'resolved', resolved_at = ?, last_seen = ? WHERE id = ?",
            )
            .run(nowIso, nowIso, String(existing['id']));
          if (prevState === 'firing') {
            resolvedCount++;
            await this.sendOrQueueNotification({
              title: `[RESOLVED] ${r.rule}`,
              message: `Alert resolved: ${String(existing['summary'])}`,
              priority: 2,
              tags: ['white_check_mark', r.rule],
            });
          }
        }
        continue;
      }

      if (!existing) {
        const pendingSince = nowIso;
        const initialState: AlertState = r.pending_seconds === 0 ? 'firing' : 'pending';
        const id = `alrt_${randomUUID().slice(0, 12)}`;
        this.deps.db.db
          .prepare(
            `INSERT INTO alerts (id, rule, severity, state, first_seen, last_seen, pending_since, summary, payload_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            r.rule,
            r.severity,
            initialState,
            nowIso,
            nowIso,
            pendingSince,
            finding.summary,
            JSON.stringify(finding.payload),
          );
        if (initialState === 'firing') {
          await this.sendOrQueueNotification({
            title: `[${r.severity.toUpperCase()}] ${r.rule}`,
            message: finding.summary,
            priority: r.severity === 'critical' ? 5 : 4,
            tags: ['rotating_light', r.rule],
          });
        }
      } else {
        const id = String(existing['id']);
        const prevState = String(existing['state']) as AlertState;
        const pendingSinceMs = Date.parse(
          String(existing['pending_since'] ?? existing['first_seen']),
        );
        const snoozedUntil =
          typeof existing['snoozed_until'] === 'string' ? Date.parse(existing['snoozed_until']) : 0;
        const isAcked = Boolean(existing['acked_at']);
        const isSnoozed = snoozedUntil > nowMs;

        let nextState = prevState;
        let transitionedToFiring = false;
        if (prevState === 'pending' && nowMs - pendingSinceMs >= r.pending_seconds * 1000) {
          nextState = 'firing';
          transitionedToFiring = true;
        }

        this.deps.db.db
          .prepare(
            'UPDATE alerts SET state = ?, last_seen = ?, summary = ?, payload_json = ? WHERE id = ?',
          )
          .run(nextState, nowIso, finding.summary, JSON.stringify(finding.payload), id);

        if (transitionedToFiring && !isAcked && !isSnoozed) {
          await this.sendOrQueueNotification({
            title: `[${r.severity.toUpperCase()}] ${r.rule}`,
            message: finding.summary,
            priority: r.severity === 'critical' ? 5 : 4,
            tags: ['rotating_light', r.rule],
          });
        }
      }
    }

    if (this.deps.healthchecks) {
      await this.deps.healthchecks.ping('ok');
    }

    const active = this.listAlerts({ includeResolved: false });
    return {
      firing: active.filter((a) => a.state === 'firing').length,
      pending: active.filter((a) => a.state === 'pending').length,
      resolved_count: resolvedCount,
      flushed_notifications: flushedNotifications,
    };
  }

  public async maybeSendDailyDigest(now = new Date()): Promise<boolean> {
    const dayKey = now.toISOString().slice(0, 10);
    if (this.lastDigestDate === dayKey) return false;
    this.lastDigestDate = dayKey;
    const open = this.listAlerts({ includeResolved: false });
    await this.sendOrQueueNotification({
      title: `homemcp Daily Digest (${dayKey})`,
      message: `${open.length} open alert(s)`,
      priority: 2,
      tags: ['clipboard'],
    });
    return true;
  }

  public start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.evaluateOnce();
    }, intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
