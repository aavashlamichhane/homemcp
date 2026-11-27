import { HomemcpError } from '@homemcp/core';
import { fetchJson, fetchWithTimeout } from './http.js';

export const JELLYFIN_REMOTE_SEARCH_TYPES = [
  'Movie',
  'Series',
  'BoxSet',
  'MusicAlbum',
  'MusicArtist',
  'MusicVideo',
  'Book',
  'Person',
  'Trailer',
] as const;

export type JellyfinRemoteSearchType = (typeof JELLYFIN_REMOTE_SEARCH_TYPES)[number];

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
  OriginalTitle?: string | undefined;
  Type: string;
  ProductionYear?: number | undefined;
  Path?: string | undefined;
  DateCreated?: string | undefined;
  Overview?: string | undefined;
  DisplayOrder?: string | undefined;
  IndexNumber?: number | undefined;
  IndexNumberEnd?: number | undefined;
  ParentIndexNumber?: number | undefined;
  SeriesId?: string | undefined;
  SeriesName?: string | undefined;
  SeasonId?: string | undefined;
  SeasonName?: string | undefined;
  LockData?: boolean | undefined;
  LockedFields?: string[] | undefined;
  ProviderIds?: Record<string, string> | undefined;
  ImageTags?: Record<string, string> | undefined;
}

export interface JellyfinRemoteSearchQuery {
  itemId?: string | undefined;
  name?: string | undefined;
  originalTitle?: string | undefined;
  year?: number | undefined;
  providerIds?: Record<string, string> | undefined;
  searchProviderName?: string | undefined;
  includeDisabledProviders?: boolean | undefined;
}

export interface JellyfinRemoteSearchResult {
  Name?: string | undefined;
  ProviderIds?: Record<string, string> | undefined;
  ProductionYear?: number | undefined;
  IndexNumber?: number | undefined;
  IndexNumberEnd?: number | undefined;
  ParentIndexNumber?: number | undefined;
  PremiereDate?: string | undefined;
  ImageUrl?: string | undefined;
  SearchProviderName?: string | undefined;
  Overview?: string | undefined;
  AlbumArtist?: Record<string, unknown> | undefined;
  Artists?: Array<Record<string, unknown>> | undefined;
}

export interface JellyfinRefreshOptions {
  metadataRefreshMode?: 'None' | 'ValidationOnly' | 'Default' | 'FullRefresh' | undefined;
  imageRefreshMode?: 'None' | 'ValidationOnly' | 'Default' | 'FullRefresh' | undefined;
  replaceAllMetadata?: boolean | undefined;
  replaceAllImages?: boolean | undefined;
}

export interface JellyfinMetadataPatch {
  name?: string | undefined;
  originalTitle?: string | undefined;
  productionYear?: number | undefined;
  overview?: string | undefined;
  displayOrder?: string | undefined;
  indexNumber?: number | undefined;
  indexNumberEnd?: number | undefined;
  parentIndexNumber?: number | undefined;
  providerIds?: Record<string, string> | undefined;
  lockData?: boolean | undefined;
  lockedFields?: string[] | undefined;
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
    parentId?: string | undefined;
    limit?: number | undefined;
    sortBy?: string | undefined;
    sortOrder?: 'Ascending' | 'Descending' | undefined;
    recursive?: boolean | undefined;
  }): Promise<{ Items: JellyfinItem[]; TotalRecordCount: number }>;
  getItem(itemId: string): Promise<JellyfinItem & Record<string, unknown>>;
  getItemChildren(
    parentId: string,
    opts?: {
      includeItemTypes?: string | undefined;
      recursive?: boolean | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ Items: JellyfinItem[]; TotalRecordCount: number }>;
  remoteSearch(
    itemType: JellyfinRemoteSearchType,
    query: JellyfinRemoteSearchQuery,
  ): Promise<JellyfinRemoteSearchResult[]>;
  applyRemoteSearchResult(
    itemId: string,
    result: JellyfinRemoteSearchResult,
    replaceAllImages?: boolean,
  ): Promise<void>;
  refreshItem(itemId: string, opts?: JellyfinRefreshOptions): Promise<void>;
  updateItemMetadata(itemId: string, patch: JellyfinMetadataPatch): Promise<void>;
  getScheduledTasks(): Promise<JellyfinScheduledTask[]>;
  runScheduledTask(taskId: string): Promise<void>;
  getActivityLog(limit?: number): Promise<Array<Record<string, unknown>>>;
  getUsers(): Promise<Array<Record<string, unknown>>>;
}

export class HttpJellyfinConnector implements JellyfinConnector {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private adminUserId: string | undefined;

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

