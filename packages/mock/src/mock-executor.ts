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
      ],
    });
  }

  public call<T = unknown>(verb: string, params: Record<string, unknown> = {}): Promise<T> {
    return Promise.resolve(this.dispatch(verb, params) as T);
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
          const snapId = `snap_${t}_${Date.now().toString(36).slice(-4)}`;
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
        return { set: 'vaultwarden', exit_code: 0, output: 'RESTORE_TEST=ok restored_ciphers=142 live_ciphers=142' };
      }

      case 'files.read': {
        const p = typeof params['path'] === 'string' ? params['path'] : '';
        if (isDeniedPath(p)) {
          throw new HomemcpError('POLICY_DENIED', `Reading denied file is forbidden: ${p}`);
        }
        const content = this.state.files[p];
        if (content === undefined) {
          throw new HomemcpError('NOT_FOUND', `File not found: ${p}`);
        }
        return { path: p, content };
      }

      case 'stacks.validate': {
        const yaml = typeof params['compose_yaml'] === 'string' ? params['compose_yaml'] : '';
        const stackName = typeof params['name'] === 'string' ? params['name'] : 'custom';
        return validateComposePolicy(yaml, { stackName });
      }

      default:
        throw new HomemcpError('NOT_FOUND', `Unknown mock agent verb: ${verb}`);
    }
  }
}
