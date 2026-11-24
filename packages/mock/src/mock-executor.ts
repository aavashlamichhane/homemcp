import type { AgentExecutor } from '@homemcp/connectors';
import { HomemcpError, isDeniedPath, validateComposePolicy } from '@homemcp/core';
import type { MockState } from './fixtures.js';

export class MockExecutor implements AgentExecutor {
  public constructor(private readonly state: MockState) {}

  public healthz(): Promise<{ ok: boolean; verbs: string[] }> {
    return Promise.resolve({
      ok: true,
      verbs: [
        'system.health',
        'system.metrics_history',
        'system.disks',
        'system.smart_details',
        'system.processes',
        'system.logs_query',
        'system.errors_summary',
        'system.updates',
        'system.security_audit',
        'system.network',
        'system.services',
        'stacks.scan',
        'backup.read_status',
        'backup.run',
        'backup.verify',
        'backup.restore_test',
        'backup.restore_staging',
        'backup.prune_set',
        'docker.container_action',
        'docker.compose_update',
        'docker.prune',
        'system.service_action',
        'system.reboot',
        'stacks.apply',
        'stacks.up',
        'stacks.down',
        'stacks.remove',
        'files.list',
        'files.stat',
        'files.search',
        'files.disk_usage',
        'files.read',
        'files.mkdir',
        'files.write',
        'files.move',
        'files.trash',
      ],
    });
  }

  public call<T = unknown>(verb: string, params: Record<string, unknown> = {}): Promise<T> {
    return Promise.resolve().then(() => this.dispatch(verb, params) as T);
  }

