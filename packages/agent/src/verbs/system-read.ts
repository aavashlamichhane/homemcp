import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { HomemcpError } from '@homemcp/core';
import type { CommandRunner } from '../exec.js';
import type { VerbRegistry } from '../registry.js';

export interface SystemVerbConfig {
  runner: CommandRunner;
  allowedUnits: readonly string[];
  knownNoise: readonly string[];
  procDir?: string | undefined;
  sysDir?: string | undefined;
  varRunDir?: string | undefined;
  varLogDir?: string | undefined;
  statusDir?: string | undefined;
  resolvConfPath?: string | undefined;
}

async function readTextOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function asStr(val: unknown, fallback = ''): string {
  return typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'
    ? String(val)
    : fallback;
}

function parseCpuSample(procStat: string): { total: number; idle: number } {
  const firstLine = procStat.split('\n').find((l) => l.startsWith('cpu '));
  if (!firstLine) return { total: 0, idle: 0 };
  const parts = firstLine
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((n) => Number(n));
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
  return { total, idle };
}

function normalizeLogSignature(msg: string): string {
  return msg
    .replace(/0x[0-9a-f]+/gi, '0xHEX')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
    .replace(/\[\d+\]/g, '[<PID>]')
    .replace(/\b\d+\b/g, '<N>')
    .slice(0, 200);
}

