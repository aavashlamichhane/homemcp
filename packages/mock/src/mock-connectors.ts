import {
  assertSafeTunnelIngress,
  type CloudflareAccessApp,
  type CloudflareConnector,
  type CloudflareDnsRecord,
  type CloudflareTunnelConfig,
  type CreateNpmProxyHostInput,
  type DockerConnector,
  type HealthchecksConnector,
  type HttpProbeConnector,
  type HttpProbeResult,
  type JellyfinConnector,
  type NaviloadConnector,
  type NpmConnector,
  type NpmProxyHost,
  type NtfyConnector,
  type NtfyMessage,
  type QbittorrentConnector,
  type RegistryConnector,
  type SubsonicConnector,
  type SubsonicPlaylist,
  type SubsonicScanStatus,
  type SubsonicSong,
  type VaultwardenConnector,
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
        RepoDigests: [
          `${c.Image.split(':')[0]}@sha256:${c.ImageID.replace('sha256:', '').padEnd(64, '0')}`,
        ],
        Size: 150_000_000,
      })),
    );
  }

  public getEvents() {
    return Promise.resolve([
      {
        Type: 'container',
        Action: 'health_status: healthy',
        Actor: { Attributes: { name: 'navidrome' } },
        time: Math.floor(Date.now() / 1000) - 120,
      },
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

  public createProxyHost(input: CreateNpmProxyHostInput): Promise<NpmProxyHost> {
    const id = this.state.npmHosts.reduce((m, h) => Math.max(m, h.id), 0) + 1;
    const host: NpmProxyHost = {
      id,
      domain_names: input.domain_names,
      forward_scheme: input.forward_scheme ?? 'http',
      forward_host: input.forward_host,
      forward_port: input.forward_port,
      certificate_id: input.certificate_id ?? 2,
      access_list_id: input.access_list_id ?? 0,
      ssl_forced: input.ssl_forced ?? true,
      block_exploits: input.block_exploits ?? true,
      allow_websocket_upgrade: input.allow_websocket_upgrade ?? true,
      caching_enabled: input.caching_enabled ?? false,
      enabled: input.enabled ?? true,
      certificate: { id: 2, nice_name: '*.example.com', expires_on: '2027-02-01T00:00:00Z' },
    };
    this.state.npmHosts.push(host);
    return Promise.resolve(host);
  }

  public updateProxyHost(
    id: number,
    input: Partial<CreateNpmProxyHostInput>,
  ): Promise<NpmProxyHost> {
    const host = this.state.npmHosts.find((h) => h.id === id);
    if (!host) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `NPM proxy host ${id} not found`));
    }
    Object.assign(host, input);
    return Promise.resolve(host);
  }

  public deleteProxyHost(id: number): Promise<void> {
    this.state.npmHosts = this.state.npmHosts.filter((h) => h.id !== id);
    return Promise.resolve();
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

  public updateTunnelIngress(
    mutateFn: (current: CloudflareTunnelConfig['config']) => CloudflareTunnelConfig['config'],
  ): Promise<{ previous: CloudflareTunnelConfig; current: CloudflareTunnelConfig }> {
    const previous = structuredClone(this.state.cfTunnelConfig);
    const nextConfig = mutateFn(structuredClone(previous.config));
    assertSafeTunnelIngress(previous.config, nextConfig);
    const next: CloudflareTunnelConfig = {
      version: previous.version + 1,
      config: nextConfig,
    };
    this.state.cfTunnelConfig = next;
    return Promise.resolve({ previous, current: next });
  }

  public upsertDnsCname(zoneName: string, hostname: string): Promise<CloudflareDnsRecord> {
    if (this.state.failNextCfDns) {
      this.state.failNextCfDns = false;
      return Promise.reject(
        new HomemcpError('UPSTREAM_UNAVAILABLE', 'Simulated Cloudflare DNS failure'),
      );
    }
    const existing = this.state.cfDnsRecords.find((r) => r.name === hostname);
    if (existing) {
      existing.content = 'tun-mock.cfargotunnel.com';
      return Promise.resolve(existing);
    }
    const created: CloudflareDnsRecord = {
      id: `dns-${this.state.cfDnsRecords.length + 1}`,
      zone_id: 'z1',
      zone_name: zoneName,
      name: hostname,
      type: 'CNAME',
      content: 'tun-mock.cfargotunnel.com',
      proxied: true,
    };
    this.state.cfDnsRecords.push(created);
    return Promise.resolve(created);
  }

  public deleteDnsCname(_zoneId: string, recordId: string): Promise<void> {
    const rec = this.state.cfDnsRecords.find((r) => r.id === recordId);
    if (!rec) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `DNS record not found: ${recordId}`));
    }
    if (rec.type !== 'CNAME' || rec.content !== 'tun-mock.cfargotunnel.com') {
      return Promise.reject(
        new HomemcpError('POLICY_DENIED', 'DNS record target does not match tunnel'),
      );
    }
    this.state.cfDnsRecords = this.state.cfDnsRecords.filter((r) => r.id !== recordId);
    return Promise.resolve();
  }

  public upsertAccessApp(opts: { name: string; domain: string }): Promise<CloudflareAccessApp> {
    const existing = this.state.cfAccessApps.find((a) => a.domain === opts.domain);
    if (existing) {
      existing.name = opts.name;
      return Promise.resolve(existing);
    }
    const created: CloudflareAccessApp = {
      id: `app-${this.state.cfAccessApps.length + 1}`,
      name: opts.name,
      domain: opts.domain,
      type: 'self_hosted',
    };
    this.state.cfAccessApps.push(created);
    return Promise.resolve(created);
  }

  public deleteAccessApp(appId: string): Promise<void> {
    this.state.cfAccessApps = this.state.cfAccessApps.filter((a) => a.id !== appId);
    return Promise.resolve();
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

export class MockSubsonicConnector implements SubsonicConnector {
  private scanCount = 0;

  public constructor(private readonly state: MockState) {}

  public ping() {
    return Promise.resolve(true);
  }

  public search3(
    query: string,
    opts?: {
      songCount?: number | undefined;
      albumCount?: number | undefined;
      artistCount?: number | undefined;
    },
  ) {
    const q = query.trim().toLowerCase();
    const songs = this.state.musicSongs
      .filter(
        (s) =>
          !q ||
          s.title.toLowerCase().includes(q) ||
          s.artist.toLowerCase().includes(q) ||
          (s.album ?? '').toLowerCase().includes(q),
      )
      .slice(0, opts?.songCount ?? 20);
    return Promise.resolve({ artists: [], albums: [], songs });
  }

  public getPlaylists(): Promise<SubsonicPlaylist[]> {
    return Promise.resolve(this.state.musicPlaylists.map((p) => ({ ...p })));
  }

  public getPlaylist(id: string): Promise<SubsonicPlaylist> {
    const pl = this.state.musicPlaylists.find((p) => p.id === id);
    if (!pl) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Playlist not found: ${id}`));
    }
    return Promise.resolve({ ...pl, entry: [...(pl.entry ?? [])] });
  }

  public createPlaylist(name: string, songIds: readonly string[] = []): Promise<SubsonicPlaylist> {
    const entries = songIds
      .map((id) => this.state.musicSongs.find((s) => s.id === id))
      .filter((s): s is SubsonicSong => Boolean(s));
    const pl: SubsonicPlaylist = {
      id: `pl-${this.state.musicPlaylists.length + 1}`,
      name,
      public: false,
      songCount: entries.length,
      duration: entries.reduce((acc, s) => acc + (s.duration ?? 200), 0),
      changed: new Date().toISOString(),
      entry: entries,
    };
    this.state.musicPlaylists.push(pl);
    return Promise.resolve(pl);
  }

  public updatePlaylist(opts: {
    playlistId: string;
    name?: string | undefined;
    comment?: string | undefined;
    public?: boolean | undefined;
    songIdToAdd?: readonly string[] | undefined;
    songIndexToRemove?: readonly number[] | undefined;
  }): Promise<void> {
    const pl = this.state.musicPlaylists.find((p) => p.id === opts.playlistId);
    if (!pl) {
      return Promise.reject(
        new HomemcpError('NOT_FOUND', `Playlist not found: ${opts.playlistId}`),
      );
    }
    if (opts.name !== undefined) pl.name = opts.name;
    if (opts.comment !== undefined) pl.comment = opts.comment;
    if (opts.public !== undefined) pl.public = opts.public;
    const entries = [...(pl.entry ?? [])];
    if (opts.songIndexToRemove && opts.songIndexToRemove.length > 0) {
      const toRemove = new Set(opts.songIndexToRemove);
      const filtered = entries.filter((_, idx) => !toRemove.has(idx));
      entries.splice(0, entries.length, ...filtered);
    }
    for (const id of opts.songIdToAdd ?? []) {
      const found = this.state.musicSongs.find((s) => s.id === id);
      if (found && !entries.some((e) => e.id === found.id)) {
        entries.push(found);
      }
    }
    pl.entry = entries;
    pl.songCount = entries.length;
    pl.duration = entries.reduce((acc, s) => acc + (s.duration ?? 200), 0);
    pl.changed = new Date().toISOString();
    return Promise.resolve();
  }

  public deletePlaylist(playlistId: string): Promise<void> {
    const idx = this.state.musicPlaylists.findIndex((p) => p.id === playlistId);
    if (idx < 0) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Playlist not found: ${playlistId}`));
    }
    this.state.musicPlaylists.splice(idx, 1);
    return Promise.resolve();
  }

  public startScan(): Promise<SubsonicScanStatus> {
    // Promote any newly saved NaviLoad tracks into the Navidrome library
    for (const trk of this.state.naviloadTracks) {
      if (
        trk.status === 'saved' &&
        !this.state.musicSongs.some((s) => trk.video_id && s.path?.includes(trk.video_id))
      ) {
        this.state.musicSongs.push({
          id: `song-${this.state.musicSongs.length + 1}`,
          title: trk.title,
          artist: trk.artist ?? 'Unknown Artist',
          album: trk.album ?? 'Singles',
          duration: 230,
          path: trk.saved_relpath
            ? `/mnt/storage/media/music/${trk.saved_relpath}`
            : `/mnt/storage/media/music/${trk.title} [${trk.video_id ?? '00000000000'}].m4a`,
        });
      }
    }
    this.scanCount++;
    return Promise.resolve({
      scanning: false,
      count: this.state.musicSongs.length,
      folderCount: 1,
      lastScan: Date.now(),
    });
  }

  public getScanStatus(): Promise<SubsonicScanStatus> {
    return Promise.resolve({
      scanning: false,
      count: this.state.musicSongs.length + this.scanCount * 0,
      folderCount: 1,
      lastScan: Date.now(),
    });
  }

  public getAlbumList2(_type: 'newest' | 'recent' | 'frequent', size = 20) {
    return Promise.resolve(
      this.state.musicSongs.slice(0, size).map((s) => ({
        id: s.id,
        name: s.album ?? s.title,
        artist: s.artist,
        songCount: 1,
      })),
    );
  }

  public getNowPlaying() {
    return Promise.resolve([
      {
        id: this.state.musicSongs[0]?.id ?? 'song-1',
        title: 'Halo',
        artist: 'Beyoncé',
        username: 'owner',
      },
    ]);
  }

  public getArtists() {
    const byArtist = new Map<string, number>();
    for (const s of this.state.musicSongs) {
      byArtist.set(s.artist, (byArtist.get(s.artist) ?? 0) + 1);
    }
    return Promise.resolve(
      [...byArtist.entries()].map(([name, albumCount], idx) => ({
        id: `art-${idx + 1}`,
        name,
        albumCount,
      })),
    );
  }

  public getSong(id: string): Promise<SubsonicSong> {
    const song = this.state.musicSongs.find((s) => s.id === id);
    if (!song) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Song not found: ${id}`));
    }
    return Promise.resolve(song);
  }
}

export class MockNaviloadConnector implements NaviloadConnector {
  public constructor(private readonly state: MockState) {}

  public health() {
    const pendingReview = this.state.naviloadTracks.filter(
      (t) => t.status === 'pending_review',
    ).length;
    const failed = this.state.naviloadTracks.filter((t) => t.status === 'failed').length;
    return Promise.resolve({
      status: 'ok',
      version: '2.0.0',
      yt_dlp_version: '2026.11.01',
      cookies_present: true,
      queue_depth: this.state.naviloadTracks.length,
      pending_review: pendingReview,
      failed,
    });
  }

  public searchYoutube(query: string, limit = 5) {
    const specific = this.state.naviloadCandidates[query];
    if (specific) {
      return Promise.resolve(specific.slice(0, limit));
    }
    const qClean = query.trim();
    const vid = qClean
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 11)
      .padEnd(11, 'X');
    const defaults = [
      {
        video_id: vid,
        url: `https://www.youtube.com/watch?v=${vid}`,
        title: qClean,
        channel: `${qClean.split(' ')[0] ?? 'Artist'} - Topic`,
        duration_seconds: 215,
        view_count: 1_200_000,
        is_topic_channel: true,
        already_in_library: this.state.musicSongs.some((s) =>
          s.title.toLowerCase().includes(qClean.toLowerCase()),
        ),
        already_in_queue: this.state.naviloadTracks.some((t) => t.video_id === vid),
      },
      ...(this.state.naviloadCandidates['default'] ?? []),
    ];
    return Promise.resolve(defaults.slice(0, limit));
  }

  public inspectUrl(url: string) {
    const match = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url);
    const vid = match?.[1] ?? 'inspectVid01';
    const inLib = this.state.musicSongs.some((s) => s.path?.includes(`[${vid}]`));
    return Promise.resolve({
      url,
      video_id: vid,
      title: 'Inspected Track',
      artist: 'Inspected Artist',
      duration_seconds: 205,
      already_in_library: inLib,
    });
  }

  public downloadTracks(opts: { urls: readonly string[]; quality?: string | undefined }) {
    const items: Array<Record<string, unknown>> = [];
    for (const url of opts.urls) {
      const match = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url);
      const videoId =
        match?.[1] ?? `vid${this.state.naviloadTracks.length + 1}`.padEnd(11, '0').slice(0, 11);
      const id = `trk-${this.state.naviloadTracks.length + 1}`;
      const cand = Object.values(this.state.naviloadCandidates)
        .flat()
        .find((c) => c.video_id === videoId);
      const trk = {
        id,
        video_id: videoId,
        url,
        title: cand?.title ?? `Track ${videoId}`,
        artist: cand?.channel.replace(/\s*-\s*Topic$/i, '') ?? 'Unknown Artist',
        album: 'Singles',
        status: 'pending_review',
        suggestions: [
          {
            source: 'musicbrainz',
            title: cand?.title ?? `Track ${videoId}`,
            artist: cand?.channel.replace(/\s*-\s*Topic$/i, '') ?? 'Unknown Artist',
            album: 'Studio Album',
            score: 0.96,
          },
        ],
      };
      this.state.naviloadTracks.push(trk);
      items.push({ id: trk.id, video_id: trk.video_id, status: trk.status });
    }
    return Promise.resolve({
      job_id: `nl-job-${Date.now()}`,
      queued: items.length,
      items,
    });
  }

  public getStatus() {
    return Promise.resolve({
      tracks: this.state.naviloadTracks.map((t) => ({ ...t })),
      queue_depth: this.state.naviloadTracks.filter(
        (t) => t.status !== 'saved' && t.status !== 'cancelled',
      ).length,
    });
  }

  public getLibrary() {
    return Promise.resolve(
      this.state.musicSongs.map((s) => ({
        id: s.id,
        title: s.title,
        artist: s.artist,
        path: s.path,
      })),
    );
  }

  public reviewTrack(opts: {
    trackId: string;
    policy: 'keep_youtube' | 'suggestion' | 'manual';
    suggestionIndex?: number | undefined;
    manualTags?: { title?: string; artist?: string; album?: string } | undefined;
    artworkPolicy?: 'db_then_youtube' | 'youtube' | undefined;
  }) {
    const trk = this.state.naviloadTracks.find((t) => t.id === opts.trackId);
    if (!trk) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Track not found: ${opts.trackId}`));
    }
    if (opts.policy === 'suggestion') {
      const sug = trk.suggestions?.[opts.suggestionIndex ?? 0];
      if (!sug) {
        return Promise.reject(
          new HomemcpError('INVALID_ARGUMENT', 'Requested suggestion index not found'),
        );
      }
      if (typeof sug['title'] === 'string') trk.title = sug['title'];
      if (typeof sug['artist'] === 'string') trk.artist = sug['artist'];
      if (typeof sug['album'] === 'string') trk.album = sug['album'];
    } else if (opts.policy === 'manual' && opts.manualTags) {
      if (opts.manualTags.title) trk.title = opts.manualTags.title;
      if (opts.manualTags.artist) trk.artist = opts.manualTags.artist;
      if (opts.manualTags.album) trk.album = opts.manualTags.album;
    }
    trk.status = 'reviewed';
    return Promise.resolve({
      ok: true,
      track: { ...trk },
      artwork_policy: opts.artworkPolicy ?? 'db_then_youtube',
    });
  }

  public confirmTrack(trackId: string) {
    const trk = this.state.naviloadTracks.find((t) => t.id === trackId);
    if (!trk) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Track not found: ${trackId}`));
    }
    const vid = trk.video_id ?? 'unknownvid1';
    const filename = `${trk.title} [${vid}].m4a`;
    trk.status = 'saved';
    trk.saved_filename = filename;
    trk.saved_relpath = `${trk.artist ?? 'Unknown Artist'}/${filename}`;
    return Promise.resolve({ ok: true, track: { ...trk } });
  }

  public cancelTrack(trackId: string) {
    const trk = this.state.naviloadTracks.find((t) => t.id === trackId);
    if (!trk) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Track not found: ${trackId}`));
    }
    trk.status = 'cancelled';
    return Promise.resolve({ ok: true, track_id: trackId, status: 'cancelled' });
  }

  public retryTrack(trackId: string) {
    const trk = this.state.naviloadTracks.find((t) => t.id === trackId);
    if (!trk) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Track not found: ${trackId}`));
    }
    trk.status = 'queued';
    return Promise.resolve({ ok: true, track_id: trackId, status: 'queued' });
  }
}