  private dispatch(verb: string, params: Record<string, unknown>): unknown {
    switch (verb) {
      case 'system.health':
        return {
          load_avg: [0.18, 0.14, 0.11],
          cpu_percent: 9.4,
          uptime_seconds: 345_600,
          mem_total_bytes: 16_000_000_000,
          mem_available_bytes: 9_600_000_000,
          swap_total_bytes: 2_000_000_000,
          swap_free_bytes: 2_000_000_000,
          temperatures: [
            { label: 'x86_pkg_temp', temp_c: this.state.maxTempC },
            { label: 'pch_skylake', temp_c: 47.5 },
          ],
          battery: {
            present: true,
            capacity_percent: this.state.batteryPercent,
            status: this.state.acOnline ? 'Not charging' : 'Discharging',
            wear_percent: 11.2,
            ac_online: this.state.acOnline,
          },
          reboot_required: false,
          failed_units: [],
          oom_events_24h: 0,
        };

      case 'system.metrics_history':
        return {
          group: typeof params['group'] === 'string' ? params['group'] : 'cpu',
          points: Array.from({ length: 12 }, (_, i) => ({
            ts: new Date(Date.now() - (11 - i) * 300_000).toISOString(),
            value: 10 + (i % 4),
          })),
          truncated: false,
        };

      case 'system.disks': {
        const total = 1_000_000_000_000;
        const used = Math.round((total * this.state.diskUsedPercent) / 100);
        return {
          filesystems: [
            {
              filesystem: '/dev/mapper/vg-root',
              mountpoint: '/',
              size_bytes: 120_000_000_000,
              used_bytes: 48_000_000_000,
              available_bytes: 72_000_000_000,
              use_percent: 40,
            },
            {
              filesystem: '/dev/sda1',
              mountpoint: '/mnt/storage',
              size_bytes: total,
              used_bytes: used,
              available_bytes: total - used,
              use_percent: this.state.diskUsedPercent,
            },
          ],
          smart_summary: [
            {
              device: 'sda',
              model: 'ST1000LM035-MOCK',
              passed: true,
              temp_c: 36,
              power_on_hours: 14200,
              reallocated_sectors: 0,
              pending_sectors: 0,
            },
          ],
        };
      }

      case 'system.smart_details':
        if (params['device'] !== 'sda') {
          throw new HomemcpError('NOT_FOUND', `SMART report not found for device: ${String(params['device'])}`);
        }
        return {
          device: 'sda',
          model: 'ST1000LM035-MOCK',
          serial_number: 'MOCK-SN-001',
          passed: true,
          temp_c: 36,
          power_on_hours: 14200,
          attributes: [
            { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, raw_value: 0 },
            { id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, raw_value: 0 },
          ],
        };

      case 'system.processes':
        return {
          processes: [
            {
              pid: 2010,
              user: 'homelab',
              cpu_percent: 4.2,
              mem_percent: 2.8,
              rss_bytes: 420_000_000,
              elapsed_seconds: 86400,
              comm: 'jellyfin',
              args: '/usr/lib/jellyfin/bin/jellyfin',
            },
          ],
        };

      case 'system.logs_query':
        return {
          entries: [
            {
              ts: new Date().toISOString(),
              unit: 'systemd',
              priority: 6,
              message: 'Mock journal entry: system healthy',
            },
          ],
        };

      case 'system.errors_summary':
        return {
          since: typeof params['since'] === 'string' ? params['since'] : '24h',
          total_errors: 2,
          signatures: [
            {
              signature: 'ACPI Error: AE_NOT_EXIST while resolving SystemCMOS',
              unit: 'kernel',
              count: 2,
              known_noise: true,
              sample: 'ACPI Error: AE_NOT_EXIST while resolving SystemCMOS',
            },
          ],
        };

      case 'system.updates':
        return {
          upgradable_count: 3,
          security_count: 1,
          packages: [{ name: 'libssl3t64', version: '3.0.13-0ubuntu3.5', security: true }],
          reboot_required: false,
          reboot_required_packages: [],
        };

      case 'system.security_audit':
        return {
          ufw_status: 'Status: active',
          sshd_effective: {
            passwordauthentication: 'no',
            permitrootlogin: 'no',
            pubkeyauthentication: 'yes',
          },
          listening_sockets: [
            { proto: 'tcp', address: '192.0.2.10', port: '4533', wildcard: false },
            { proto: 'tcp', address: '127.0.0.1', port: '8191', wildcard: false },
          ],
          failed_ssh_logins_24h: 0,
          failed_ssh_source_ips: {},
          tailscale: {
            backend_state: 'Running',
            tailnet_ips: ['100.64.0.10'],
            self_dns_name: 'homelab-01.tailnet.ts.net.',
          },
        };

      case 'system.network':
        return {
          interfaces: [
            { name: 'eth0', state: 'UP', addresses: [`${this.state.lanIp}/24`] },
            { name: 'tailscale0', state: 'UP', addresses: ['100.64.0.10/32'] },
          ],
          routes: [{ dst: 'default', gateway: '192.0.2.1', dev: 'eth0' }],
          nameservers: ['1.1.1.1', '9.9.9.9'],
        };

      case 'system.services':
        return {
          services: [
            {
              unit: 'qbittorrent-nox@homelab.service',
              active_state: 'active',
              sub_state: 'running',
              description: 'qBittorrent-nox',
              main_pid: 1715,
              restarts: 0,
              memory_bytes: 95_000_000,
            },
          ],
        };

      case 'stacks.scan':
        return { stacks: this.state.stacks };

      case 'backup.read_status':
        return {
          status: this.state.backupStatus,
          snapshots: this.state.backupSnapshots,
          stats: this.state.backupStats,
        };

      case 'backup.run': {
        const set = typeof params['set'] === 'string' ? params['set'] : 'vaultwarden';
        const allowed = ['vaultwarden', 'configs', 'npm', 'navidrome', 'system', 'jellyfin', 'userdata', 'all'];
        if (!allowed.includes(set)) {
          throw new HomemcpError('INVALID_ARGUMENT', `Unknown backup set: ${set}`);
        }
        const targets = set === 'all' ? ['vaultwarden', 'configs'] : [set];
        const now = new Date().toISOString();
        for (const t of targets) {
          const snapId = `${Date.now().toString(16).slice(-6)}${(this.state.backupSnapshots.length + 10).toString(16).slice(-2)}`;
          this.state.backupStatus[t] = {
            last_status: 'success',
            last_success: now,
            last_bytes_added: 128_000,
            last_snapshot: snapId,
          };
          this.state.backupSnapshots.push({
            id: snapId,
            time: now,
            tags: [`set=${t}`],
            paths: [`/var/lib/homemcp/backup/staging/${t}`],
          });
        }
        return { set, exit_code: 0, output: `Backup complete for ${set}` };
      }

      case 'backup.verify':
        return { exit_code: 0, output: 'restic check passed: no errors' };

      case 'backup.restore_test': {
        const snapshotId = typeof params['snapshot_id'] === 'string' ? params['snapshot_id'] : 'latest';
        const now = new Date().toISOString();
        const prev = (this.state.backupStatus['vaultwarden'] as Record<string, unknown> | undefined) ?? {};
        this.state.backupStatus['vaultwarden'] = {
          ...prev,
          last_restore_test: {
            time: now,
            status: 'ok',
            restored_ciphers: 142,
            live_ciphers: 142,
          },
        };
        return {
          set: 'vaultwarden',
          exit_code: 0,
          output: `RESTORE_TEST=ok snapshot=${snapshotId} restored_ciphers=142 live_ciphers=142`,
        };
      }

      case 'backup.restore_staging': {
        const set = typeof params['set'] === 'string' ? params['set'] : 'vaultwarden';
        const snapshotId = typeof params['snapshot_id'] === 'string' ? params['snapshot_id'] : 'latest';
        const subdir = typeof params['staging_subdir'] === 'string' ? params['staging_subdir'] : 'manual-restore';
        if (subdir.includes('..') || !/^[A-Za-z0-9_-]{1,40}$/.test(subdir)) {
          throw new HomemcpError('POLICY_DENIED', `Invalid staging_subdir: ${subdir}`);
        }
        const stagingTarget = `/var/lib/homemcp/backup/staging-restore/${subdir}`;
        return {
          set,
          snapshot_id: snapshotId,
          staging_target: stagingTarget,
          exit_code: 0,
          output: `STAGING_DIR=${stagingTarget} INTEGRITY=${set === 'vaultwarden' ? 'ok' : 'n/a'}`,
        };
      }

      case 'backup.prune_set': {
        const set = typeof params['set'] === 'string' ? params['set'] : 'vaultwarden';
        const dryRun = params['dry_run'] !== false;
        const matching = this.state.backupSnapshots.filter((s) =>
          Array.isArray(s['tags']) && (s['tags'] as string[]).includes(`set=${set}`),
        );
        return {
          set,
          dry_run: dryRun,
          exit_code: 0,
          output: dryRun
            ? `DRY-RUN: evaluated ${matching.length} ${set} snapshot(s) against retention policy (0 expired in fixture)`
            : `PRUNED: retained ${matching.length} ${set} snapshot(s) under retention policy`,
        };
      }

      case 'files.read': {
        const p = typeof params['path'] === 'string' ? params['path'] : '';
        if (p.includes('..') || (!p.startsWith('/home/homelab/') && !p.startsWith('/mnt/storage/'))) {
          throw new HomemcpError('POLICY_DENIED', `Path outside allowed roots or contains traversal: ${p}`);
        }
        if (isDeniedPath(p)) {
          throw new HomemcpError('POLICY_DENIED', `Reading denied file is forbidden: ${p}`);
        }
        const content = this.state.files[p];
        if (content === undefined) {
          throw new HomemcpError('NOT_FOUND', `File not found: ${p}`);
        }
        if (Buffer.byteLength(content, 'utf8') > 262_144) {
          throw new HomemcpError('INVALID_ARGUMENT', 'File exceeds 256KB read limit');
        }
        return { path: p, content, size_bytes: Buffer.byteLength(content, 'utf8') };
      }

      case 'files.list': {
        const dir = (typeof params['path'] === 'string' ? params['path'] : '/home/homelab/docker-containers').replace(/\/+$/, '');
        if (dir.includes('..')) throw new HomemcpError('POLICY_DENIED', 'Traversal denied');
        const prefix = `${dir}/`;
        const seen = new Set<string>();
        const entries: Array<{ name: string; type: 'file' | 'dir' | 'other'; size_bytes: number; mtime: string }> = [];
        for (const [k, v] of Object.entries(this.state.files)) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length);
          const seg = rest.split('/')[0]!;
          if (seen.has(seg)) continue;
          seen.add(seg);
          entries.push({
            name: seg,
            type: rest.includes('/') ? 'dir' : 'file',
            size_bytes: rest.includes('/') ? 0 : Buffer.byteLength(v, 'utf8'),
            mtime: new Date().toISOString(),
          });
        }
        return { path: dir, entries };
      }

