import { HomemcpError } from '@homemcp/core';
import { fetchJson, fetchWithTimeout } from './http.js';

export interface JellyfinSystemInfo {
  ServerName: string;
  Version: string;
  Id: string;
  OperatingSystem?: string | undefined;
  HasPendingRestart?: boolean | undefined;
}

export interface JellyfinSession {
  Id: string;
  UserName?: string | undefined;
  Client?: string | undefined;
  DeviceName?: string | undefined;
  NowPlayingItem?:
    | {
        Id: string;
        Name: string;
        Type: string;
        RunTimeTicks?: number | undefined;
      }
    | undefined;
  PlayState?:
    | {
        IsPaused?: boolean | undefined;
        PositionTicks?: number | undefined;
        PlayMethod?: string | undefined;
      }
    | undefined;
  TranscodingInfo?:
    | {
        VideoCodec?: string | undefined;
        AudioCodec?: string | undefined;
        IsVideoDirect?: boolean | undefined;
        IsAudioDirect?: boolean | undefined;
        Bitrate?: number | undefined;
        Framerate?: number | undefined;
        CompletionPercentage?: number | undefined;
        TranscodeReasons?: string[] | undefined;
        HardwareAccelerationType?: string | undefined;
      }
    | undefined;
}

export interface JellyfinLibrary {
  Name: string;
  CollectionType?: string | undefined;
  ItemId?: string | undefined;
  Locations?: string[] | undefined;
  RefreshProgress?: number | undefined;
  RefreshStatus?: string | undefined;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  ProductionYear?: number | undefined;
  Path?: string | undefined;
  DateCreated?: string | undefined;
  ProviderIds?: Record<string, string> | undefined;
  ImageTags?: Record<string, string> | undefined;
}

export interface JellyfinScheduledTask {
  Id: string;
  Name: string;
  State: string;
  Category?: string | undefined;
  LastExecutionResult?:
    | {
        StartTimeUtc: string;
        EndTimeUtc: string;
        Status: string;
        ErrorMessage?: string | undefined;
      }
    | undefined;
}

export interface JellyfinConnector {
  getHealth(): Promise<{ ok: boolean; status_code: number }>;
  getSystemInfo(): Promise<JellyfinSystemInfo>;
  getSessions(): Promise<JellyfinSession[]>;
  getLibraries(): Promise<JellyfinLibrary[]>;
  searchItems(opts: {
    searchTerm?: string | undefined;
    includeItemTypes?: string | undefined;
    limit?: number | undefined;
    sortBy?: string | undefined;
    sortOrder?: 'Ascending' | 'Descending' | undefined;
    recursive?: boolean | undefined;
  }): Promise<{ Items: JellyfinItem[]; TotalRecordCount: number }>;
  getScheduledTasks(): Promise<JellyfinScheduledTask[]>;
  runScheduledTask(taskId: string): Promise<void>;
  getActivityLog(limit?: number): Promise<Array<Record<string, unknown>>>;
  getUsers(): Promise<Array<Record<string, unknown>>>;
}

export class HttpJellyfinConnector implements JellyfinConnector {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  public constructor(opts: { url: string; apiKey: string }) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      'X-Emby-Token': this.apiKey,
      accept: 'application/json',
    };
  }

  public async getHealth(): Promise<{ ok: boolean; status_code: number }> {
    const resp = await fetchWithTimeout(`${this.baseUrl}/health`, {
      serviceName: 'jellyfin',
    });
    const text = await resp.text().catch(() => '');
    return {
      ok: resp.ok && text.trim().toLowerCase() === 'healthy',
      status_code: resp.status,
    };
  }

  public getSystemInfo(): Promise<JellyfinSystemInfo> {
    return fetchJson<JellyfinSystemInfo>(`${this.baseUrl}/System/Info`, {
      headers: this.headers(),
      serviceName: 'jellyfin',
    });
  }

  public getSessions(): Promise<JellyfinSession[]> {
    return fetchJson<JellyfinSession[]>(`${this.baseUrl}/Sessions`, {
      headers: this.headers(),
      serviceName: 'jellyfin',
    });
  }

  public getLibraries(): Promise<JellyfinLibrary[]> {
    return fetchJson<JellyfinLibrary[]>(`${this.baseUrl}/Library/VirtualFolders`, {
      headers: this.headers(),
      serviceName: 'jellyfin',
    });
  }

  public searchItems(opts: {
    searchTerm?: string | undefined;
    includeItemTypes?: string | undefined;
    limit?: number | undefined;
    sortBy?: string | undefined;
    sortOrder?: 'Ascending' | 'Descending' | undefined;
    recursive?: boolean | undefined;
  }): Promise<{ Items: JellyfinItem[]; TotalRecordCount: number }> {
    const qs = new URLSearchParams({
      Recursive: String(opts.recursive ?? true),
      Fields: 'Path,ProviderIds,DateCreated',
      Limit: String(opts.limit ?? 50),
    });
    if (opts.searchTerm) qs.set('SearchTerm', opts.searchTerm);
    if (opts.includeItemTypes) qs.set('IncludeItemTypes', opts.includeItemTypes);
    if (opts.sortBy) qs.set('SortBy', opts.sortBy);
    if (opts.sortOrder) qs.set('SortOrder', opts.sortOrder);

    return fetchJson<{ Items: JellyfinItem[]; TotalRecordCount: number }>(
      `${this.baseUrl}/Items?${qs.toString()}`,
      { headers: this.headers(), serviceName: 'jellyfin' },
    );
  }

  public getScheduledTasks(): Promise<JellyfinScheduledTask[]> {
    return fetchJson<JellyfinScheduledTask[]>(`${this.baseUrl}/ScheduledTasks`, {
      headers: this.headers(),
      serviceName: 'jellyfin',
    });
  }

  public async runScheduledTask(taskId: string): Promise<void> {
    const resp = await fetchWithTimeout(
      `${this.baseUrl}/ScheduledTasks/Running/${encodeURIComponent(taskId)}`,
      {
        method: 'POST',
        headers: this.headers(),
        serviceName: 'jellyfin',
      },
    );
    if (resp.status === 401 || resp.status === 403) {
      throw new HomemcpError('UPSTREAM_AUTH', `Jellyfin rejected credentials (${resp.status})`);
    }
    if (resp.status === 404) {
      throw new HomemcpError('NOT_FOUND', `Jellyfin scheduled task not found: ${taskId}`);
    }
    if (!resp.ok) {
      throw new HomemcpError('UPSTREAM_UNAVAILABLE', `Jellyfin run task failed (${resp.status})`);
    }
  }

  public async getActivityLog(limit = 50): Promise<Array<Record<string, unknown>>> {
    const res = await fetchJson<{ Items?: Array<Record<string, unknown>> }>(
      `${this.baseUrl}/System/ActivityLog/Entries?Limit=${limit}`,
      { headers: this.headers(), serviceName: 'jellyfin' },
    );
    return res.Items ?? [];
  }

  public getUsers(): Promise<Array<Record<string, unknown>>> {
    return fetchJson<Array<Record<string, unknown>>>(`${this.baseUrl}/Users`, {
      headers: this.headers(),
      serviceName: 'jellyfin',
    });
  }
}