export class MockJellyfinConnector implements JellyfinConnector {
  public constructor(private readonly state: MockState) {}

  public getHealth() {
    return Promise.resolve({ ok: true, status_code: 200 });
  }

  public getSystemInfo() {
    return Promise.resolve({
      ServerName: 'homelab-01-jellyfin',
      Version: '10.11.8',
      Id: 'jf-mock-1',
      OperatingSystem: 'Linux',
      HasPendingRestart: false,
    });
  }

  public getSessions() {
    return Promise.resolve([...this.state.jellyfinSessions]);
  }

  public getLibraries() {
    return Promise.resolve([...this.state.jellyfinLibraries]);
  }

  public searchItems(opts: {
    searchTerm?: string | undefined;
    includeItemTypes?: string | undefined;
    limit?: number | undefined;
  }) {
    const q = (opts.searchTerm ?? '').toLowerCase();
    const filtered = this.state.jellyfinItems.filter((item) => {
      if (q && !item.Name.toLowerCase().includes(q)) return false;
      if (opts.includeItemTypes && !opts.includeItemTypes.split(',').includes(item.Type))
        return false;
      return true;
    });
    return Promise.resolve({
      Items: filtered.slice(0, opts.limit ?? 50),
      TotalRecordCount: filtered.length,
    });
  }