      case 'files.stat': {
        const p = typeof params['path'] === 'string' ? params['path'] : '';
        if (p.includes('..')) throw new HomemcpError('POLICY_DENIED', 'Traversal denied');
        const content = this.state.files[p];
        if (content === undefined) throw new HomemcpError('NOT_FOUND', `File not found: ${p}`);
        return {
          path: p,
          type: 'file',
          size_bytes: Buffer.byteLength(content, 'utf8'),
          mode: isDeniedPath(p) ? '0600' : '0644',
          mtime: new Date().toISOString(),
        };
      }

      case 'files.search': {
        const root = typeof params['root'] === 'string' ? params['root'] : '/';
        const pat = (typeof params['pattern'] === 'string' ? params['pattern'] : '').toLowerCase();
        const matches = Object.keys(this.state.files)
          .filter((k) => k.startsWith(root) && k.toLowerCase().includes(pat) && !isDeniedPath(k));
        return { matches };
      }

      case 'files.disk_usage': {
        const p = typeof params['path'] === 'string' ? params['path'] : '/';
        const children = Object.entries(this.state.files)
          .filter(([k]) => k.startsWith(p))
          .map(([k, v]) => ({ name: k, bytes: Buffer.byteLength(v, 'utf8') }));
        return {
          path: p,
          total_bytes: children.reduce((s, c) => s + c.bytes, 0),
          children,
        };
      }

