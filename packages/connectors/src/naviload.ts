import { fetchJson } from './http.js';

export interface NaviloadSearchCandidate {
  video_id: string;
  url: string;
  title: string;
  channel: string;
  duration_seconds: number;
  view_count?: number | undefined;
  is_topic_channel?: boolean | undefined;
  already_in_library?: boolean | undefined;
  already_in_queue?: boolean | undefined;
}

export interface NaviloadTrack {
  id: string;
  video_id?: string | undefined;
  url?: string | undefined;
  title: string;
  artist?: string | undefined;
  album?: string | undefined;
  status: string;
  saved_filename?: string | undefined;
  saved_relpath?: string | undefined;
  error?: string | undefined;
  suggestions?: Array<Record<string, unknown>> | undefined;
}

export interface NaviloadConnector {
  health(): Promise<Record<string, unknown>>;
  searchYoutube(query: string, limit?: number): Promise<NaviloadSearchCandidate[]>;
  inspectUrl(url: string): Promise<Record<string, unknown>>;
  downloadTracks(opts: {
    urls: readonly string[];
    quality?: string | undefined;
  }): Promise<{ job_id?: string | undefined; queued: number; items: Array<Record<string, unknown>> }>;
  getStatus(): Promise<{ tracks: NaviloadTrack[]; queue_depth?: number | undefined }>;
  getLibrary(): Promise<Array<Record<string, unknown>>>;
  reviewTrack(opts: {
    trackId: string;
    policy: 'keep_youtube' | 'suggestion' | 'manual';
    suggestionIndex?: number | undefined;
    manualTags?: { title?: string; artist?: string; album?: string } | undefined;
    artworkPolicy?: 'db_then_youtube' | 'youtube' | undefined;
  }): Promise<Record<string, unknown>>;
  confirmTrack(trackId: string): Promise<Record<string, unknown>>;
  cancelTrack(trackId: string): Promise<Record<string, unknown>>;
  retryTrack(trackId: string): Promise<Record<string, unknown>>;
}

export class HttpNaviloadConnector implements NaviloadConnector {
  private readonly baseUrl: string;
  private readonly token: string;

  public constructor(opts: { url: string; token: string }) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
  }

  public health(): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(`${this.baseUrl}/healthz`, {
      serviceName: 'naviload',
    });
  }

  public async searchYoutube(query: string, limit = 5): Promise<NaviloadSearchCandidate[]> {
    const qs = new URLSearchParams({ q: query, limit: String(Math.min(Math.max(limit, 1), 10)) });
    const res = await fetchJson<{ results: NaviloadSearchCandidate[] }>(
      `${this.baseUrl}/api/search?${qs.toString()}`,
      { headers: this.headers(), serviceName: 'naviload', timeoutMs: 20_000 },
    );
    return res.results ?? [];
  }

  public inspectUrl(url: string): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(`${this.baseUrl}/api/inspect`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ url }),
      serviceName: 'naviload',
      timeoutMs: 20_000,
    });
  }

  public downloadTracks(opts: { urls: readonly string[]; quality?: string | undefined }) {
    return fetchJson<{ job_id?: string | undefined; queued: number; items: Array<Record<string, unknown>> }>(
      `${this.baseUrl}/api/download`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ urls: opts.urls, ...(opts.quality ? { quality: opts.quality } : {}) }),
        serviceName: 'naviload',
      },
    );
  }

  public getStatus(): Promise<{ tracks: NaviloadTrack[]; queue_depth?: number | undefined }> {
    return fetchJson<{ tracks: NaviloadTrack[]; queue_depth?: number | undefined }>(
      `${this.baseUrl}/api/status`,
      { headers: this.headers(), serviceName: 'naviload' },
    );
  }

  public getLibrary(): Promise<Array<Record<string, unknown>>> {
    return fetchJson<Array<Record<string, unknown>>>(`${this.baseUrl}/api/library`, {
      headers: this.headers(),
      serviceName: 'naviload',
    });
  }

  public reviewTrack(opts: {
    trackId: string;
    policy: 'keep_youtube' | 'suggestion' | 'manual';
    suggestionIndex?: number | undefined;
    manualTags?: { title?: string; artist?: string; album?: string } | undefined;
    artworkPolicy?: 'db_then_youtube' | 'youtube' | undefined;
  }): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(
      `${this.baseUrl}/api/tracks/${encodeURIComponent(opts.trackId)}/review`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          policy: opts.policy,
          ...(opts.suggestionIndex !== undefined ? { suggestion_index: opts.suggestionIndex } : {}),
          ...(opts.manualTags ? { manual_tags: opts.manualTags } : {}),
          ...(opts.artworkPolicy ? { artwork_policy: opts.artworkPolicy } : {}),
        }),
        serviceName: 'naviload',
      },
    );
  }

  public confirmTrack(trackId: string): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(
      `${this.baseUrl}/api/tracks/${encodeURIComponent(trackId)}/confirm`,
      { method: 'POST', headers: this.headers(), serviceName: 'naviload' },
    );
  }

  public cancelTrack(trackId: string): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(
      `${this.baseUrl}/api/tracks/${encodeURIComponent(trackId)}/cancel`,
      { method: 'POST', headers: this.headers(), serviceName: 'naviload' },
    );
  }

  public retryTrack(trackId: string): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(
      `${this.baseUrl}/api/tracks/${encodeURIComponent(trackId)}/retry`,
      { method: 'POST', headers: this.headers(), serviceName: 'naviload' },
    );
  }
}
