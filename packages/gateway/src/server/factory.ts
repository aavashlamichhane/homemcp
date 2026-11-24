import { McpServer } from '@modelcontextprotocol/server';
import {
  HttpCloudflareConnector,
  HttpDockerConnector,
  HttpNpmConnector,
  HttpUnixAgentClient,
  HttpVaultwardenConnector,
  NodeHttpProbeConnector,
  OciRegistryConnector,
  type AgentExecutor,
  type CloudflareConnector,
  type DockerConnector,
  type HttpProbeConnector,
  type NpmConnector,
  type RegistryConnector,
  type VaultwardenConnector,
} from '@homemcp/connectors';
import {
  ALL_SCOPES,
  parseToolsetFilter,
  Redactor,
  TOOLSET_NAMES,
  type AuthContext,
  type HomemcpConfig,
  type ToolsetName,
} from '@homemcp/core';
import {
  createMockState,
  MockCloudflareConnector,
  MockDockerConnector,
  MockExecutor,
  MockHttpProbeConnector,
  MockNpmConnector,
  MockRegistryConnector,
  MockVaultwardenConnector,
} from '@homemcp/mock';
import { HomemcpDb } from '../db/database.js';
import { registerAppsModule } from '../modules/apps.js';
import { registerBackupModule } from '../modules/backup.js';
import { registerCoreModule } from '../modules/core.js';
import { registerDockerModule } from '../modules/docker.js';
import { registerNetworkModule } from '../modules/network.js';
import { registerSystemModule } from '../modules/system.js';
import { registerVaultwardenModule } from '../modules/vaultwarden.js';
import { registerPrompts } from '../prompts/index.js';
import { registerResources } from '../resources/index.js';
import { HomemcpRegistry } from './registry.js';

export interface GatewayDeps {
  config: HomemcpConfig;
  db: HomemcpDb;
  redactor: Redactor;
  registry: HomemcpRegistry;
  agent: AgentExecutor;
  docker?: DockerConnector | undefined;
  ociRegistry: RegistryConnector;
  npm?: NpmConnector | undefined;
  cloudflare?: CloudflareConnector | undefined;
  vaultwarden?: VaultwardenConnector | undefined;
  httpProbe: HttpProbeConnector;
  isMock: boolean;
  version: string;
}

export function createDefaultMockConfig(): HomemcpConfig {
  return {
    server: {
      publicUrl: 'https://homemcp.example.com',
      mcpPath: '/mcp',
      listen: '127.0.0.1:8790',
      allowedHosts: ['homemcp.example.com', 'localhost', '127.0.0.1'],
      trustProxy: true,
      toolsets: [...TOOLSET_NAMES],
    },
    auth: {
      mode: 'dev',
      issuer: 'https://homemcp.example.com',
      owner: { name: 'Owner' },
      accessTokenTtl: '15m',
      refreshTokenTtl: '30d',
      clientRegistration: { cimd: true, dcr: true },
      stepUpMaxAge: '5m',
      secretKey: 'mock-secret-key-0123456789abcdef',
    },
    agent: {
      socket: '/run/homemcpd/homemcpd.sock',
      hmacSecret: 'mock-hmac-secret-0123456789abcdef',
    },
    policy: {
      protectedContainers: ['cloudflared-*', 'nginx-pm-app-1', 'homemcp', 'vaultwarden'],
      protectedUnits: ['ssh.service', 'tailscaled.service', 'homemcpd.service'],
      allowedUnits: ['qbittorrent-nox@homelab.service', 'smbd.service', 'tailscaled.service'],
      knownNoise: ['SystemCMOS', 'AE_NOT_EXIST', "Invalid key 'SYSFS'"],
      roots: {
        stacks: '/home/homelab/docker-containers',
        extraStackRoots: ['/home/homelab/projects'],
        media: '/mnt/storage/media',
        shares: ['/mnt/storage/samba/shared'],
      },
      compose: {
        allow: {
          jellyfin: { network_mode_host: true, devices: ['/dev/dri'] },
          portainer: { docker_sock: true },
        },
        defaultLimits: { mem_limit: '512m', pids_limit: 256 },
      },
    },
    modules: {
      docker: { socketProxy: 'http://127.0.0.1:2375' },
      network: {
        npm: { url: 'http://192.0.2.10:81', email: 'mcp@example.com', password: 'mock-npm-password' },
        cloudflare: {
          accountId: 'acc-mock',
          tunnelId: 'tun-mock',
          apiToken: 'mock-cf-token',
          zones: ['example.com'],
          originService: 'http://192.0.2.10',
        },
      },
      apps: {
        checks: [
          { name: 'filebrowser', url: 'http://192.0.2.10:8081/health' },
          { name: 'naviload', url: 'http://192.0.2.10:8085/healthz' },
        ],
      },
      backup: {
        statusDir: '/var/lib/homemcp/backup',
        budgetBytes: 7_000_000_000,
        sets: {
          vaultwarden: { rpo: '24h' },
          configs: { rpo: '48h' },
        },
      },
      vaultwarden: {
        url: 'http://192.0.2.10:8082',
        container: 'vaultwarden',
        publicUrl: 'https://vw.example.com',
      },
    },
  };
}

