import type {
  CloudflareAccessApp,
  CloudflareDnsRecord,
  CloudflareTunnelConfig,
  DockerContainerSummary,
  DockerInspectSanitized,
  NpmAccessList,
  NpmCertificate,
  NpmProxyHost,
} from '@homemcp/connectors';

export interface MockState {
  hostname: string;
  lanIp: string;
  acOnline: boolean;
  batteryPercent: number;
  maxTempC: number;
  diskUsedPercent: number;
  containers: DockerContainerSummary[];
  inspected: Record<string, DockerInspectSanitized>;
  logs: Record<string, string>;
  stacks: Array<{
    name: string;
    root: string;
    dir: string;
    compose_files: string[];
    compose_yaml_redacted_source?: string;
    services: Array<{ name: string; image?: string; ports: string[]; volumes: string[] }>;
    env_files: Array<{ name: string; mode: string; uid: number; gid: number; size_bytes: number }>;
    policy_allowed: boolean;
    policy_violations: Array<{ service: string; rule: string; message: string }>;
    policy_warnings: Array<{ service: string; rule: string; message: string }>;
  }>;
  npmHosts: NpmProxyHost[];
  npmCerts: NpmCertificate[];
  npmAccessLists: NpmAccessList[];
  cfTunnelConfig: CloudflareTunnelConfig;
  cfDnsRecords: CloudflareDnsRecord[];
  cfAccessApps: CloudflareAccessApp[];
  cfConnections: Array<{ id: string; origin_ip: string; client_version: string; opened_at: string }>;
  backupStatus: Record<string, unknown>;
  backupSnapshots: Array<Record<string, unknown>>;
  backupStats: Record<string, unknown>;
  files: Record<string, string>;
}