  private async throwOnError(resp: Response, context: string, notFoundMsg?: string): Promise<void> {
    if (resp.status === 401 || resp.status === 403) {
      throw new HomemcpError('UPSTREAM_AUTH', `Jellyfin rejected credentials (${resp.status})`);
    }
    if (resp.status === 404) {
      throw new HomemcpError('NOT_FOUND', notFoundMsg ?? `Jellyfin ${context} not found`);
    }
    if (resp.status === 400) {
      const text = await resp.text().catch(() => '');
      throw new HomemcpError(
        'INVALID_ARGUMENT',
        `Jellyfin rejected ${context} (400): ${text.slice(0, 200)}`,
      );
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new HomemcpError(
        'UPSTREAM_UNAVAILABLE',
        `Jellyfin ${context} failed (${resp.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
  }

  private async resolveAdminUserId(): Promise<string | undefined> {
    if (this.adminUserId) return this.adminUserId;
    try {
      const users = await this.getUsers();
      const admin =
        users.find(
          (u) => (u['Policy'] as { IsAdministrator?: boolean } | undefined)?.IsAdministrator,
        ) ?? users[0];
      if (admin && typeof admin['Id'] === 'string' && admin['Id']) {
        this.adminUserId = admin['Id'];
        return this.adminUserId;
      }
    } catch {
      // Fallback to /Items?Ids=... when /Users is unavailable
    }
    return undefined;
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
    parentId?: string | undefined;
    limit?: number | undefined;
    sortBy?: string | undefined;
    sortOrder?: 'Ascending' | 'Descending' | undefined;
    recursive?: boolean | undefined;
  }): Promise<{ Items: JellyfinItem[]; TotalRecordCount: number }> {
    const qs = new URLSearchParams({
      Recursive: String(opts.recursive ?? true),
      Fields: 'Path,ProviderIds,DateCreated,Overview,DisplayOrder',
      Limit: String(opts.limit ?? 50),
    });
    if (opts.searchTerm) qs.set('SearchTerm', opts.searchTerm);
    if (opts.includeItemTypes) qs.set('IncludeItemTypes', opts.includeItemTypes);
    if (opts.parentId) qs.set('ParentId', opts.parentId);
    if (opts.sortBy) qs.set('SortBy', opts.sortBy);
    if (opts.sortOrder) qs.set('SortOrder', opts.sortOrder);

    return fetchJson<{ Items: JellyfinItem[]; TotalRecordCount: number }>(
      `${this.baseUrl}/Items?${qs.toString()}`,
      { headers: this.headers(), serviceName: 'jellyfin' },
    );
  }

  public async getItem(itemId: string): Promise<JellyfinItem & Record<string, unknown>> {
    const userId = await this.resolveAdminUserId();
    if (userId) {
      const resp = await fetchWithTimeout(
        `${this.baseUrl}/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}`,
        { headers: this.headers(), serviceName: 'jellyfin' },
      );
      if (resp.ok) {
        return (await resp.json()) as JellyfinItem & Record<string, unknown>;
      }
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
        await this.throwOnError(resp, 'item lookup', `Jellyfin item not found: ${itemId}`);
      }
    }

    const qs = new URLSearchParams({
      Ids: itemId,
      Fields:
        'Path,ProviderIds,DateCreated,Overview,DisplayOrder,Genres,Tags,People,Studios,ExternalUrls,OriginalTitle',
    });
    const res = await fetchJson<{ Items: Array<JellyfinItem & Record<string, unknown>> }>(
      `${this.baseUrl}/Items?${qs.toString()}`,
      { headers: this.headers(), serviceName: 'jellyfin' },
    );
    const first = res.Items[0];
    if (!first) {
      throw new HomemcpError('NOT_FOUND', `Jellyfin item not found: ${itemId}`);
    }
    return first;
  }

  public getItemChildren(
    parentId: string,
    opts?: {
      includeItemTypes?: string | undefined;
      recursive?: boolean | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ Items: JellyfinItem[]; TotalRecordCount: number }> {
    const qs = new URLSearchParams({
      ParentId: parentId,
      Recursive: String(opts?.recursive ?? false),
      Fields: 'Path,ProviderIds,DateCreated,Overview,DisplayOrder',
      SortBy: 'ParentIndexNumber,IndexNumber,SortName',
      SortOrder: 'Ascending',
      Limit: String(opts?.limit ?? 100),
    });
    if (opts?.includeItemTypes) qs.set('IncludeItemTypes', opts.includeItemTypes);
    return fetchJson<{ Items: JellyfinItem[]; TotalRecordCount: number }>(
      `${this.baseUrl}/Items?${qs.toString()}`,
      { headers: this.headers(), serviceName: 'jellyfin' },
    );
  }

  public remoteSearch(
    itemType: JellyfinRemoteSearchType,
    query: JellyfinRemoteSearchQuery,
  ): Promise<JellyfinRemoteSearchResult[]> {
    const searchInfo: Record<string, unknown> = {};
    if (query.name !== undefined) searchInfo['Name'] = query.name;
    if (query.originalTitle !== undefined) searchInfo['OriginalTitle'] = query.originalTitle;
    if (query.year !== undefined) searchInfo['Year'] = query.year;
    if (query.providerIds !== undefined) searchInfo['ProviderIds'] = query.providerIds;

    const payload: Record<string, unknown> = { SearchInfo: searchInfo };
    if (query.itemId !== undefined) payload['ItemId'] = query.itemId;
    if (query.searchProviderName !== undefined) {
      payload['SearchProviderName'] = query.searchProviderName;
    }
    if (query.includeDisabledProviders !== undefined) {
      payload['IncludeDisabledProviders'] = query.includeDisabledProviders;
    }

    return fetchJson<JellyfinRemoteSearchResult[]>(
      `${this.baseUrl}/Items/RemoteSearch/${encodeURIComponent(itemType)}`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 30_000,
        serviceName: 'jellyfin',
      },
    );
  }

  public async applyRemoteSearchResult(
    itemId: string,
    result: JellyfinRemoteSearchResult,
    replaceAllImages = true,
  ): Promise<void> {
    const resp = await fetchWithTimeout(
      `${this.baseUrl}/Items/RemoteSearch/Apply/${encodeURIComponent(itemId)}?replaceAllImages=${String(replaceAllImages)}`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(result),
        timeoutMs: 30_000,
        serviceName: 'jellyfin',
      },
    );
    await this.throwOnError(resp, 'apply identify result', `Jellyfin item not found: ${itemId}`);
  }

  public async refreshItem(itemId: string, opts?: JellyfinRefreshOptions): Promise<void> {
    const qs = new URLSearchParams({
      metadataRefreshMode: opts?.metadataRefreshMode ?? 'FullRefresh',
      imageRefreshMode: opts?.imageRefreshMode ?? 'Default',
      replaceAllMetadata: String(opts?.replaceAllMetadata ?? false),
      replaceAllImages: String(opts?.replaceAllImages ?? false),
    });
    const resp = await fetchWithTimeout(
      `${this.baseUrl}/Items/${encodeURIComponent(itemId)}/Refresh?${qs.toString()}`,
      {
        method: 'POST',
        headers: this.headers(),
        timeoutMs: 15_000,
        serviceName: 'jellyfin',
      },
    );
    await this.throwOnError(resp, 'refresh item', `Jellyfin item not found: ${itemId}`);
  }

  public async updateItemMetadata(itemId: string, patch: JellyfinMetadataPatch): Promise<void> {
    const existing = await this.getItem(itemId);
    const updated: Record<string, unknown> = { ...existing };

    if (patch.name !== undefined) updated['Name'] = patch.name;
    if (patch.originalTitle !== undefined) updated['OriginalTitle'] = patch.originalTitle;
    if (patch.productionYear !== undefined) updated['ProductionYear'] = patch.productionYear;
    if (patch.overview !== undefined) updated['Overview'] = patch.overview;
    if (patch.displayOrder !== undefined) updated['DisplayOrder'] = patch.displayOrder;
    if (patch.indexNumber !== undefined) updated['IndexNumber'] = patch.indexNumber;
    if (patch.indexNumberEnd !== undefined) updated['IndexNumberEnd'] = patch.indexNumberEnd;
    if (patch.parentIndexNumber !== undefined) {
      updated['ParentIndexNumber'] = patch.parentIndexNumber;
    }
    if (patch.lockData !== undefined) updated['LockData'] = patch.lockData;
    if (patch.lockedFields !== undefined) updated['LockedFields'] = [...patch.lockedFields];
    if (patch.providerIds !== undefined) {
      const merged: Record<string, string> = { ...(existing.ProviderIds ?? {}) };
      for (const [key, val] of Object.entries(patch.providerIds)) {
        if (val === '') {
          delete merged[key];
        } else {
          merged[key] = val;
        }
      }
      updated['ProviderIds'] = merged;
    }

    const resp = await fetchWithTimeout(`${this.baseUrl}/Items/${encodeURIComponent(itemId)}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(updated),
      timeoutMs: 30_000,
      serviceName: 'jellyfin',
    });
    await this.throwOnError(resp, 'update item metadata', `Jellyfin item not found: ${itemId}`);
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
    await this.throwOnError(resp, 'run task', `Jellyfin scheduled task not found: ${taskId}`);
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
