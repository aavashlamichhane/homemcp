import { HomemcpError } from '@homemcp/core';
import { fetchJson, fetchWithTimeout } from './http.js';

export interface QbitTransferInfo {
  dl_info_speed: number;
  up_info_speed: number;
  dl_info_data: number;
  up_info_data: number;
  connection_status: string;
}

export interface QbitTorrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  state: string;
  ratio: number;
  category: string;
  save_path: string;
}

export interface QbittorrentConnector {
  getTransferInfo(): Promise<QbitTransferInfo>;
  listTorrents(filter?: string): Promise<QbitTorrent[]>;
  addTorrent(opts: {
    urls: readonly string[];
    category?: string | undefined;
    savepath?: string | undefined;
  }): Promise<void>;
  controlTorrents(action: 'pause' | 'resume' | 'recheck', hashes: readonly string[]): Promise<void>;
  deleteTorrents(hashes: readonly string[], deleteFiles: boolean): Promise<void>;
}

export class HttpQbittorrentConnector implements QbittorrentConnector {
  private readonly baseUrl: string;
  private readonly user: string;
  private readonly password: string;
  private sidCookie: string | undefined;

  public constructor(opts: { url: string; user: string; password: string }) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.user = opts.user;
    this.password = opts.password;
  }

  private async login(): Promise<string> {
    const resp = await fetchWithTimeout(`${this.baseUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.user, password: this.password }).toString(),
      serviceName: 'qbittorrent',
    });
    const txt = (await resp.text().catch(() => '')).trim();
    if (!resp.ok || txt === 'Fails.') {
      throw new HomemcpError('UPSTREAM_AUTH', 'qBittorrent authentication failed');
    }
    const setCookie = resp.headers.get('set-cookie') ?? '';
    const match = /SID=([^;]+)/.exec(setCookie);
    if (!match?.[1]) {
      throw new HomemcpError('UPSTREAM_AUTH', 'qBittorrent did not issue SID cookie');
    }
    this.sidCookie = `SID=${match[1]}`;
    return this.sidCookie;
  }

  private async withAuth(
    path: string,
    opts: {
      method?: string | undefined;
      headers?: Record<string, string> | undefined;
      body?: string | undefined;
    } = {},
    retry = true,
  ): Promise<Response> {
    const cookie = this.sidCookie ?? (await this.login());
    const resp = await fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: opts.method,
      headers: { ...(opts.headers ?? {}), Cookie: cookie },
      body: opts.body,
      serviceName: 'qbittorrent',
    });
    if ((resp.status === 401 || resp.status === 403) && retry) {
      this.sidCookie = undefined;
      return this.withAuth(path, opts, false);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new HomemcpError('UPSTREAM_AUTH', `qBittorrent returned ${resp.status}`);
    }
    if (!resp.ok) {
      throw new HomemcpError('UPSTREAM_UNAVAILABLE', `qBittorrent HTTP ${resp.status}`);
    }
    return resp;
  }

  public async getTransferInfo(): Promise<QbitTransferInfo> {
    await this.withAuth('/api/v2/transfer/info');
    // Re-fetch with fetchJson if needed or parse directly
    const cookie = this.sidCookie ?? (await this.login());
    return fetchJson<QbitTransferInfo>(`${this.baseUrl}/api/v2/transfer/info`, {
      headers: { Cookie: cookie },
      serviceName: 'qbittorrent',
    });
  }

  public async listTorrents(filter?: string): Promise<QbitTorrent[]> {
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    const resp = await this.withAuth(`/api/v2/torrents/info${qs}`);
    return (await resp.json()) as QbitTorrent[];
  }

  public async addTorrent(opts: {
    urls: readonly string[];
    category?: string | undefined;
    savepath?: string | undefined;
  }): Promise<void> {
    const form = new URLSearchParams({ urls: opts.urls.join('\n') });
    if (opts.category) form.set('category', opts.category);
    if (opts.savepath) form.set('savepath', opts.savepath);
    await this.withAuth('/api/v2/torrents/add', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  }

  public async controlTorrents(
    action: 'pause' | 'resume' | 'recheck',
    hashes: readonly string[],
  ): Promise<void> {
    const endpoint =
      action === 'pause'
        ? '/api/v2/torrents/stop'
        : action === 'resume'
          ? '/api/v2/torrents/start'
          : '/api/v2/torrents/recheck';
    await this.withAuth(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hashes.join('|') }).toString(),
    });
  }

  public async deleteTorrents(hashes: readonly string[], deleteFiles: boolean): Promise<void> {
    await this.withAuth('/api/v2/torrents/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        hashes: hashes.join('|'),
        deleteFiles: String(deleteFiles),
      }).toString(),
    });
  }
}
