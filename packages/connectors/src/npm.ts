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

export interface CreateNpmProxyHostInput {
  domain_names: string[];
  forward_scheme?: 'http' | 'https' | undefined;
  forward_host: string;
  forward_port: number;
  certificate_id?: number | undefined;
  access_list_id?: number | undefined;
  ssl_forced?: boolean | undefined;
  block_exploits?: boolean | undefined;
  allow_websocket_upgrade?: boolean | undefined;
  caching_enabled?: boolean | undefined;
  enabled?: boolean | undefined;
}

export interface NpmConnector {
  listProxyHosts(): Promise<NpmProxyHost[]>;
  listCertificates(): Promise<NpmCertificate[]>;
  listAccessLists(): Promise<NpmAccessList[]>;
  createProxyHost(input: CreateNpmProxyHostInput): Promise<NpmProxyHost>;
  updateProxyHost(id: number, input: Partial<CreateNpmProxyHostInput>): Promise<NpmProxyHost>;
  deleteProxyHost(id: number): Promise<void>;
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

  public async createProxyHost(input: CreateNpmProxyHostInput): Promise<NpmProxyHost> {
    const token = await this.getToken();
    let certId = input.certificate_id;
    if (certId === undefined && input.domain_names[0]) {
      const certs = await this.listCertificates();
      const domain = input.domain_names[0];
      const match = certs.find((c) =>
        c.domain_names.some((pat) =>
          pat.startsWith('*.') ? domain.endsWith(pat.slice(1)) : domain === pat,
        ),
      );
      certId = match?.id ?? 0;
    }
    return fetchJson<NpmProxyHost>(`${this.baseUrl}/api/nginx/proxy-hosts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        domain_names: input.domain_names,
        forward_scheme: input.forward_scheme ?? 'http',
        forward_host: input.forward_host,
        forward_port: input.forward_port,
        certificate_id: certId ?? 0,
        access_list_id: input.access_list_id ?? 0,
        ssl_forced: input.ssl_forced ?? true,
        block_exploits: input.block_exploits ?? true,
        allow_websocket_upgrade: input.allow_websocket_upgrade ?? true,
        caching_enabled: input.caching_enabled ?? false,
        enabled: input.enabled ?? true,
        http2_support: true,
        meta: { letsencrypt_agree: false, dns_challenge: false },
      }),
      serviceName: 'npm',
    });
  }

  public async updateProxyHost(
    id: number,
    input: Partial<CreateNpmProxyHostInput>,
  ): Promise<NpmProxyHost> {
    const token = await this.getToken();
    return fetchJson<NpmProxyHost>(`${this.baseUrl}/api/nginx/proxy-hosts/${id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      serviceName: 'npm',
    });
  }

  public async deleteProxyHost(id: number): Promise<void> {
    const token = await this.getToken();
    await fetchWithTimeout(`${this.baseUrl}/api/nginx/proxy-hosts/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      serviceName: 'npm',
    });
  }
}
