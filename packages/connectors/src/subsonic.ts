import { createHash, randomBytes } from 'node:crypto';
import { HomemcpError } from '@homemcp/core';
import { fetchJson } from './http.js';

export interface SubsonicSong {
  id: string;
  title: string;
  artist: string;
  album?: string | undefined;
  duration?: number | undefined;
  path?: string | undefined;
  track?: number | undefined;
  year?: number | undefined;
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  comment?: string | undefined;
  public?: boolean | undefined;
  songCount: number;
  duration: number;
  changed?: string | undefined;
  entry?: SubsonicSong[] | undefined;
}

export interface SubsonicScanStatus {
  scanning: boolean;
  count?: number | undefined;
  folderCount?: number | undefined;
  lastScan?: number | undefined;
}

export interface SubsonicConnector {
  ping(): Promise<boolean>;
  search3(
    query: string,
    opts?: {
      songCount?: number | undefined;
      albumCount?: number | undefined;
      artistCount?: number | undefined;
    },
  ): Promise<{
    artists: Array<Record<string, unknown>>;
    albums: Array<Record<string, unknown>>;
    songs: SubsonicSong[];
  }>;
  getPlaylists(): Promise<SubsonicPlaylist[]>;
  getPlaylist(id: string): Promise<SubsonicPlaylist>;
  createPlaylist(name: string, songIds?: readonly string[]): Promise<SubsonicPlaylist>;
  updatePlaylist(opts: {
    playlistId: string;
    name?: string | undefined;
    comment?: string | undefined;
    public?: boolean | undefined;
    songIdToAdd?: readonly string[] | undefined;
    songIndexToRemove?: readonly number[] | undefined;
  }): Promise<void>;
  deletePlaylist(playlistId: string): Promise<void>;
  startScan(fullScan?: boolean): Promise<SubsonicScanStatus>;
  getScanStatus(): Promise<SubsonicScanStatus>;
  getAlbumList2(
    type: 'newest' | 'recent' | 'frequent',
    size?: number,
  ): Promise<Array<Record<string, unknown>>>;
  getNowPlaying(): Promise<Array<Record<string, unknown>>>;
  getArtists(): Promise<Array<Record<string, unknown>>>;
  getSong(id: string): Promise<SubsonicSong>;
}

interface SubsonicEnvelope<T> {
  'subsonic-response': {
    status: 'ok' | 'failed';
    error?: { code: number; message: string };
  } & T;
}

export class HttpSubsonicConnector implements SubsonicConnector {
  private readonly baseUrl: string;
  private readonly user: string;
  private readonly password: string;