      case 'files.mkdir': {
        const p = typeof params['path'] === 'string' ? params['path'] : '';
        if (p.includes('..') || (!p.startsWith('/home/homelab/') && !p.startsWith('/mnt/storage/'))) {
          throw new HomemcpError('POLICY_DENIED', `Path outside allowed roots: ${p}`);
        }
        return { path: p, created: true };
      }

      case 'files.write': {
        const p = typeof params['path'] === 'string' ? params['path'] : '';
        const content = typeof params['content'] === 'string' ? params['content'] : '';
        if (p.includes('..') || !p.startsWith('/home/homelab/')) {
          throw new HomemcpError('POLICY_DENIED', `Write path outside stack roots: ${p}`);
        }
        if (isDeniedPath(p)) {
          throw new HomemcpError('POLICY_DENIED', `Writing denied file is forbidden: ${p}`);
        }
        this.state.files[p] = content;
        return { path: p, bytes_written: Buffer.byteLength(content, 'utf8') };
      }

      case 'files.move': {
        const src = typeof params['src'] === 'string' ? params['src'] : '';
        const dst = typeof params['dst'] === 'string' ? params['dst'] : '';
        const overwrite = params['overwrite'] === true;
        if (src.includes('..') || dst.includes('..')) throw new HomemcpError('POLICY_DENIED', 'Traversal denied');
        const val = this.state.files[src];
        if (val === undefined) throw new HomemcpError('NOT_FOUND', `Source not found: ${src}`);
        if (!overwrite && this.state.files[dst] !== undefined) {
          throw new HomemcpError('CONFLICT', `Destination exists: ${dst}`);
        }
        delete this.state.files[src];
        this.state.files[dst] = val;
        return { src, dst, moved: true };
      }