export function createGatewayDeps(opts: {
  config?: HomemcpConfig | undefined;
  dbPath?: string | undefined;
  mock?: boolean | undefined;
  redactor?: Redactor | undefined;
  version?: string | undefined;
}): GatewayDeps {
  const isMock = opts.mock ?? false;
  const config = opts.config ?? createDefaultMockConfig();
  const redactor = opts.redactor ?? new Redactor();
  redactor.registerSecrets([
    config.auth.secretKey,
    config.agent.hmacSecret,
    config.modules.network?.npm?.password,
    config.modules.network?.cloudflare?.apiToken,
    config.modules.navidrome?.password,
    config.modules.naviload?.token,
    config.modules.jellyfin?.apiKey,
    config.modules.qbittorrent?.password,
    config.modules.alerts?.ntfy?.token,
    config.modules.alerts?.ntfy?.url,
    config.modules.alerts?.healthchecks?.pingUrl,
  ]);

  const db = new HomemcpDb(opts.dbPath ?? (isMock ? ':memory:' : '/data/homemcp.db'));
  const registry = new HomemcpRegistry();

  let agent: AgentExecutor;
  let docker: DockerConnector | undefined;
  let ociRegistry: RegistryConnector;
  let npm: NpmConnector | undefined;
  let cloudflare: CloudflareConnector | undefined;
  let vaultwarden: VaultwardenConnector | undefined;
  let httpProbe: HttpProbeConnector;

  if (isMock) {
    const state = createMockState();
    agent = new MockExecutor(state);
    docker = new MockDockerConnector(state, redactor);
    ociRegistry = new MockRegistryConnector();
    npm = new MockNpmConnector(state);
    cloudflare = new MockCloudflareConnector(state);
    vaultwarden = new MockVaultwardenConnector();
    httpProbe = new MockHttpProbeConnector();
  } else {
    agent = new HttpUnixAgentClient({
      socketPath: config.agent.socket,
      url: config.agent.url,
      hmacSecret: config.agent.hmacSecret,
    });
    docker = config.modules.docker
      ? new HttpDockerConnector(config.modules.docker.socketProxy, redactor)
      : undefined;
    ociRegistry = new OciRegistryConnector();
    npm = config.modules.network?.npm
      ? new HttpNpmConnector(config.modules.network.npm)
      : undefined;
    cloudflare = config.modules.network?.cloudflare
      ? new HttpCloudflareConnector(config.modules.network.cloudflare)
      : undefined;
    vaultwarden = config.modules.vaultwarden
      ? new HttpVaultwardenConnector(config.modules.vaultwarden)
      : undefined;
    httpProbe = new NodeHttpProbeConnector();
  }

  const deps: GatewayDeps = {
    config,
    db,
    redactor,
    registry,
    agent,
    docker,
    ociRegistry,
    npm,
    cloudflare,
    vaultwarden,
    httpProbe,
    isMock,
    version: opts.version ?? '0.1.0',
  };

  registerCoreModule(deps);
  registerSystemModule(deps);
  registerDockerModule(deps);
  registerNetworkModule(deps);
  registerAppsModule(deps);
  registerBackupModule(deps);
  registerVaultwardenModule(deps);
  registerResources(deps);
  registerPrompts(deps);

  return deps;
}

export function buildMcpServer(
  deps: GatewayDeps,
  opts?: {
    toolsetFilter?: string | undefined;
    auth?: AuthContext | undefined;
  },
): McpServer {
  const defaultAuth: AuthContext = opts?.auth ?? {
    subject: deps.config.auth.owner.name,
    clientId: 'stdio-local',
    tokenKind: 'stdio',
    tokenId: 'local',
    scopes: [...ALL_SCOPES],
  };

  const activeToolsets: ToolsetName[] = parseToolsetFilter(
    opts?.toolsetFilter,
    deps.config.server.toolsets,
    defaultAuth.allowedToolsets,
  );

  const server = new McpServer({
    name: 'homemcp',
    version: deps.version,
  });

  deps.registry.attachToServer(server, {
    db: deps.db,
    redactor: deps.redactor,
    activeToolsets,
    defaultAuth,
  });

  return server;
}