  public constructor(opts: { url: string; user: string; password: string }) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.user = opts.user;
    this.password = opts.password;
  }

  private async call<T>(
    endpoint: string,
    params: Array<[string, string]> = [],
  ): Promise<SubsonicEnvelope<T>['subsonic-response']> {
    const salt = randomBytes(6).toString('hex');
    const token = createHash('md5').update(`${this.password}${salt}`).digest('hex');
    const qs = new URLSearchParams({
      u: this.user,
      t: token,
      s: salt,
      v: '1.16.1',
      c: 'homemcp',
      f: 'json',
    });
    for (const [k, v] of params) {
      qs.append(k, v);
    }
    const env = await fetchJson<SubsonicEnvelope<T>>(
      `${this.baseUrl}/rest/${endpoint}?${qs.toString()}`,
      { serviceName: 'navidrome' },
    );
    const body = env['subsonic-response'];
    if (body.status !== 'ok') {
      const code = body.error?.code;
      throw new HomemcpError(
        code === 40 ? 'UPSTREAM_AUTH' : code === 70 ? 'NOT_FOUND' : 'UPSTREAM_UNAVAILABLE',
        `Subsonic ${endpoint} error: ${body.error?.message ?? 'unknown'}`,
      );
    }
    return body;
  }

  public async ping(): Promise<boolean> {
    await this.call('ping');
    return true;
  }

  public async search3(
    query: string,
    opts?: {
      songCount?: number | undefined;
      albumCount?: number | undefined;
      artistCount?: number | undefined;
    },
  ) {
    const res = await this.call<{
      searchResult3?: {
        artist?: Array<Record<string, unknown>>;
        album?: Array<Record<string, unknown>>;
        song?: SubsonicSong[];
      };
    }>('search3', [
      ['query', query],
      ['songCount', String(opts?.songCount ?? 20)],
      ['albumCount', String(opts?.albumCount ?? 10)],
      ['artistCount', String(opts?.artistCount ?? 10)],
    ]);
    return {
      artists: res.searchResult3?.artist ?? [],
      albums: res.searchResult3?.album ?? [],
      songs: res.searchResult3?.song ?? [],
    };
  }

  public async getPlaylists(): Promise<SubsonicPlaylist[]> {
    const res = await this.call<{ playlists?: { playlist?: SubsonicPlaylist[] } }>('getPlaylists');
    return res.playlists?.playlist ?? [];
  }

  public async getPlaylist(id: string): Promise<SubsonicPlaylist> {
    const res = await this.call<{ playlist: SubsonicPlaylist }>('getPlaylist', [['id', id]]);
    return res.playlist;
  }

  public async createPlaylist(
    name: string,
    songIds: readonly string[] = [],
  ): Promise<SubsonicPlaylist> {
    const params: Array<[string, string]> = [['name', name]];
    for (const id of songIds) params.push(['songId', id]);
    const res = await this.call<{ playlist: SubsonicPlaylist }>('createPlaylist', params);
    return res.playlist;
  }

  public async updatePlaylist(opts: {
    playlistId: string;
    name?: string | undefined;
    comment?: string | undefined;
    public?: boolean | undefined;
    songIdToAdd?: readonly string[] | undefined;
    songIndexToRemove?: readonly number[] | undefined;
  }): Promise<void> {
    const params: Array<[string, string]> = [['playlistId', opts.playlistId]];
    if (opts.name !== undefined) params.push(['name', opts.name]);
    if (opts.comment !== undefined) params.push(['comment', opts.comment]);
    if (opts.public !== undefined) params.push(['public', String(opts.public)]);
    for (const id of opts.songIdToAdd ?? []) params.push(['songIdToAdd', id]);
    for (const idx of opts.songIndexToRemove ?? []) params.push(['songIndexToRemove', String(idx)]);
    await this.call('updatePlaylist', params);
  }

  public async deletePlaylist(playlistId: string): Promise<void> {
    await this.call('deletePlaylist', [['id', playlistId]]);
  }

  public async startScan(fullScan = false): Promise<SubsonicScanStatus> {
    const res = await this.call<{ scanStatus: SubsonicScanStatus }>('startScan', [
      ['fullScan', String(fullScan)],
    ]);
    return res.scanStatus;
  }

  public async getScanStatus(): Promise<SubsonicScanStatus> {
    const res = await this.call<{ scanStatus: SubsonicScanStatus }>('getScanStatus');
    return res.scanStatus;
  }

  public async getAlbumList2(type: 'newest' | 'recent' | 'frequent', size = 20) {
    const res = await this.call<{ albumList2?: { album?: Array<Record<string, unknown>> } }>(
      'getAlbumList2',
      [
        ['type', type],
        ['size', String(size)],
      ],
    );
    return res.albumList2?.album ?? [];
  }

  public async getNowPlaying() {
    const res = await this.call<{ nowPlaying?: { entry?: Array<Record<string, unknown>> } }>(
      'getNowPlaying',
    );
    return res.nowPlaying?.entry ?? [];
  }

  public async getArtists() {
    const res = await this.call<{
      artists?: { index?: Array<{ artist?: Array<Record<string, unknown>> }> };
    }>('getArtists');
    return (res.artists?.index ?? []).flatMap((i) => i.artist ?? []);
  }

  public async getSong(id: string): Promise<SubsonicSong> {
    const res = await this.call<{ song: SubsonicSong }>('getSong', [['id', id]]);
    return res.song;
  }
}