      case 'files.trash': {
        const p = typeof params['path'] === 'string' ? params['path'] : '';
        const val = this.state.files[p];
        if (val === undefined) throw new HomemcpError('NOT_FOUND', `Not found: ${p}`);
        delete this.state.files[p];
        const trashPath = `/mnt/storage/.trash/${p.split('/').pop() ?? 'item'}-${Date.now()}`;
        this.state.files[trashPath] = val;
        return { original: p, trash_path: trashPath };
      }

      case 'stacks.apply': {
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const yaml = typeof params['compose_yaml'] === 'string' ? params['compose_yaml'] : '';
        const secretKeys = Array.isArray(params['secret_keys']) ? (params['secret_keys'] as string[]) : [];
        const start = params['start'] !== false;
        const stackDir = `/home/homelab/docker-containers/${name}`;
        const pol = validateComposePolicy(yaml, {
          stackName: name,
          stackDir,
          allowedBindRoots: [stackDir, '/mnt/storage/media'],
        });
        if (!pol.allowed) {
          throw new HomemcpError(
            'POLICY_DENIED',
            `Compose policy rejected stack "${name}": ${pol.violations.map((v) => v.message).join('; ')}`,
          );
        }
        this.state.files[`${stackDir}/docker-compose.yml`] = yaml;
        if (secretKeys.length > 0) {
          this.state.files[`${stackDir}/.env`] = secretKeys.map((k) => `${k}=mock-generated-secret-value`).join('\n');
        }
        if (!this.state.stacks.some((s) => s.name === name)) {
          this.state.stacks.push({
            name,
            root: '/home/homelab/docker-containers',
            dir: stackDir,
            compose_files: ['docker-compose.yml'],
            compose_yaml_redacted_source: yaml,
            services: [{ name, image: 'curated', ports: [], volumes: [] }],
            env_files: secretKeys.length > 0 ? [{ name: '.env', mode: '0600', uid: 999, gid: 999, size_bytes: 64 }] : [],
            policy_allowed: true,
            policy_violations: [],
            policy_warnings: pol.warnings,
          });
        }
        if (start && !this.state.containers.some((c) => c.Names.includes(`/${name}`))) {
          this.state.containers.push({
            Id: `c-${name}`,
            Names: [`/${name}`],
            Image: 'curated:1.0.0',
            ImageID: 'sha256:999999',
            State: 'running',
            Status: 'Up 5 seconds (healthy)',
            Created: Math.floor(Date.now() / 1000),
            Labels: {
              'com.docker.compose.project': name,
              'com.docker.compose.service': name,
              'com.docker.compose.project.working_dir': stackDir,
            },
            Ports: [],
            NetworkSettings: { Networks: { proxy: { IPAddress: '172.20.0.10' } } },
          });
        }
        return {
          name,
          stack_dir: stackDir,
          generated_secret_keys: secretKeys,
          started: start,
          warnings: pol.warnings,
        };
      }

      case 'stacks.up': {
        const dir = typeof params['stack_dir'] === 'string' ? params['stack_dir'] : '';
        const name = dir.split('/').pop() ?? '';
        const stack = this.state.stacks.find((s) => s.dir === dir || s.name === name);
        if (!stack) throw new HomemcpError('NOT_FOUND', `Stack not found: ${dir}`);
        if (!this.state.containers.some((c) => c.Labels['com.docker.compose.project'] === stack.name)) {
          this.state.containers.push({
            Id: `c-${stack.name}`,
            Names: [`/${stack.name}`],
            Image: stack.services[0]?.image ?? 'stack:latest',
            ImageID: 'sha256:777777',
            State: 'running',
            Status: 'Up 1 second (healthy)',
            Created: Math.floor(Date.now() / 1000),
            Labels: {
              'com.docker.compose.project': stack.name,
              'com.docker.compose.service': stack.name,
              'com.docker.compose.project.working_dir': stack.dir,
            },
            Ports: [],
            NetworkSettings: { Networks: { proxy: { IPAddress: '172.20.0.12' } } },
          });
        }
        return { stack_dir: stack.dir, status: 'up' };
      }