export function createMockState(): MockState {
  const nowSec = Math.floor(Date.now() / 1000);
  const fakeTunnelJwt =
    'eyJhIjoiYWJjZGVmMDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzIiwidCI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCIsInMiOiJzeW50aGV0aWN0ZXN0dG9rZW4wMTIzNDU2Nzg5In0=';

  return {
    hostname: 'homelab-01',
    lanIp: '192.0.2.10',
    acOnline: true,
    batteryPercent: 94,
    maxTempC: 58.0,
    diskUsedPercent: 78,
    containers: [
      {
        Id: 'c-navidrome',
        Names: ['/navidrome'],
        Image: 'deluan/navidrome:0.63.2',
        ImageID: 'sha256:111111',
        State: 'running',
        Status: 'Up 5 days (healthy)',
        Created: nowSec - 432000,
        Labels: {
          'com.docker.compose.project': 'navidrome',
          'com.docker.compose.service': 'navidrome',
          'com.docker.compose.project.working_dir': '/home/homelab/docker-containers/navidrome',
          'org.opencontainers.image.version': '0.63.2',
        },
        Ports: [{ IP: '192.0.2.10', PrivatePort: 4533, PublicPort: 4533, Type: 'tcp' }],
        NetworkSettings: { Networks: { navidrome_default: { IPAddress: '172.25.0.2' } } },
      },
      {
        Id: 'c-naviload',
        Names: ['/navidrome-downloader'],
        Image: 'naviload:2',
        ImageID: 'sha256:222222',
        State: 'running',
        Status: 'Up 5 days (healthy)',
        Created: nowSec - 432000,
        Labels: {
          'com.docker.compose.project': 'navidrome',
          'com.docker.compose.service': 'navidrome-downloader',
          'com.docker.compose.project.working_dir': '/home/homelab/docker-containers/navidrome',
        },
        Ports: [{ IP: '192.0.2.10', PrivatePort: 8085, PublicPort: 8085, Type: 'tcp' }],
        NetworkSettings: { Networks: { navidrome_default: { IPAddress: '172.25.0.3' } } },
      },
      {
        Id: 'c-jellyfin',
        Names: ['/jellyfin'],
        Image: 'jellyfin/jellyfin:10.11.8',
        ImageID: 'sha256:333333',
        State: 'running',
        Status: 'Up 5 days (healthy)',
        Created: nowSec - 432000,
        Labels: {
          'com.docker.compose.project': 'jellyfin',
          'com.docker.compose.service': 'jellyfin',
          'com.docker.compose.project.working_dir': '/home/homelab/docker-containers/jellyfin',
          'org.opencontainers.image.version': '10.11.8',
        },
        Ports: [],
        NetworkSettings: { Networks: { host: { IPAddress: '' } } },
      },
      {
        Id: 'c-vaultwarden',
        Names: ['/vaultwarden'],
        Image: 'vaultwarden/server:1.37.0',
        ImageID: 'sha256:444444',
        State: 'running',
        Status: 'Up 5 days (healthy)',
        Created: nowSec - 432000,
        Labels: {
          'com.docker.compose.project': 'vaultwarden-server',
          'com.docker.compose.service': 'vaultwarden',
          'com.docker.compose.project.working_dir': '/home/homelab/docker-containers/vaultwarden-server',
          'org.opencontainers.image.version': '1.37.0',
        },
        Ports: [{ IP: '192.0.2.10', PrivatePort: 80, PublicPort: 8082, Type: 'tcp' }],
        NetworkSettings: { Networks: { 'vaultwarden-server_default': { IPAddress: '172.24.0.2' } } },
      },
      {
        Id: 'c-cloudflared-1',
        Names: ['/cloudflared-cloudflared-1'],
        Image: 'cloudflare/cloudflared:2026.5.2',
        ImageID: 'sha256:555555',
        State: 'running',
        Status: 'Up 5 days',
        Created: nowSec - 432000,
        Labels: {
          'com.docker.compose.project': 'cloudflared',
          'com.docker.compose.service': 'cloudflared',
          'com.docker.compose.project.working_dir': '/home/homelab/docker-containers/cloudflared',
          'org.opencontainers.image.version': '2026.5.2',
        },
        Ports: [],
        NetworkSettings: { Networks: { cloudflared_default: { IPAddress: '172.23.0.2' } } },
      },
      {
        Id: 'c-npm',
        Names: ['/nginx-pm-app-1'],
        Image: 'jc21/nginx-proxy-manager:2.14.0',
        ImageID: 'sha256:666666',
        State: 'running',
        Status: 'Up 5 days',
        Created: nowSec - 432000,
        Labels: {
          'com.docker.compose.project': 'nginx-pm',
          'com.docker.compose.service': 'app',
          'com.docker.compose.project.working_dir': '/home/homelab/docker-containers/nginx-pm',
        },
        Ports: [
          { IP: '192.0.2.10', PrivatePort: 80, PublicPort: 80, Type: 'tcp' },
          { IP: '192.0.2.10', PrivatePort: 81, PublicPort: 81, Type: 'tcp' },
          { IP: '192.0.2.10', PrivatePort: 443, PublicPort: 443, Type: 'tcp' },
        ],
        NetworkSettings: { Networks: { proxy: { IPAddress: '172.20.0.2' } } },
      },
    ],
    inspected: {
      navidrome: {
        Id: 'c-navidrome',
        Name: 'navidrome',
        Created: '2026-11-19T00:00:00Z',
        Image: 'sha256:111111',
        State: {
          Status: 'running',
          Running: true,
          Restarting: false,
          OOMKilled: false,
          ExitCode: 0,
          StartedAt: '2026-11-19T00:00:00Z',
          FinishedAt: '',
          Health: { Status: 'healthy', FailingStreak: 0, Log: [] },
        },
        RestartCount: 0,
        Config: {
          Image: 'deluan/navidrome:0.63.2',
          EnvKeys: ['ND_SCANSCHEDULE', 'ND_LOGLEVEL'],
          Labels: {
            'org.opencontainers.image.version': '0.63.2',
            'org.opencontainers.image.source': 'https://github.com/navidrome/navidrome',
          },
        },
        Mounts: [
          { Type: 'bind', Source: '/home/homelab/docker-containers/navidrome/navidrome-data', Destination: '/data', RW: true },
          { Type: 'bind', Source: '/mnt/storage/media/music', Destination: '/music', RW: false },
        ],
        Networks: ['navidrome_default'],
        Ports: { '4533/tcp': [{ HostIp: '192.0.2.10', HostPort: '4533' }] },
        HostConfig: {
          NetworkMode: 'navidrome_default',
          Memory: 768 * 1024 * 1024,
          PidsLimit: 128,
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        },
      },
      vaultwarden: {
        Id: 'c-vaultwarden',
        Name: 'vaultwarden',
        Created: '2026-11-19T00:00:00Z',
        Image: 'sha256:444444',
        State: {
          Status: 'running',
          Running: true,
          Restarting: false,
          OOMKilled: false,
          ExitCode: 0,
          StartedAt: '2026-11-19T00:00:00Z',
          FinishedAt: '',
        },
        RestartCount: 0,
        Config: {
          Image: 'vaultwarden/server:1.37.0',
          EnvKeys: ['DOMAIN', 'SIGNUPS_ALLOWED'],
          Labels: { 'org.opencontainers.image.version': '1.37.0' },
        },
        Mounts: [{ Type: 'bind', Source: '/mnt/storage/vaultwarden/data', Destination: '/data', RW: true }],
        Networks: ['vaultwarden-server_default'],
        Ports: { '80/tcp': [{ HostIp: '192.0.2.10', HostPort: '8082' }] },
        HostConfig: {
          NetworkMode: 'vaultwarden-server_default',
          Memory: 256 * 1024 * 1024,
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        },
      },
      'cloudflared-cloudflared-1': {
        Id: 'c-cloudflared-1',
        Name: 'cloudflared-cloudflared-1',
        Created: '2026-11-19T00:00:00Z',
        Image: 'sha256:555555',
        State: {
          Status: 'running',
          Running: true,
          Restarting: false,
          OOMKilled: false,
          ExitCode: 0,
          StartedAt: '2026-11-19T00:00:00Z',
          FinishedAt: '',
        },
        RestartCount: 0,
        Config: {
          Image: 'cloudflare/cloudflared:2026.5.2',
          EnvKeys: ['TUNNEL_TOKEN'],
          Labels: { 'org.opencontainers.image.version': '2026.5.2' },
          Cmd: ['tunnel', '--no-autoupdate', 'run', '--token', fakeTunnelJwt],
        },
        Mounts: [],
        Networks: ['cloudflared_default'],
        Ports: {},
        HostConfig: { NetworkMode: 'cloudflared_default', Memory: 128 * 1024 * 1024 },
      },
    },
    logs: {
      navidrome: '2026-11-24T08:00:00Z level=info msg="Library scan completed: 452 tracks"\n',
      'cloudflared-cloudflared-1': `2026-11-24T08:00:00Z INF Registered tunnel connection --token ${fakeTunnelJwt}\n`,
      jellyfin: '2026-11-24T08:00:00Z [INF] Startup complete\n',
      vaultwarden: '2026-11-24T08:00:00Z [INFO] Rocket has launched\n',
    },
    stacks: [
      {
        name: 'navidrome',
        root: '/home/homelab/docker-containers',
        dir: '/home/homelab/docker-containers/navidrome',
        compose_files: ['docker-compose.yml'],
        compose_yaml_redacted_source:
          'services:\n  navidrome:\n    image: deluan/navidrome:0.63.2\n    restart: unless-stopped\n',
        services: [
          {
            name: 'navidrome',
            image: 'deluan/navidrome:0.63.2',
            ports: ['192.0.2.10:4533:4533'],
            volumes: ['./navidrome-data:/data', '/mnt/storage/media/music:/music:ro'],
          },
        ],
        env_files: [{ name: '.env', mode: '0600', uid: 1000, gid: 1000, size_bytes: 210 }],
        policy_allowed: true,
        policy_violations: [],
        policy_warnings: [],
      },
      {
        name: 'immich-app',
        root: '/home/homelab/docker-containers',
        dir: '/home/homelab/docker-containers/immich-app',
        compose_files: ['docker-compose.yml'],
        compose_yaml_redacted_source:
          'services:\n  immich-server:\n    image: ghcr.io/immich-app/immich-server:v1.120.0\n    restart: unless-stopped\n',
        services: [
          {
            name: 'immich-server',
            image: 'ghcr.io/immich-app/immich-server:v1.120.0',
            ports: ['192.0.2.10:2283:2283'],
            volumes: ['/mnt/storage/immich:/usr/src/app/upload'],
          },
        ],
        env_files: [{ name: '.env', mode: '0600', uid: 1000, gid: 1000, size_bytes: 180 }],
        policy_allowed: true,
        policy_violations: [],
        policy_warnings: [],
      },
    ],
    npmHosts: [
      {
        id: 1,
        domain_names: ['navidrome.example.com'],
        forward_scheme: 'http',
        forward_host: '192.0.2.10',
        forward_port: 4533,
        certificate_id: 2,
        access_list_id: 0,
        ssl_forced: true,
        block_exploits: true,
        allow_websocket_upgrade: true,
        caching_enabled: false,
        enabled: true,
        certificate: { id: 2, nice_name: '*.example.com', expires_on: '2027-02-01T00:00:00Z' },
      },
      {
        id: 2,
        domain_names: ['vw.example.com'],
        forward_scheme: 'http',
        forward_host: '192.0.2.10',
        forward_port: 8082,
        certificate_id: 2,
        access_list_id: 0,
        ssl_forced: true,
        block_exploits: true,
        allow_websocket_upgrade: true,
        caching_enabled: false,
        enabled: true,
        certificate: { id: 2, nice_name: '*.example.com', expires_on: '2027-02-01T00:00:00Z' },
      },
      {
        id: 3,
        domain_names: ['stale-dead.example.com'],
        forward_scheme: 'http',
        forward_host: '192.0.2.10',
        forward_port: 19999,
        certificate_id: 2,
        access_list_id: 0,
        ssl_forced: true,
        block_exploits: true,
        allow_websocket_upgrade: true,
        caching_enabled: false,
        enabled: true,
        certificate: { id: 2, nice_name: '*.example.com', expires_on: '2027-02-01T00:00:00Z' },
      },
    ],
    npmCerts: [
      {
        id: 2,
        nice_name: '*.example.com',
        domain_names: ['*.example.com', 'example.com'],
        expires_on: '2027-02-01T00:00:00Z',
        provider: 'letsencrypt',
      },
    ],
    npmAccessLists: [],
    cfTunnelConfig: {
      version: 51,
      config: {
        'warp-routing': { enabled: true },
        ingress: [
          { hostname: 'ssh.example.com', service: 'ssh://192.0.2.10:22' },
          { hostname: 'homemcp.example.com', service: 'http://homemcp:8790' },
          { hostname: 'navidrome.example.com', service: 'http://192.0.2.10:80' },
          { hostname: 'vw.example.com', service: 'http://192.0.2.10:80' },
          { hostname: 'stale-dead.example.com', service: 'http://192.0.2.10:80' },
          { service: 'http_status:404' },
        ],
      },
    },
    cfDnsRecords: [
      { id: 'd1', zone_id: 'z1', zone_name: 'example.com', name: 'navidrome.example.com', type: 'CNAME', content: 'tun-mock.cfargotunnel.com', proxied: true },
      { id: 'd2', zone_id: 'z1', zone_name: 'example.com', name: 'vw.example.com', type: 'CNAME', content: 'tun-mock.cfargotunnel.com', proxied: true },
      { id: 'd3', zone_id: 'z1', zone_name: 'example.com', name: 'stale-dead.example.com', type: 'CNAME', content: 'tun-mock.cfargotunnel.com', proxied: true },
      { id: 'd4', zone_id: 'z1', zone_name: 'example.com', name: 'homemcp.example.com', type: 'CNAME', content: 'tun-mock.cfargotunnel.com', proxied: true },
    ],
    cfAccessApps: [
      { id: 'a1', name: 'SSH', domain: 'ssh.example.com', type: 'self_hosted' },
    ],
    cfConnections: [
      { id: 'conn-1', origin_ip: '198.51.100.1', client_version: '2026.5.2', opened_at: '2026-11-24T00:00:00Z' },
      { id: 'conn-2', origin_ip: '198.51.100.1', client_version: '2026.5.2', opened_at: '2026-11-24T00:00:00Z' },
      { id: 'conn-3', origin_ip: '198.51.100.1', client_version: '2026.5.2', opened_at: '2026-11-24T00:00:00Z' },
    ],
    backupStatus: {
      vaultwarden: {
        last_status: 'success',
        last_success: new Date(Date.now() - 2 * 3600_000).toISOString(),
        last_bytes_added: 524288,
        last_snapshot: 'snapvw01',
        last_restore_test: {
          time: new Date(Date.now() - 12 * 3600_000).toISOString(),
          status: 'ok',
          restored_ciphers: 142,
          live_ciphers: 142,
        },
      },
      configs: {
        last_status: 'success',
        last_success: new Date(Date.now() - 6 * 3600_000).toISOString(),
        last_bytes_added: 2048000,
        last_snapshot: 'snapcfg1',
      },
    },
    backupSnapshots: [
      { id: 'snapvw01', time: new Date(Date.now() - 2 * 3600_000).toISOString(), tags: ['set=vaultwarden'], paths: ['/var/lib/homemcp/backup/staging/vaultwarden'] },
      { id: 'snapcfg1', time: new Date(Date.now() - 6 * 3600_000).toISOString(), tags: ['set=configs'], paths: ['/home/homelab/docker-containers'] },
    ],
    backupStats: { total_size: 1_250_000_000, total_file_count: 4200 },
    files: {
      '/home/homelab/docker-containers/navidrome/docker-compose.yml':
        'services:\n  navidrome:\n    image: deluan/navidrome:0.63.2\n',
      '/home/homelab/docker-containers/navidrome/.env': 'DOWNLOADER_PASSWORD=mock-secret-pass\n',
    },
  };
}
