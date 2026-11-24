import { fetchWithTimeout } from './http.js';

export interface VaultwardenHealthStatus {
  alive: boolean;
  version?: string | undefined;
  latest_version?: string | undefined;
  update_available?: boolean | undefined;
  signups_disabled: boolean;
  admin_panel_disabled: boolean;
  domain_matches_public_url: boolean;
}

export interface VaultwardenConnector {
  checkHealth(opts: {
    containerLabels?: Record<string, string>;
    containerEnvKeys?: readonly string[];
    configuredDomain?: string | undefined;
  }): Promise<VaultwardenHealthStatus>;
}

export class HttpVaultwardenConnector implements VaultwardenConnector {
  private readonly url: string;
  private readonly publicUrl: string;
  private latestCache: { tag: string; expiresAt: number } | undefined;

  public constructor(opts: { url: string; publicUrl: string }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.publicUrl = opts.publicUrl.replace(/\/+$/, '');
  }

  private async getLatestReleaseTag(): Promise<string | undefined> {
    const now = Date.now();
    if (this.latestCache && this.latestCache.expiresAt > now) {
      return this.latestCache.tag;
    }
    try {
      const resp = await fetchWithTimeout(
        'https://api.github.com/repos/dani-garcia/vaultwarden/releases/latest',
        { headers: { 'user-agent': 'homemcp' }, serviceName: 'github-releases' },
      );
      if (!resp.ok) return undefined;
      const json = (await resp.json()) as { tag_name?: string };
      if (json.tag_name) {
        const clean = json.tag_name.replace(/^v/, '');
        this.latestCache = { tag: clean, expiresAt: now + 6 * 3600_000 };
        return clean;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  public async checkHealth(opts: {
    containerLabels?: Record<string, string>;
    containerEnvKeys?: readonly string[];
    configuredDomain?: string | undefined;
  }): Promise<VaultwardenHealthStatus> {
    let alive = false;
    try {
      const resp = await fetchWithTimeout(`${this.url}/alive`, { serviceName: 'vaultwarden' });
      alive = resp.ok;
    } catch {
      alive = false;
    }

    const version = opts.containerLabels?.['org.opencontainers.image.version'];
    const latest = await this.getLatestReleaseTag();
    const envKeys = new Set(opts.containerEnvKeys ?? []);
    const adminPanelDisabled = !envKeys.has('ADMIN_TOKEN');
    const signupsDisabled = envKeys.has('SIGNUPS_ALLOWED');
    const domainMatches = opts.configuredDomain
      ? opts.configuredDomain.replace(/\/+$/, '') === this.publicUrl
      : false;

    return {
      alive,
      ...(version ? { version } : {}),
      ...(latest ? { latest_version: latest } : {}),
      ...(version && latest ? { update_available: version !== latest } : {}),
      signups_disabled: signupsDisabled,
      admin_panel_disabled: adminPanelDisabled,
      domain_matches_public_url: domainMatches,
    };
  }
}