  public getScheduledTasks() {
    return Promise.resolve([...this.state.jellyfinTasks]);
  }

  public runScheduledTask(taskId: string): Promise<void> {
    const task = this.state.jellyfinTasks.find((t) => t.Id === taskId);
    if (!task) {
      return Promise.reject(new HomemcpError('NOT_FOUND', `Jellyfin task not found: ${taskId}`));
    }
    task.LastExecutionResult = {
      StartTimeUtc: new Date().toISOString(),
      EndTimeUtc: new Date().toISOString(),
      Status: 'Completed',
    };
    return Promise.resolve();
  }

  public getActivityLog(limit = 50) {
    return Promise.resolve(this.state.jellyfinActivity.slice(0, limit));
  }

  public getUsers() {
    return Promise.resolve([{ Id: 'u1', Name: 'owner', Policy: { IsAdministrator: true } }]);
  }
}

export class MockQbittorrentConnector implements QbittorrentConnector {
  public constructor(private readonly state: MockState) {}

  public getTransferInfo() {
    return Promise.resolve({
      dl_info_speed: 2_400_000,
      up_info_speed: 512_000,
      dl_info_data: 10_000_000_000,
      up_info_data: 15_000_000_000,
      connection_status: 'connected',
    });
  }

  public listTorrents(filter?: string) {
    const list = this.state.qbitTorrents.filter((t) => {
      if (!filter || filter === 'all') return true;
      if (filter === 'active') return t.dlspeed > 0 || t.upspeed > 0;
      if (filter === 'stalled') return t.state.includes('stalled');
      return t.state === filter;
    });
    return Promise.resolve([...list]);
  }

