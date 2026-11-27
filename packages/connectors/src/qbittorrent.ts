import { HomemcpError } from '@homemcp/core';
import { fetchWithTimeout } from './http.js';

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
  added_on?: number | undefined;
  completion_on?: number | undefined;
  downloaded?: number | undefined;
  uploaded?: number | undefined;
  num_seeds?: number | undefined;
  num_leechs?: number | undefined;
  amount_left?: number | undefined;
}

export interface QbitTorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

export interface QbitTorrentTracker {
  url: string;
  status: number;
  num_peers: number;
  msg: string;
}

export interface QbittorrentConnector {
  getTransferInfo(): Promise<QbitTransferInfo>;
  listTorrents(filter?: string): Promise<QbitTorrent[]>;
  getTorrentFiles(hash: string): Promise<QbitTorrentFile[]>;
  getTorrentTrackers(hash: string): Promise<QbitTorrentTracker[]>;
  addTorrent(opts: {
    urls: readonly string[];
    category?: string | undefined;
    savepath?: string | undefined;
  }): Promise<void>;
  addTorrentFile(opts: {
    filename: string;
    data: Uint8Array;
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
    const resp = await this.withAuth('/api/v2/transfer/info');
    return (await resp.json()) as QbitTransferInfo;
  }

  public async listTorrents(filter?: string): Promise<QbitTorrent[]> {
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    const resp = await this.withAuth(`/api/v2/torrents/info${qs}`);
    return (await resp.json()) as QbitTorrent[];
  }

  public async getTorrentFiles(hash: string): Promise<QbitTorrentFile[]> {
    const qs = `?hash=${encodeURIComponent(hash)}`;
    const resp = await this.withAuth(`/api/v2/torrents/files${qs}`);
    return (await resp.json()) as QbitTorrentFile[];
  }

  public async getTorrentTrackers(hash: string): Promise<QbitTorrentTracker[]> {
    const qs = `?hash=${encodeURIComponent(hash)}`;
    const resp = await this.withAuth(`/api/v2/torrents/trackers${qs}`);
    return (await resp.json()) as QbitTorrentTracker[];
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

  public async addTorrentFile(opts: {
    filename: string;
    data: Uint8Array;
    category?: string | undefined;
    savepath?: string | undefined;
  }): Promise<void> {
    const form = new FormData();
    const bytes = new Uint8Array(opts.data.byteLength);
    bytes.set(opts.data);
    form.append('torrents', new Blob([bytes], { type: 'application/x-bittorrent' }), opts.filename);
    if (opts.category) form.set('category', opts.category);
    if (opts.savepath) form.set('savepath', opts.savepath);
    const cookie = this.sidCookie ?? (await this.login());
    let resp = await fetch(`${this.baseUrl}/api/v2/torrents/add`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 401 || resp.status === 403) {
      this.sidCookie = undefined;
      const freshCookie = await this.login();
      resp = await fetch(`${this.baseUrl}/api/v2/torrents/add`, {
        method: 'POST',
        headers: { Cookie: freshCookie },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
    }
    if (!resp.ok) {
      throw new HomemcpError('UPSTREAM_UNAVAILABLE', `qBittorrent HTTP ${resp.status}`);
    }
  }

  public async controlTorrents(
    action: 'pause' | 'resume' | 'recheck',
    hashes: readonly string[],
  ): Promise<void> {
    const body = new URLSearchParams({ hashes: hashes.join('|') }).toString();
    const post = (endpoint: string) =>
      this.withAuth(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });

    if (action === 'recheck') {
      await post('/api/v2/torrents/recheck');
      return;
    }

    // qBittorrent 5.0+ uses /stop and /start; 4.6.x and older use /pause and /resume
    const v5Endpoint = action === 'pause' ? '/api/v2/torrents/stop' : '/api/v2/torrents/start';
    const v4Endpoint = action === 'pause' ? '/api/v2/torrents/pause' : '/api/v2/torrents/resume';
    try {
      await post(v5Endpoint);
    } catch (err) {
      if (err instanceof HomemcpError && err.message.includes('HTTP 404')) {
        await post(v4Endpoint);
        return;
      }
      throw err;
    }
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
