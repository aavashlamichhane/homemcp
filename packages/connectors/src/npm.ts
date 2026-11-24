import { fetchJson, fetchWithTimeout } from './http.js';

export interface NpmProxyHost {
  id: number;
  domain_names: string[];
  forward_scheme: string;
  forward_host: string;
  forward_port: number;
  certificate_id: number;
  access_list_id: number;
  ssl_forced: boolean;
  block_exploits: boolean;
  allow_websocket_upgrade: boolean;
  caching_enabled: boolean;
  enabled: boolean;
  certificate?: { id: number; nice_name: string; expires_on?: string } | null;
  access_list?: { id: number; name: string } | null;
}

export interface NpmCertificate {
  id: number;
  nice_name: string;
  domain_names: string[];
  expires_on: string;
  provider: string;
}

export interface NpmAccessList {
  id: number;
  name: string;
}

export interface NpmConnector {
  listProxyHosts(): Promise<NpmProxyHost[]>;
  listCertificates(): Promise<NpmCertificate[]>;
  listAccessLists(): Promise<NpmAccessList[]>;
}

export class HttpNpmConnector implements NpmConnector {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private cachedToken: { token: string; expiresAtMs: number } | undefined;

  public constructor(opts: { url: string; email: string; password: string }) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.email = opts.email;
    this.password = opts.password;
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - 300_000 > now) {
      return this.cachedToken.token;
    }
    const resp = await fetchWithTimeout(`${this.baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: this.email, secret: this.password }),
      serviceName: 'npm',
    });
    if (!resp.ok) {
      throw new Error(`NPM token auth failed (${resp.status})`);
    }
    const json = (await resp.json()) as { token: string; expires?: string };
    const expMs = json.expires ? Date.parse(json.expires) : now + 3_600_000;
    this.cachedToken = {
      token: json.token,
      expiresAtMs: Number.isFinite(expMs) ? expMs : now + 3_600_000,
    };
    return this.cachedToken.token;
  }

  public async listProxyHosts(): Promise<NpmProxyHost[]> {
    const token = await this.getToken();
    return fetchJson<NpmProxyHost[]>(
      `${this.baseUrl}/api/nginx/proxy-hosts?expand=owner,access_list,certificate`,
      { headers: { Authorization: `Bearer ${token}` }, serviceName: 'npm' },
    );
  }

  public async listCertificates(): Promise<NpmCertificate[]> {
    const token = await this.getToken();
    return fetchJson<NpmCertificate[]>(`${this.baseUrl}/api/nginx/certificates`, {
      headers: { Authorization: `Bearer ${token}` },
      serviceName: 'npm',
    });
  }

  public async listAccessLists(): Promise<NpmAccessList[]> {
    const token = await this.getToken();
    return fetchJson<NpmAccessList[]>(`${this.baseUrl}/api/nginx/access-lists`, {
      headers: { Authorization: `Bearer ${token}` },
      serviceName: 'npm',
    });
  }
}