  public addTorrent(opts: {
    urls: readonly string[];
    category?: string | undefined;
    savepath?: string | undefined;
  }) {
    for (const url of opts.urls) {
      const hash = `mock${(this.state.qbitTorrents.length + 1).toString(16).padStart(36, '0')}`;
      this.state.qbitTorrents.push({
        hash,
        name: url.startsWith('magnet:') ? 'Magnet Download' : (url.split('/').pop() ?? 'Download'),
        size: 1_500_000_000,
        progress: 0,
        dlspeed: 0,
        upspeed: 0,
        eta: 3600,
        state: 'downloading',
        ratio: 0,
        category: opts.category ?? '',
        save_path: opts.savepath ?? '/mnt/storage/media',
      });
    }
    return Promise.resolve();
  }

  public controlTorrents(action: 'pause' | 'resume' | 'recheck', hashes: readonly string[]) {
    for (const t of this.state.qbitTorrents) {
      if (hashes.includes(t.hash)) {
        t.state =
          action === 'pause' ? 'pausedDL' : action === 'resume' ? 'downloading' : 'checkingDL';
      }
    }
    return Promise.resolve();
  }

  public deleteTorrents(hashes: readonly string[], _deleteFiles: boolean) {
    this.state.qbitTorrents = this.state.qbitTorrents.filter((t) => !hashes.includes(t.hash));
    return Promise.resolve();
  }
}

export class MockNtfyConnector implements NtfyConnector {
  public constructor(private readonly state: MockState) {}

  public send(msg: NtfyMessage): Promise<void> {
    if (!this.state.ntfyOnline) {
      return Promise.reject(
        new HomemcpError('UPSTREAM_UNAVAILABLE', 'ntfy offline (simulated outage)'),
      );
    }
    this.state.ntfySent.push(msg);
    return Promise.resolve();
  }
}

export class MockHealthchecksConnector implements HealthchecksConnector {
  public constructor(private readonly state: MockState) {}

  public ping(state: 'ok' | 'start' | 'fail' = 'ok'): Promise<boolean> {
    this.state.healthchecksPings.push(state);
    return Promise.resolve(true);
  }
}
