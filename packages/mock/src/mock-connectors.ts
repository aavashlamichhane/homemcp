import type {
  CloudflareConnector,
  DockerConnector,
  HttpProbeConnector,
  HttpProbeResult,
  NpmConnector,
  RegistryConnector,
  VaultwardenConnector,
} from '@homemcp/connectors';
import { HomemcpError, Redactor } from '@homemcp/core';
import type { MockState } from './fixtures.js';

export class MockDockerConnector implements DockerConnector {
  public constructor(
    private readonly state: MockState,
    private readonly redactor: Redactor = new Redactor(),
  ) {}

  public listContainers(all = true) {
    return Promise.resolve(
      all ? this.state.containers : this.state.containers.filter((c) => c.State === 'running'),
    );
  }

  public inspectContainer(idOrName: string) {
    const clean = idOrName.replace(/^\//, '');
    const found =
      this.state.inspected[clean] ??
      Object.values(this.state.inspected).find((i) => i.Id === clean || i.Name === clean);
    if (!found) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Container not found: ${idOrName}`));
    }
    return Promise.resolve(found);
  }

  public getContainerLogs(idOrName: string) {
    const clean = idOrName.replace(/^\//, '');
    const raw = this.state.logs[clean];
    if (raw === undefined) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Container not found: ${idOrName}`));
    }
    return Promise.resolve(this.redactor.redactString(raw).text);
  }

  public getContainerStats(idOrName: string) {
    return Promise.resolve({
      name: idOrName,
      cpu_stats: { cpu_usage: { total_usage: 500_000_000 }, system_cpu_usage: 10_000_000_000 },
      memory_stats: { usage: 120_000_000, limit: 512 * 1024 * 1024 },
    });
  }

  public listImages() {
    return Promise.resolve(
      this.state.containers.map((c) => ({
        Id: c.ImageID,
        RepoTags: [c.Image],
        RepoDigests: [`${c.Image.split(':')[0]}@sha256:${c.ImageID.replace('sha256:', '').padEnd(64, '0')}`],
        Size: 150_000_000,
      })),
    );
  }

  public getEvents() {
    return Promise.resolve([
      { Type: 'container', Action: 'health_status: healthy', Actor: { Attributes: { name: 'navidrome' } }, time: Math.floor(Date.now() / 1000) - 120 },
    ]);
  }

  public getSystemDf() {
    return Promise.resolve({
      Images: [{ Repository: 'deluan/navidrome', Size: 120_000_000 }],
      Containers: [{ Names: ['/navidrome'], SizeRw: 1024 }],
      Volumes: [],
    });
  }
}

export class MockRegistryConnector implements RegistryConnector {
  public checkImageUpdate(imageRef: string, localDigests: readonly string[]) {
    const localDigest = localDigests[0]?.split('@')[1];
    const hasUpdate = imageRef.includes('jellyfin');
    return Promise.resolve({
      image: imageRef,
      local_digest: localDigest,
      remote_digest: hasUpdate ? 'sha256:newremoterelease0000' : localDigest,
      update_available: hasUpdate,
    });
  }
}

export class MockNpmConnector implements NpmConnector {
  public constructor(private readonly state: MockState) {}

  public listProxyHosts() {
    return Promise.resolve(this.state.npmHosts);
  }

  public listCertificates() {
    return Promise.resolve(this.state.npmCerts);
  }

  public listAccessLists() {
    return Promise.resolve(this.state.npmAccessLists);
  }
}

export class MockCloudflareConnector implements CloudflareConnector {
  public constructor(private readonly state: MockState) {}

  public getTunnelStatus() {
    return Promise.resolve({
      id: 'tun-mock',
      name: 'homelab-tunnel',
      status: 'healthy',
      connections: this.state.cfConnections,
    });
  }

  public getTunnelConfig() {
    return Promise.resolve(this.state.cfTunnelConfig);
  }

  public listDnsRecords() {
    return Promise.resolve(this.state.cfDnsRecords);
  }

  public listAccessApps() {
    return Promise.resolve(this.state.cfAccessApps);
  }
}

export class MockVaultwardenConnector implements VaultwardenConnector {
  public checkHealth(opts: {
    containerLabels?: Record<string, string>;
    containerEnvKeys?: readonly string[];
    configuredDomain?: string | undefined;
  }) {
    const ver = opts.containerLabels?.['org.opencontainers.image.version'] ?? '1.37.0';
    return Promise.resolve({
      alive: true,
      version: ver,
      latest_version: ver,
      update_available: false,
      signups_disabled: true,
      admin_panel_disabled: !(opts.containerEnvKeys ?? []).includes('ADMIN_TOKEN'),
      domain_matches_public_url: opts.configuredDomain === 'https://vw.example.com',
    });
  }
}

export class MockHttpProbeConnector implements HttpProbeConnector {
  public probe(url: string): Promise<HttpProbeResult> {
    if (url.includes('stale-dead') || url.includes(':19999')) {
      return Promise.resolve({
        url,
        ok: false,
        status_code: 502,
        latency_ms: 15,
        redirect_chain: [],
        final_url: url,
        error: 'Bad Gateway (upstream unreachable)',
      });
    }
    return Promise.resolve({
      url,
      ok: true,
      status_code: 200,
      latency_ms: 12,
      redirect_chain: [],
      final_url: url,
      ...(url.startsWith('https://')
        ? { tls_valid_to: '2027-02-01T00:00:00.000Z', tls_days_remaining: 69 }
        : {}),
    });
  }
}