      case 'stacks.down': {
        const dir = typeof params['stack_dir'] === 'string' ? params['stack_dir'] : '';
        const name = dir.split('/').pop() ?? '';
        this.state.containers = this.state.containers.filter(
          (c) => c.Labels['com.docker.compose.project'] !== name && c.Labels['com.docker.compose.project.working_dir'] !== dir,
        );
        return { stack_dir: dir, status: 'down' };
      }

      case 'stacks.remove': {
        const dir = typeof params['stack_dir'] === 'string' ? params['stack_dir'] : '';
        const name = dir.split('/').pop() ?? '';
        this.state.containers = this.state.containers.filter(
          (c) => c.Labels['com.docker.compose.project'] !== name && c.Labels['com.docker.compose.project.working_dir'] !== dir,
        );
        this.state.stacks = this.state.stacks.filter((s) => s.dir !== dir && s.name !== name);
        return { stack_dir: dir, trash_path: `/home/homelab/docker-containers/.trash/${name}-${Date.now()}` };
      }

      case 'stacks.validate': {
        const yaml = typeof params['compose_yaml'] === 'string' ? params['compose_yaml'] : '';
        const stackName = typeof params['name'] === 'string' ? params['name'] : 'custom';
        return validateComposePolicy(yaml, { stackName });
      }

      case 'docker.container_action': {
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const action = typeof params['action'] === 'string' ? params['action'] : 'restart';
        const override = params['override_protected'] === true;
        if (['vaultwarden', 'nginx-pm-app-1', 'homemcp'].includes(name) && !override) {
          throw new HomemcpError('POLICY_DENIED', `Protected container "${name}" requires T3 override`);
        }
        const c = this.state.containers.find((x) => x.Names.some((n) => n.replace(/^\//, '') === name));
        if (!c) throw new HomemcpError('NOT_FOUND', `Container not found: ${name}`);
        c.State = action === 'stop' ? 'exited' : 'running';
        c.Status = action === 'stop' ? 'Exited (0)' : 'Up 1 second (healthy)';
        return { name, action, ok: true };
      }

      case 'docker.compose_update': {
        const service = typeof params['service'] === 'string' ? params['service'] : '';
        const targetImage = typeof params['target_image'] === 'string' ? params['target_image'] : undefined;
        const c = this.state.containers.find((x) => x.Names.some((n) => n.replace(/^\//, '') === service));
        const prevDigest = c?.ImageID ?? 'sha256:000000';
        if (this.state.simulateUpdateHealthFailure) {
          return {
            service,
            previous_digests: { [c?.Id ?? 'c1']: prevDigest },
            updated: false,
            rolled_back: true,
            reason: 'Health gate failed (simulated unhealthy after update); restored previous digest',
          };
        }
        if (c && targetImage) c.Image = targetImage;
        return {
          service,
          previous_digests: { [c?.Id ?? 'c1']: prevDigest },
          updated: true,
          rolled_back: false,
        };
      }

      case 'docker.prune': {
        const apply = params['apply'] === true;
        return {
          applied: apply,
          reclaimed_summary: apply ? 'Pruned 2 stopped containers, 1 dangling image (420 MB)' : 'Dry run: 2 stopped containers, 1 dangling image',
        };
      }

      case 'system.service_action': {
        const unit = typeof params['unit'] === 'string' ? params['unit'] : '';
        const action = typeof params['action'] === 'string' ? params['action'] : 'restart';
        if (['ssh.service', 'tailscaled.service', 'homemcpd.service'].includes(unit)) {
          throw new HomemcpError('POLICY_DENIED', `Protected unit "${unit}" cannot be altered`);
        }
        return { unit, action, ok: true };
      }

      case 'system.reboot':
        return { scheduled: true, message: 'Reboot scheduled (+1m, simulated)' };

      default:
        throw new HomemcpError('NOT_FOUND', `Unknown mock agent verb: ${verb}`);
    }
  }
}
