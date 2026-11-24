import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signAgentRequest } from '../src/auth.js';
import type { CommandRunner, ExecResult } from '../src/exec.js';
import { VerbRegistry } from '../src/registry.js';
import { startAgentServer } from '../src/server.js';
import { registerBackupReadVerbs } from '../src/verbs/backup-read.js';
import { registerStacksReadVerbs } from '../src/verbs/stacks-read.js';
import { registerSystemReadVerbs } from '../src/verbs/system-read.js';

class FakeRunner implements CommandRunner {
  public run(binary: string, args: readonly string[]): Promise<ExecResult> {
    return Promise.resolve(this.runSync(binary, args));
  }

  private runSync(binary: string, args: readonly string[]): ExecResult {
    if (binary === '/usr/bin/systemctl' && args[0] === '--failed') {
      return { stdout: '[]', stderr: '', exitCode: 0 };
    }
    if (binary === '/usr/bin/systemctl' && args[0] === 'show') {
      return {
        stdout: [
          `Id=${args[1]}`,
          'ActiveState=active',
          'SubState=running',
          'Description=Test Service',
          'MainPID=1234',
          'NRestarts=0',
          'MemoryCurrent=52428800',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/journalctl' && args.includes('-k')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (binary === '/usr/bin/journalctl') {
      return {
        stdout: [
          JSON.stringify({
            __REALTIME_TIMESTAMP: '1700000000000000',
            _SYSTEMD_UNIT: 'kernel',
            PRIORITY: '3',
            MESSAGE: 'ACPI Error: AE_NOT_EXIST while resolving SystemCMOS',
          }),
          JSON.stringify({
            __REALTIME_TIMESTAMP: '1700000001000000',
            _SYSTEMD_UNIT: 'nginx.service',
            PRIORITY: '3',
            MESSAGE: 'upstream timed out [1234] 0xdeadbeef',
          }),
          JSON.stringify({
            __REALTIME_TIMESTAMP: '1700000002000000',
            _SYSTEMD_UNIT: 'nginx.service',
            PRIORITY: '3',
            MESSAGE: 'upstream timed out [5678] 0xcafebabe',
          }),
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/sadf') {
      return {
        stdout: JSON.stringify({
          sysstat: {
            hosts: [
              {
                statistics: Array.from({ length: 200 }, (_, i) => ({
                  timestamp: i,
                  'cpu-load': [{ user: 10 + (i % 5) }],
                })),
              },
            ],
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/df' && args.includes('-T')) {
      return {
        stdout: [
          'Filesystem Type 1B-blocks Used Available Use% Mounted on',
          '/dev/sda1 ext4 1000000000 700000000 300000000 70% /mnt/storage',
          'tmpfs tmpfs 1000 0 1000 0% /tmp',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/df' && args.includes('-i')) {
      return {
        stdout: [
          'Filesystem Inodes IUsed IFree IUse% Mounted on',
          '/dev/sda1 100000 25000 75000 25% /mnt/storage',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/ps') {
      return {
        stdout: '101 homelab 12.5 3.1 102400 3600 node /opt/app/index.js --token supersecret999\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/apt-get') {
      return {
        stdout: [
          'Inst libssl3t64 [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])',
          'Inst curl [8.5.0-2ubuntu10] (8.5.0-2ubuntu10.1 Ubuntu:24.04/noble-updates [amd64])',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/ss') {
      return {
        stdout: 'tcp LISTEN 0 128 127.0.0.1:8191 0.0.0.0:*\ntcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/tailscale') {
      return {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { TailscaleIPs: ['100.64.0.10'], DNSName: 'homelab.tailnet.ts.net.' },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/ip' && args.includes('addr')) {
      return {
        stdout: JSON.stringify([
          { ifname: 'eth0', operstate: 'UP', addr_info: [{ local: '192.0.2.10', prefixlen: 24 }] },
        ]),
        stderr: '',
        exitCode: 0,
      };
    }
    if (binary === '/usr/bin/ip' && args.includes('route')) {
      return { stdout: JSON.stringify([{ dst: 'default', gateway: '192.0.2.1' }]), stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

describe('P1 agent verbs and HTTP-over-socket server', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('executes all P1 read verbs and never exposes .env contents', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homemcp-agent-'));
    dirs.push(tmp);

    const procDir = path.join(tmp, 'proc');
    const sysDir = path.join(tmp, 'sys');
    const varRunDir = path.join(tmp, 'run');
    const varLogDir = path.join(tmp, 'log');
    const statusDir = path.join(tmp, 'status');
    const backupDir = path.join(tmp, 'backup');
    const stacksRoot = path.join(tmp, 'stacks');

    await mkdir(procDir, { recursive: true });
    await mkdir(path.join(sysDir, 'class/thermal/thermal_zone0'), { recursive: true });
    await mkdir(path.join(sysDir, 'class/power_supply/BAT1'), { recursive: true });
    await mkdir(path.join(sysDir, 'class/power_supply/ACAD'), { recursive: true });
    await mkdir(varRunDir, { recursive: true });
    await mkdir(varLogDir, { recursive: true });
    await mkdir(statusDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    await mkdir(path.join(stacksRoot, 'myapp'), { recursive: true });

    await writeFile(path.join(procDir, 'loadavg'), '0.25 0.15 0.10 1/200 1234\n');
    await writeFile(path.join(procDir, 'uptime'), '3600.5 7200.0\n');
    await writeFile(path.join(procDir, 'stat'), 'cpu  1000 0 500 8500 0 0 0 0 0 0\n');
    await writeFile(
      path.join(procDir, 'meminfo'),
      'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    );
    await writeFile(path.join(sysDir, 'class/thermal/thermal_zone0/type'), 'x86_pkg_temp\n');
    await writeFile(path.join(sysDir, 'class/thermal/thermal_zone0/temp'), '54000\n');
    await writeFile(path.join(sysDir, 'class/power_supply/BAT1/capacity'), '95\n');
    await writeFile(path.join(sysDir, 'class/power_supply/BAT1/status'), 'Not charging\n');
    await writeFile(path.join(sysDir, 'class/power_supply/BAT1/charge_full'), '3200000\n');
    await writeFile(path.join(sysDir, 'class/power_supply/BAT1/charge_full_design'), '3600000\n');
    await writeFile(path.join(sysDir, 'class/power_supply/ACAD/online'), '1\n');

    await writeFile(path.join(statusDir, 'ufw.txt'), 'Status: active\n');
    await writeFile(path.join(statusDir, 'sshd.txt'), 'passwordauthentication no\n');
    await writeFile(
      path.join(statusDir, 'smart-sda.json'),
      JSON.stringify({
        model_name: 'TestDisk 1TB',
        serial_number: 'SN123',
        smart_status: { passed: true },
        temperature: { current: 35 },
        power_on_time: { hours: 1000 },
        ata_smart_attributes: { table: [{ id: 5, name: 'Reallocated_Sector_Ct', raw: { value: 0 } }] },
      }),
    );

    await writeFile(
      path.join(varLogDir, 'auth.log'),
      'Nov 24 08:00:00 host sshd[1]: Failed password for invalid user admin from 203.0.113.5 port 22\n',
    );
    const resolvPath = path.join(tmp, 'resolv.conf');
    await writeFile(resolvPath, 'nameserver 1.1.1.1\n');

    await writeFile(
      path.join(backupDir, 'status.json'),
      JSON.stringify({ vaultwarden: { last_status: 'success' } }),
    );
    await writeFile(path.join(backupDir, 'snapshots.json'), JSON.stringify([{ id: 'abc12345' }]));
    await writeFile(path.join(backupDir, 'stats.json'), JSON.stringify({ total_size: 1024000 }));

    // Secret in .env must NEVER appear in stacks.scan output
    const canarySecret = 'TOP_SECRET_CANARY_VALUE_999';
    await writeFile(
      path.join(stacksRoot, 'myapp', '.env'),
      `APP_SECRET=${canarySecret}\n`,
    );
    await writeFile(
      path.join(stacksRoot, 'myapp', 'docker-compose.yml'),
      'services:\n  app:\n    image: alpine:3.20\n    restart: unless-stopped\n    mem_limit: 128m\n    pids_limit: 64\n',
    );

    const registry = new VerbRegistry();
    registerSystemReadVerbs(registry, {
      runner: new FakeRunner(),
      allowedUnits: ['smbd.service'],
      knownNoise: ['SystemCMOS', 'AE_NOT_EXIST'],
      procDir,
      sysDir,
      varRunDir,
      varLogDir,
      statusDir,
      resolvConfPath: resolvPath,
    });
    registerStacksReadVerbs(registry, {
      stackRoots: [stacksRoot],
      mediaRoot: '/mnt/storage/media',
      composeAllow: {},
    });
    registerBackupReadVerbs(registry, backupDir);

    const hmacSecret = 'agent-hmac-test-secret-012345';
    const srv = await startAgentServer({ tcpPort: 0, hmacSecret, registry });

    try {
      const callRpc = async (verb: string, params: Record<string, unknown> = {}) => {
        const rawBody = JSON.stringify({ verb, params });
        const headers = signAgentRequest(hmacSecret, 'POST', rawBody);
        const resp = await fetch(`${srv.address}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: rawBody,
        });
        return { status: resp.status, data: (await resp.json()) as { ok: boolean; result?: unknown; error?: unknown } };
      };

      const health = await callRpc('system.health');
      expect(health.status).toBe(200);
      expect((health.data.result as { battery?: { ac_online?: boolean } }).battery?.ac_online).toBe(true);

      const metrics = await callRpc('system.metrics_history', { group: 'cpu', max_points: 50 });
      expect((metrics.data.result as { points: unknown[]; truncated: boolean }).points.length).toBeLessThanOrEqual(50);
      expect((metrics.data.result as { truncated: boolean }).truncated).toBe(true);

      const disks = await callRpc('system.disks');
      expect((disks.data.result as { smart_summary: Array<{ device: string }> }).smart_summary[0]?.device).toBe('sda');

      const smart = await callRpc('system.smart_details', { device: 'sda' });
      expect((smart.data.result as { passed: boolean }).passed).toBe(true);

      const procs = await callRpc('system.processes');
      expect(JSON.stringify(procs.data.result)).not.toContain('supersecret999');

      const errs = await callRpc('system.errors_summary');
      const sigs = (errs.data.result as { signatures: Array<{ count: number; known_noise: boolean }> }).signatures;
      expect(sigs.some((s) => s.count === 2)).toBe(true);
      expect(sigs.some((s) => s.known_noise)).toBe(true);

      const updates = await callRpc('system.updates');
      expect((updates.data.result as { security_count: number }).security_count).toBe(1);

      const sec = await callRpc('system.security_audit');
      expect((sec.data.result as { failed_ssh_logins_24h: number }).failed_ssh_logins_24h).toBe(1);

      const net = await callRpc('system.network');
      expect((net.data.result as { nameservers: string[] }).nameservers).toContain('1.1.1.1');

      const svcs = await callRpc('system.services');
      expect((svcs.data.result as { services: Array<{ unit: string }> }).services[0]?.unit).toBe('smbd.service');

      const deniedSvc = await callRpc('system.services', { units: ['ssh.service'] });
      expect(deniedSvc.status).toBe(403);

      const stacks = await callRpc('stacks.scan');
      const serialized = JSON.stringify(stacks.data.result);
      expect(serialized).toContain('myapp');
      expect(serialized).not.toContain(canarySecret);

      const bkp = await callRpc('backup.read_status');
      expect((bkp.data.result as { stats: { total_size: number } }).stats.total_size).toBe(1024000);
    } finally {
      await srv.close();
    }
  });
});