export function registerSystemReadVerbs(registry: VerbRegistry, cfg: SystemVerbConfig): void {
  const procDir = cfg.procDir ?? '/proc';
  const sysDir = cfg.sysDir ?? '/sys';
  const varRunDir = cfg.varRunDir ?? '/var/run';
  const varLogDir = cfg.varLogDir ?? '/var/log';
  const statusDir = cfg.statusDir ?? '/var/lib/homemcp/status';
  const resolvConfPath = cfg.resolvConfPath ?? '/etc/resolv.conf';

  // 1. system.health
  registry.register({
    name: 'system.health',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      load_avg: z.tuple([z.number(), z.number(), z.number()]),
      cpu_percent: z.number(),
      uptime_seconds: z.number(),
      mem_total_bytes: z.number(),
      mem_available_bytes: z.number(),
      swap_total_bytes: z.number(),
      swap_free_bytes: z.number(),
      temperatures: z.array(z.object({ label: z.string(), temp_c: z.number() })),
      battery: z
        .object({
          present: z.boolean(),
          capacity_percent: z.number().optional(),
          status: z.string().optional(),
          wear_percent: z.number().optional(),
          ac_online: z.boolean().optional(),
        })
        .optional(),
      reboot_required: z.boolean(),
      failed_units: z.array(z.string()),
      oom_events_24h: z.number().int(),
    }),
    handler: async () => {
      const loadRaw = (await readTextOptional(path.join(procDir, 'loadavg'))) ?? '0 0 0';
      const loadParts = loadRaw.trim().split(/\s+/);
      const loadAvg: [number, number, number] = [
        Number(loadParts[0] ?? 0),
        Number(loadParts[1] ?? 0),
        Number(loadParts[2] ?? 0),
      ];

      const uptimeRaw = (await readTextOptional(path.join(procDir, 'uptime'))) ?? '0 0';
      const uptimeSeconds = Number(uptimeRaw.trim().split(/\s+/)[0] ?? 0);

      const stat1 = await readTextOptional(path.join(procDir, 'stat'));
      let cpuPercent = 0;
      if (stat1) {
        const s1 = parseCpuSample(stat1);
        await new Promise((r) => setTimeout(r, 100));
        const stat2 = (await readTextOptional(path.join(procDir, 'stat'))) ?? stat1;
        const s2 = parseCpuSample(stat2);
        const dt = s2.total - s1.total;
        const di = s2.idle - s1.idle;
        cpuPercent = dt > 0 ? Math.round(((dt - di) / dt) * 1000) / 10 : 0;
      }

      const meminfoRaw = (await readTextOptional(path.join(procDir, 'meminfo'))) ?? '';
      const memMap = new Map<string, number>();
      for (const line of meminfoRaw.split('\n')) {
        const m = /^([^:]+):\s+(\d+)/.exec(line);
        if (m) memMap.set(m[1]!, Number(m[2]!) * 1024);
      }

      // Thermal zones
      const temperatures: Array<{ label: string; temp_c: number }> = [];
      const thermalBase = path.join(sysDir, 'class/thermal');
      try {
        const entries = await readdir(thermalBase);
        for (const entry of entries.sort()) {
          if (!entry.startsWith('thermal_zone')) continue;
          const zType = (await readTextOptional(path.join(thermalBase, entry, 'type')))?.trim();
          const zTemp = (await readTextOptional(path.join(thermalBase, entry, 'temp')))?.trim();
          if (zType && zTemp && /^-?\d+$/.test(zTemp)) {
            temperatures.push({ label: zType, temp_c: Number(zTemp) / 1000 });
          }
        }
      } catch {
        // Thermal directory absent in some VMs/containers
      }

      // Battery & AC
      const batBase = path.join(sysDir, 'class/power_supply/BAT1');
      const acPath = path.join(sysDir, 'class/power_supply/ACAD/online');
      let battery:
        | {
            present: boolean;
            capacity_percent?: number | undefined;
            status?: string | undefined;
            wear_percent?: number | undefined;
            ac_online?: boolean | undefined;
          }
        | undefined;
      if (await exists(batBase)) {
        const cap = Number((await readTextOptional(path.join(batBase, 'capacity')))?.trim() ?? 'NaN');
        const statusStr = (await readTextOptional(path.join(batBase, 'status')))?.trim();
        const full = Number(
          (await readTextOptional(path.join(batBase, 'charge_full')))?.trim() ?? 'NaN',
        );
        const design = Number(
          (await readTextOptional(path.join(batBase, 'charge_full_design')))?.trim() ?? 'NaN',
        );
        const acStr = (await readTextOptional(acPath))?.trim();
        const wearPercent =
          Number.isFinite(full) && Number.isFinite(design) && design > 0
            ? Math.max(0, Math.round((1 - full / design) * 1000) / 10)
            : undefined;
        battery = {
          present: true,
          ...(Number.isFinite(cap) ? { capacity_percent: cap } : {}),
          ...(statusStr ? { status: statusStr } : {}),
          ...(wearPercent !== undefined ? { wear_percent: wearPercent } : {}),
          ...(acStr === '1' || acStr === '0' ? { ac_online: acStr === '1' } : {}),
        };
      }

      const rebootRequired = await exists(path.join(varRunDir, 'reboot-required'));

      let failedUnits: string[] = [];
      try {
        const failedRes = await cfg.runner.run(
          '/usr/bin/systemctl',
          ['--failed', '--output=json', '--no-pager'],
          { allowNonZero: true },
        );
        if (failedRes.stdout.trim().startsWith('[')) {
          const parsed = JSON.parse(failedRes.stdout) as Array<{ unit?: string }>;
          failedUnits = parsed.map((u) => u.unit).filter((u): u is string => Boolean(u));
        }
      } catch {
        failedUnits = [];
      }

      let oomEvents = 0;
      try {
        const oomRes = await cfg.runner.run(
          '/usr/bin/journalctl',
          ['-k', '--since', '-24h', '--grep=Out of memory|oom-kill', '--output=json', '--no-pager'],
          { allowNonZero: true },
        );
        oomEvents = oomRes.stdout
          .split('\n')
          .filter((l) => l.trim().startsWith('{')).length;
      } catch {
        oomEvents = 0;
      }

      return {
        load_avg: loadAvg,
        cpu_percent: cpuPercent,
        uptime_seconds: uptimeSeconds,
        mem_total_bytes: memMap.get('MemTotal') ?? 0,
        mem_available_bytes: memMap.get('MemAvailable') ?? 0,
        swap_total_bytes: memMap.get('SwapTotal') ?? 0,
        swap_free_bytes: memMap.get('SwapFree') ?? 0,
        temperatures,
        ...(battery ? { battery } : {}),
        reboot_required: rebootRequired,
        failed_units: failedUnits,
        oom_events_24h: oomEvents,
      };
    },
  });

  // 2. system.metrics_history
  registry.register({
    name: 'system.metrics_history',
    inputSchema: z
      .object({
        group: z.enum(['cpu', 'mem', 'io', 'net', 'load']).default('cpu'),
        day: z.string().regex(/^\d{2}$/).optional(),
        max_points: z.number().int().min(10).max(120).default(120),
      })
      .strict(),
    outputSchema: z.object({
      group: z.string(),
      points: z.array(z.record(z.string(), z.unknown())),
      truncated: z.boolean(),
    }),
    handler: async ({ group, day, max_points }) => {
      const dd = day ?? String(new Date().getDate()).padStart(2, '0');
      const saFile = path.posix.join(varLogDir, 'sysstat', `sa${dd}`);
      const flagMap: Record<string, string[]> = {
        cpu: ['-u'],
        mem: ['-r'],
        io: ['-b'],
        net: ['-n', 'DEV'],
        load: ['-q'],
      };
      const res = await cfg.runner.run(
        '/usr/bin/sadf',
        ['-j', saFile, '--', ...(flagMap[group] ?? ['-u'])],
        { allowNonZero: true },
      );
      if (res.exitCode !== 0 || !res.stdout.trim()) {
        return { group, points: [], truncated: false };
      }
      const parsed = JSON.parse(res.stdout) as {
        sysstat?: { hosts?: Array<{ statistics?: Array<Record<string, unknown>> }> };
      };
      const stats = parsed.sysstat?.hosts?.[0]?.statistics ?? [];
      if (stats.length <= max_points) {
        return { group, points: stats, truncated: false };
      }
      const step = Math.ceil(stats.length / max_points);
      const downsampled = stats.filter((_, idx) => idx % step === 0).slice(0, max_points);
      return { group, points: downsampled, truncated: true };
    },
  });

  // 3a. system.disks
  registry.register({
    name: 'system.disks',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      filesystems: z.array(
        z.object({
          filesystem: z.string(),
          mountpoint: z.string(),
          size_bytes: z.number(),
          used_bytes: z.number(),
          available_bytes: z.number(),
          use_percent: z.number(),
          inodes_total: z.number().optional(),
          inodes_used: z.number().optional(),
        }),
      ),
      smart_summary: z.array(
        z.object({
          device: z.string(),
          model: z.string(),
          passed: z.boolean(),
          temp_c: z.number().optional(),
          power_on_hours: z.number().optional(),
          reallocated_sectors: z.number().optional(),
          pending_sectors: z.number().optional(),
        }),
      ),
    }),
    handler: async () => {
      const dfRes = await cfg.runner.run('/usr/bin/df', ['-B1', '-P', '-T'], { allowNonZero: false });
      const inodeRes = await cfg.runner.run('/usr/bin/df', ['-i', '-P'], { allowNonZero: true });

      const inodeMap = new Map<string, { total: number; used: number }>();
      for (const line of inodeRes.stdout.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 6 && /^\d+$/.test(cols[1] ?? '')) {
          inodeMap.set(cols[5]!, { total: Number(cols[1]), used: Number(cols[2]) });
        }
      }

      const excludedFs = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs']);
      const filesystems: Array<{
        filesystem: string;
        mountpoint: string;
        size_bytes: number;
        used_bytes: number;
        available_bytes: number;
        use_percent: number;
        inodes_total?: number | undefined;
        inodes_used?: number | undefined;
      }> = [];

      for (const line of dfRes.stdout.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 7) continue;
        const [fsName, fsType, sizeS, usedS, availS, pctS, mount] = cols;
        if (!fsType || excludedFs.has(fsType) || !mount) continue;
        const inodes = inodeMap.get(mount);
        filesystems.push({
          filesystem: fsName ?? '',
          mountpoint: mount,
          size_bytes: Number(sizeS ?? 0),
          used_bytes: Number(usedS ?? 0),
          available_bytes: Number(availS ?? 0),
          use_percent: Number((pctS ?? '0').replace('%', '')),
          ...(inodes ? { inodes_total: inodes.total, inodes_used: inodes.used } : {}),
        });
      }

      const smartSummary: Array<{
        device: string;
        model: string;
        passed: boolean;
        temp_c?: number | undefined;
        power_on_hours?: number | undefined;
        reallocated_sectors?: number | undefined;
        pending_sectors?: number | undefined;
      }> = [];

      try {
        const files = await readdir(statusDir);
        for (const f of files.sort()) {
          if (!f.startsWith('smart-') || !f.endsWith('.json')) continue;
          const raw = await readTextOptional(path.join(statusDir, f));
          if (!raw) continue;
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const dev = f.slice('smart-'.length, -'.json'.length);
          const model = asStr(parsed['model_name'], 'unknown');
          const smartStatus = parsed['smart_status'] as { passed?: boolean } | undefined;
          const temp = (parsed['temperature'] as { current?: number } | undefined)?.current;
          const poh = (parsed['power_on_time'] as { hours?: number } | undefined)?.hours;
          const attrs = (
            parsed['ata_smart_attributes'] as
              | { table?: Array<{ id?: number; raw?: { value?: number } }> }
              | undefined
          )?.table;
          const realloc = attrs?.find((a) => a.id === 5)?.raw?.value;
          const pending = attrs?.find((a) => a.id === 197)?.raw?.value;

          smartSummary.push({
            device: dev,
            model,
            passed: smartStatus?.passed ?? true,
            ...(temp !== undefined ? { temp_c: temp } : {}),
            ...(poh !== undefined ? { power_on_hours: poh } : {}),
            ...(realloc !== undefined ? { reallocated_sectors: realloc } : {}),
            ...(pending !== undefined ? { pending_sectors: pending } : {}),
          });
        }
      } catch {
        // status dir optional in dev
      }

      return { filesystems, smart_summary: smartSummary };
    },
  });

  // 3b. system.smart_details
  registry.register({
    name: 'system.smart_details',
    inputSchema: z.object({ device: z.string().regex(/^[a-z0-9_-]+$/) }).strict(),
    outputSchema: z.object({
      device: z.string(),
      model: z.string(),
      serial_number: z.string().optional(),
      passed: z.boolean(),
      temp_c: z.number().optional(),
      power_on_hours: z.number().optional(),
      attributes: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          value: z.number().optional(),
          worst: z.number().optional(),
          thresh: z.number().optional(),
          raw_value: z.number().optional(),
        }),
      ),
    }),
    handler: async ({ device }) => {
      const raw = await readTextOptional(path.join(statusDir, `smart-${device}.json`));
      if (!raw) {
        throw new HomemcpError('NOT_FOUND', `SMART report not found for device: ${device}`);
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const smartStatus = parsed['smart_status'] as { passed?: boolean } | undefined;
      const temp = (parsed['temperature'] as { current?: number } | undefined)?.current;
      const poh = (parsed['power_on_time'] as { hours?: number } | undefined)?.hours;
      const table =
        (
          parsed['ata_smart_attributes'] as
            | {
                table?: Array<{
                  id?: number;
                  name?: string;
                  value?: number;
                  worst?: number;
                  thresh?: number;
                  raw?: { value?: number };
                }>;
              }
            | undefined
        )?.table ?? [];

      const serial = asStr(parsed['serial_number']);
      return {
        device,
        model: asStr(parsed['model_name'], 'unknown'),
        ...(serial ? { serial_number: serial } : {}),
        passed: smartStatus?.passed ?? true,
        ...(temp !== undefined ? { temp_c: temp } : {}),
        ...(poh !== undefined ? { power_on_hours: poh } : {}),
        attributes: table
          .filter((a) => a.id !== undefined && a.name !== undefined)
          .map((a) => ({
            id: a.id!,
            name: a.name!,
            ...(a.value !== undefined ? { value: a.value } : {}),
            ...(a.worst !== undefined ? { worst: a.worst } : {}),
            ...(a.thresh !== undefined ? { thresh: a.thresh } : {}),
            ...(a.raw?.value !== undefined ? { raw_value: a.raw.value } : {}),
          })),
      };
    },
  });

  // 4. system.processes
  registry.register({
    name: 'system.processes',
    inputSchema: z
      .object({
        sort_by: z.enum(['cpu', 'mem']).default('cpu'),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict(),
    outputSchema: z.object({
      processes: z.array(
        z.object({
          pid: z.number().int(),
          user: z.string(),
          cpu_percent: z.number(),
          mem_percent: z.number(),
          rss_bytes: z.number(),
          elapsed_seconds: z.number().int(),
          comm: z.string(),
          args: z.string(),
        }),
      ),
    }),
    handler: async ({ sort_by, limit }) => {
      const sortFlag = sort_by === 'mem' ? '--sort=-pmem' : '--sort=-pcpu';
      const res = await cfg.runner.run('/usr/bin/ps', [
        '-eo',
        'pid=,user=,pcpu=,pmem=,rss=,etimes=,comm=,args=',
        sortFlag,
      ]);
      const processes = res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => {
          const m = /^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(
            line,
          );
          if (!m) return undefined;
          return {
            pid: Number(m[1]),
            user: m[2]!,
            cpu_percent: Number(m[3]),
            mem_percent: Number(m[4]),
            rss_bytes: Number(m[5]) * 1024,
            elapsed_seconds: Number(m[6]),
            comm: m[7]!,
            args: m[8] ?? '',
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== undefined);

      return { processes };
    },
  });

  // 5a. system.logs_query
  registry.register({
    name: 'system.logs_query',
    inputSchema: z
      .object({
        unit: z.string().optional(),
        priority: z.number().int().min(0).max(7).optional(),
        since: z.string().default('-24h'),
        until: z.string().optional(),
        grep: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(200),
      })
      .strict(),
    outputSchema: z.object({
      entries: z.array(
        z.object({
          ts: z.string(),
          unit: z.string(),
          priority: z.number().int(),
          message: z.string(),
        }),
      ),
    }),
    handler: async ({ unit, priority, since, until, grep, limit }) => {
      const args = ['--output=json', '--no-pager', '-n', String(limit), '--since', since];
      if (unit) args.push('-u', unit);
      if (priority !== undefined) args.push('-p', String(priority));
      if (until) args.push('--until', until);
      if (grep) args.push('-g', grep);

      const res = await cfg.runner.run('/usr/bin/journalctl', args, { allowNonZero: true });
      const entries: Array<{ ts: string; unit: string; priority: number; message: string }> = [];
      for (const line of res.stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          const tsUs = Number(rec['__REALTIME_TIMESTAMP'] ?? 0);
          const ts = tsUs > 0 ? new Date(Math.floor(tsUs / 1000)).toISOString() : '';
          entries.push({
            ts,
            unit: asStr(rec['_SYSTEMD_UNIT'] ?? rec['SYSLOG_IDENTIFIER'], 'kernel'),
            priority: Number(rec['PRIORITY'] ?? 6),
            message: asStr(rec['MESSAGE']),
          });
        } catch {
          // ignore malformed journal line
        }
      }
      return { entries };
    },
  });

  // 5b. system.errors_summary
  registry.register({
    name: 'system.errors_summary',
    inputSchema: z
      .object({
        since: z.enum(['24h', '7d']).default('24h'),
        limit: z.number().int().min(1).max(100).default(30),
      })
      .strict(),
    outputSchema: z.object({
      since: z.string(),
      total_errors: z.number().int(),
      signatures: z.array(
        z.object({
          signature: z.string(),
          unit: z.string(),
          count: z.number().int(),
          known_noise: z.boolean(),
          sample: z.string(),
        }),
      ),
    }),
    handler: async ({ since, limit }) => {
      const sinceArg = since === '7d' ? '-7d' : '-24h';
      const res = await cfg.runner.run(
        '/usr/bin/journalctl',
        ['-p', '0..3', '--since', sinceArg, '--output=json', '--no-pager', '-n', '2000'],
        { allowNonZero: true },
      );
      const groups = new Map<
        string,
        { signature: string; unit: string; count: number; known_noise: boolean; sample: string }
      >();
      let total = 0;

      for (const line of res.stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          const msg = asStr(rec['MESSAGE']);
          const unit = asStr(rec['_SYSTEMD_UNIT'] ?? rec['SYSLOG_IDENTIFIER'], 'kernel');
          const sig = normalizeLogSignature(msg);
          const key = `${unit}::${sig}`;
          total++;
          const existing = groups.get(key);
          if (existing) {
            existing.count++;
          } else {
            const knownNoise = cfg.knownNoise.some((pat) => msg.includes(pat));
            groups.set(key, { signature: sig, unit, count: 1, known_noise: knownNoise, sample: msg });
          }
        } catch {
          // skip
        }
      }

      const signatures = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
      return { since, total_errors: total, signatures };
    },
  });

  // 6. system.updates
  registry.register({
    name: 'system.updates',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      upgradable_count: z.number().int(),
      security_count: z.number().int(),
      packages: z.array(
        z.object({
          name: z.string(),
          version: z.string(),
          security: z.boolean(),
        }),
      ),
      reboot_required: z.boolean(),
      reboot_required_packages: z.array(z.string()),
      unattended_upgrades_last_log: z.string().optional(),
    }),
    handler: async () => {
      const aptRes = await cfg.runner.run(
        '/usr/bin/apt-get',
        ['-s', '-o', 'Debug::NoLocking=true', 'upgrade'],
        { allowNonZero: true },
      );
      const packages: Array<{ name: string; version: string; security: boolean }> = [];
      for (const line of aptRes.stdout.split('\n')) {
        const m = /^Inst\s+(\S+)\s+\[[^\]]+\]\s+\(([^\s)]+)[^)]*\)/.exec(line);
        if (m) {
          packages.push({
            name: m[1]!,
            version: m[2]!,
            security: /security/i.test(line),
          });
        }
      }

      const rebootRequired = await exists(path.join(varRunDir, 'reboot-required'));
      const pkgsRaw = await readTextOptional(path.join(varRunDir, 'reboot-required.pkgs'));
      const rebootPkgs = pkgsRaw
        ? pkgsRaw
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      let unattendedLast: string | undefined;
      try {
        const logPath = path.join(varLogDir, 'unattended-upgrades/unattended-upgrades.log');
        const st = await stat(logPath);
        unattendedLast = st.mtime.toISOString();
      } catch {
        unattendedLast = undefined;
      }

      return {
        upgradable_count: packages.length,
        security_count: packages.filter((p) => p.security).length,
        packages,
        reboot_required: rebootRequired,
        reboot_required_packages: rebootPkgs,
        ...(unattendedLast ? { unattended_upgrades_last_log: unattendedLast } : {}),
      };
    },
  });

  // 7. system.security_audit
  registry.register({
    name: 'system.security_audit',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      ufw_status: z.string(),
      sshd_effective: z.record(z.string(), z.string()),
      listening_sockets: z.array(
        z.object({
          proto: z.string(),
          address: z.string(),
          port: z.string(),
          wildcard: z.boolean(),
        }),
      ),
      failed_ssh_logins_24h: z.number().int(),
      failed_ssh_source_ips: z.record(z.string(), z.number().int()),
      tailscale: z.object({
        backend_state: z.string(),
        tailnet_ips: z.array(z.string()),
        self_dns_name: z.string().optional(),
      }),
    }),
    handler: async () => {
      const ufwTxt = (await readTextOptional(path.join(statusDir, 'ufw.txt'))) ?? 'unknown';
      const sshdTxt = (await readTextOptional(path.join(statusDir, 'sshd.txt'))) ?? '';
      const sshdEffective: Record<string, string> = {};
      for (const line of sshdTxt.split('\n')) {
        const idx = line.indexOf(' ');
        if (idx > 0) {
          sshdEffective[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }

      const ssRes = await cfg.runner.run('/usr/bin/ss', ['-tulnH'], { allowNonZero: true });
      const listeningSockets: Array<{
        proto: string;
        address: string;
        port: string;
        wildcard: boolean;
      }> = [];
      for (const line of ssRes.stdout.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        const proto = cols[0] ?? '';
        const local = cols[4] ?? '';
        const lastColon = local.lastIndexOf(':');
        if (lastColon < 0) continue;
        const addr = local.slice(0, lastColon);
        const port = local.slice(lastColon + 1);
        const wildcard = addr === '0.0.0.0' || addr === '[::]' || addr === '*';
        listeningSockets.push({ proto, address: addr, port, wildcard });
      }

      const authLog = (await readTextOptional(path.join(varLogDir, 'auth.log'))) ?? '';
      let failedCount = 0;
      const ipCounts: Record<string, number> = {};
      for (const line of authLog.split('\n')) {
        if (/Failed password|Invalid user/i.test(line)) {
          failedCount++;
          const ipMatch = /\bfrom\s+([0-9a-f.:]+)/i.exec(line);
          if (ipMatch?.[1]) {
            ipCounts[ipMatch[1]] = (ipCounts[ipMatch[1]] ?? 0) + 1;
          }
        }
      }

      let tailscale = {
        backend_state: 'Unknown',
        tailnet_ips: [] as string[],
        self_dns_name: undefined as string | undefined,
      };
      try {
        const tsRes = await cfg.runner.run('/usr/bin/tailscale', ['status', '--json'], {
          allowNonZero: true,
        });
        if (tsRes.stdout.trim().startsWith('{')) {
          const ts = JSON.parse(tsRes.stdout) as {
            BackendState?: string;
            Self?: { TailscaleIPs?: string[]; DNSName?: string };
          };
          tailscale = {
            backend_state: ts.BackendState ?? 'Unknown',
            tailnet_ips: ts.Self?.TailscaleIPs ?? [],
            self_dns_name: ts.Self?.DNSName,
          };
        }
      } catch {
        // leave default
      }

      return {
        ufw_status: ufwTxt.trim(),
        sshd_effective: sshdEffective,
        listening_sockets: listeningSockets,
        failed_ssh_logins_24h: failedCount,
        failed_ssh_source_ips: ipCounts,
        tailscale: {
          backend_state: tailscale.backend_state,
          tailnet_ips: tailscale.tailnet_ips,
          ...(tailscale.self_dns_name ? { self_dns_name: tailscale.self_dns_name } : {}),
        },
      };
    },
  });

  // 8. system.network
  registry.register({
    name: 'system.network',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      interfaces: z.array(
        z.object({
          name: z.string(),
          state: z.string(),
          addresses: z.array(z.string()),
        }),
      ),
      routes: z.array(z.record(z.string(), z.unknown())),
      nameservers: z.array(z.string()),
    }),
    handler: async () => {
      const addrRes = await cfg.runner.run('/usr/bin/ip', ['-j', 'addr']);
      const routeRes = await cfg.runner.run('/usr/bin/ip', ['-j', 'route']);
      const resolv = (await readTextOptional(resolvConfPath)) ?? '';

      const rawIfaces = JSON.parse(addrRes.stdout) as Array<{
        ifname?: string;
        operstate?: string;
        addr_info?: Array<{ local?: string; prefixlen?: number }>;
      }>;
      const interfaces = rawIfaces.map((i) => ({
        name: i.ifname ?? '',
        state: i.operstate ?? 'UNKNOWN',
        addresses: (i.addr_info ?? [])
          .filter((a) => a.local !== undefined)
          .map((a) => `${a.local}/${a.prefixlen ?? 0}`),
      }));

      const routes = JSON.parse(routeRes.stdout) as Array<Record<string, unknown>>;
      const nameservers = resolv
        .split('\n')
        .map((l) => /^\s*nameserver\s+(\S+)/.exec(l)?.[1])
        .filter((s): s is string => Boolean(s));

      return { interfaces, routes, nameservers };
    },
  });

  // 9. system.services
  registry.register({
    name: 'system.services',
    inputSchema: z
      .object({
        units: z.array(z.string()).optional(),
      })
      .strict(),
    outputSchema: z.object({
      services: z.array(
        z.object({
          unit: z.string(),
          active_state: z.string(),
          sub_state: z.string(),
          description: z.string(),
          main_pid: z.number().int(),
          restarts: z.number().int(),
          memory_bytes: z.number().optional(),
        }),
      ),
    }),
    handler: async ({ units }) => {
      const requested = units && units.length > 0 ? units : [...cfg.allowedUnits];
      for (const u of requested) {
        if (!cfg.allowedUnits.includes(u)) {
          throw new HomemcpError('POLICY_DENIED', `Unit not in allowlist: ${u}`);
        }
      }
      const services: Array<{
        unit: string;
        active_state: string;
        sub_state: string;
        description: string;
        main_pid: number;
        restarts: number;
        memory_bytes?: number | undefined;
      }> = [];

      for (const unit of requested) {
        const res = await cfg.runner.run(
          '/usr/bin/systemctl',
          [
            'show',
            unit,
            '--property=Id,ActiveState,SubState,Description,MainPID,NRestarts,MemoryCurrent',
          ],
          { allowNonZero: true },
        );
        const props = new Map<string, string>();
        for (const line of res.stdout.split('\n')) {
          const eq = line.indexOf('=');
          if (eq > 0) {
            props.set(line.slice(0, eq), line.slice(eq + 1).trim());
          }
        }
        const memRaw = props.get('MemoryCurrent');
        const memBytes = memRaw && /^\d+$/.test(memRaw) ? Number(memRaw) : undefined;
        services.push({
          unit: props.get('Id') ?? unit,
          active_state: props.get('ActiveState') ?? 'unknown',
          sub_state: props.get('SubState') ?? 'unknown',
          description: props.get('Description') ?? '',
          main_pid: Number(props.get('MainPID') ?? 0),
          restarts: Number(props.get('NRestarts') ?? 0),
          ...(memBytes !== undefined ? { memory_bytes: memBytes } : {}),
        });
      }
      return { services };
    },
  });
}
