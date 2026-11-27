import { HomemcpError } from '@homemcp/core';
import { fetchWithTimeout } from './http.js';

export interface JackettIndexer {
  id: string;
  title: string;
  categories: string[];
}

export interface JackettSearchResult {
  title: string;
  indexer_id: string;
  indexer: string;
  size_bytes: number;
  seeders: number;
  leechers: number;
  category: string;
  published_at: string | null;
  info_hash: string | null;
  magnet_uri: string | null;
  download_link: string | null;
}

export interface JackettIndexerRunStat {
  id: string;
  name: string;
  status: 'ok' | 'timeout' | 'error';
  results_count: number;
  elapsed_ms: number;
  error?: string | undefined;
}

export type JackettResolvedDownload =
  { kind: 'magnet'; magnetUri: string } | { kind: 'torrent'; filename: string; data: Uint8Array };

export interface JackettConnector {
  listIndexers(): Promise<JackettIndexer[]>;
  search(opts: {
    query: string;
    indexers?: readonly string[] | undefined;
    excludeIndexers?: readonly string[] | undefined;
    categories?: readonly number[] | undefined;
    timeoutMs?: number | undefined;
  }): Promise<{ results: JackettSearchResult[]; indexers: JackettIndexerRunStat[] }>;
  resolveDownload(downloadLink: string): Promise<JackettResolvedDownload>;
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function parseTorznabIndexersXml(xml: string): JackettIndexer[] {
  const indexers: JackettIndexer[] = [];
  const blockRe = /<indexer\s+[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/indexer>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const id = decodeXmlEntities(m[1] ?? '').trim();
    const body = m[2] ?? '';
    if (!id) continue;
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
    const title = decodeXmlEntities(titleMatch?.[1] ?? id).trim() || id;
    const cats = new Set<string>();
    const catRe = /<category\s+[^>]*id=["'](\d+)["']/gi;
    let cm: RegExpExecArray | null;
    while ((cm = catRe.exec(body)) !== null) {
      if (cm[1]) cats.add(cm[1]);
    }
    indexers.push({ id, title, categories: [...cats] });
  }
  return indexers;
}

interface RawJackettResult {
  Title?: unknown;
  Tracker?: unknown;
  TrackerId?: unknown;
  Size?: unknown;
  Seeders?: unknown;
  Peers?: unknown;
  CategoryDesc?: unknown;
  PublishDate?: unknown;
  InfoHash?: unknown;
  MagnetUri?: unknown;
  Link?: unknown;
}

interface RawJackettIndexerInfo {
  ID?: unknown;
  Name?: unknown;
  Error?: unknown;
}

function normalizeResult(
  raw: RawJackettResult,
  fallbackId: string,
  fallbackName: string,
): JackettSearchResult | null {
  const title = typeof raw.Title === 'string' ? raw.Title.trim() : '';
  if (!title) return null;
  const indexerId =
    typeof raw.TrackerId === 'string' && raw.TrackerId.trim() ? raw.TrackerId.trim() : fallbackId;
  const indexer =
    typeof raw.Tracker === 'string' && raw.Tracker.trim() ? raw.Tracker.trim() : fallbackName;
  const sizeBytes = typeof raw.Size === 'number' && Number.isFinite(raw.Size) ? raw.Size : 0;
  const seeders =
    typeof raw.Seeders === 'number' && Number.isFinite(raw.Seeders) ? Math.max(0, raw.Seeders) : 0;
  const peers =
    typeof raw.Peers === 'number' && Number.isFinite(raw.Peers) ? Math.max(0, raw.Peers) : 0;
  const category = typeof raw.CategoryDesc === 'string' ? raw.CategoryDesc.trim() : '';
  const publishedAt =
    typeof raw.PublishDate === 'string' && raw.PublishDate.trim() ? raw.PublishDate.trim() : null;
  const infoHash =
    typeof raw.InfoHash === 'string' && raw.InfoHash.trim()
      ? raw.InfoHash.trim().toLowerCase()
      : null;
  const magnetUri =
    typeof raw.MagnetUri === 'string' && raw.MagnetUri.trim().startsWith('magnet:')
      ? raw.MagnetUri.trim()
      : null;
  const downloadLink = typeof raw.Link === 'string' && raw.Link.trim() ? raw.Link.trim() : null;

  return {
    title,
    indexer_id: indexerId,
    indexer,
    size_bytes: sizeBytes,
    seeders,
    leechers: peers,
    category,
    published_at: publishedAt,
    info_hash: infoHash,
    magnet_uri: magnetUri,
    download_link: downloadLink,
  };
}

export class HttpJackettConnector implements JackettConnector {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultExclude: Set<string>;

  public constructor(opts: {
    url: string;
    apiKey: string;
    defaultTimeoutSeconds?: number | undefined;
    excludeIndexers?: readonly string[] | undefined;
  }) {
    this.baseUrl = opts.url.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.defaultTimeoutMs = Math.min(
      Math.max((opts.defaultTimeoutSeconds ?? 55) * 1000, 5_000),
      120_000,
    );
    this.defaultExclude = new Set((opts.excludeIndexers ?? []).map((x) => x.trim().toLowerCase()));
  }

  public async listIndexers(): Promise<JackettIndexer[]> {
    const qs = new URLSearchParams({
      t: 'indexers',
      configured: 'true',
      apikey: this.apiKey,
    });
    const resp = await fetchWithTimeout(
      `${this.baseUrl}/api/v2.0/indexers/all/results/torznab/api?${qs.toString()}`,
      { timeoutMs: 15_000, serviceName: 'jackett' },
    );
    if (resp.status === 401 || resp.status === 403) {
      throw new HomemcpError('UPSTREAM_AUTH', `jackett rejected API key (${resp.status})`);
    }
    if (!resp.ok) {
      throw new HomemcpError('UPSTREAM_UNAVAILABLE', `jackett returned HTTP ${resp.status}`);
    }
    const xml = await resp.text();
    return parseTorznabIndexersXml(xml);
  }

  public async search(opts: {
    query: string;
    indexers?: readonly string[] | undefined;
    excludeIndexers?: readonly string[] | undefined;
    categories?: readonly number[] | undefined;
    timeoutMs?: number | undefined;
  }): Promise<{ results: JackettSearchResult[]; indexers: JackettIndexerRunStat[] }> {
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? this.defaultTimeoutMs, 1_000), 120_000);
    const excludeSet = new Set(this.defaultExclude);
    for (const ex of opts.excludeIndexers ?? []) {
      excludeSet.add(ex.trim().toLowerCase());
    }

    let targets: Array<{ id: string; title: string }>;
    if (opts.indexers && opts.indexers.length > 0) {
      targets = opts.indexers
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => ({ id, title: id }));
    } else {
      const configured = await this.listIndexers();
      targets = configured
        .filter((i) => !excludeSet.has(i.id.toLowerCase()))
        .map((i) => ({ id: i.id, title: i.title }));
    }

    const dedup = new Map<string, JackettSearchResult>();
    const unkeyed: JackettSearchResult[] = [];

    const stats = await Promise.all(
      targets.map(async (target): Promise<JackettIndexerRunStat> => {
        const started = Date.now();
        const qs = new URLSearchParams({
          apikey: this.apiKey,
          Query: opts.query,
        });
        for (const cat of opts.categories ?? []) {
          qs.append('Category[]', String(cat));
        }
        const url = `${this.baseUrl}/api/v2.0/indexers/${encodeURIComponent(target.id)}/results?${qs.toString()}`;
        try {
          const resp = await fetchWithTimeout(url, {
            timeoutMs,
            serviceName: `jackett:${target.id}`,
          });
          if (resp.status === 401 || resp.status === 403) {
            throw new HomemcpError('UPSTREAM_AUTH', `jackett rejected API key (${resp.status})`);
          }
          if (!resp.ok) {
            throw new HomemcpError('UPSTREAM_UNAVAILABLE', `HTTP ${resp.status}`);
          }
          const payload = (await resp.json()) as {
            Results?: RawJackettResult[];
            Indexers?: RawJackettIndexerInfo[];
          };
          const meta = payload.Indexers?.[0];
          const displayName =
            typeof meta?.Name === 'string' && meta.Name.trim() ? meta.Name.trim() : target.title;
          const idxError =
            typeof meta?.Error === 'string' && meta.Error.trim() ? meta.Error : undefined;

          const items = Array.isArray(payload.Results) ? payload.Results : [];
          let count = 0;
          for (const raw of items) {
            const norm = normalizeResult(raw, target.id, displayName);
            if (!norm) continue;
            count++;
            if (norm.info_hash) {
              const existing = dedup.get(norm.info_hash);
              if (
                !existing ||
                norm.seeders > existing.seeders ||
                (norm.seeders === existing.seeders &&
                  Boolean(norm.magnet_uri) &&
                  !existing.magnet_uri)
              ) {
                dedup.set(norm.info_hash, norm);
              }
            } else {
              unkeyed.push(norm);
            }
          }
          return {
            id: target.id,
            name: displayName,
            status: idxError && count === 0 ? 'error' : 'ok',
            results_count: count,
            elapsed_ms: Date.now() - started,
            ...(idxError ? { error: idxError } : {}),
          };
        } catch (err) {
          const elapsed = Date.now() - started;
          const isTimeout = err instanceof HomemcpError && err.code === 'TIMEOUT';
          const msg = err instanceof Error ? err.message : 'Indexer request failed';
          return {
            id: target.id,
            name: target.title,
            status: isTimeout ? 'timeout' : 'error',
            results_count: 0,
            elapsed_ms: elapsed,
            error: msg,
          };
        }
      }),
    );

    return {
      results: [...dedup.values(), ...unkeyed],
      indexers: stats,
    };
  }

  public async resolveDownload(downloadLink: string): Promise<JackettResolvedDownload> {
    let parsed: URL;
    let base: URL;
    try {
      parsed = new URL(downloadLink);
      base = new URL(this.baseUrl);
    } catch {
      throw new HomemcpError('INVALID_ARGUMENT', 'Invalid Jackett download link');
    }
    if (parsed.origin !== base.origin) {
      throw new HomemcpError('POLICY_DENIED', 'Refusing off-origin Jackett download link');
    }

    let resp: Response;
    try {
      resp = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HomemcpError('TIMEOUT', 'jackett download resolution timed out after 20000ms');
      }
      throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'jackett download link unreachable');
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')?.trim() ?? '';
      if (loc.startsWith('magnet:')) {
        return { kind: 'magnet', magnetUri: loc };
      }
      throw new HomemcpError('POLICY_DENIED', 'Jackett redirect target is not a magnet URI');
    }

    if (!resp.ok) {
      throw new HomemcpError(
        'UPSTREAM_UNAVAILABLE',
        `Jackett download failed (HTTP ${resp.status})`,
      );
    }

    const buf = await resp.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > 10 * 1024 * 1024) {
      throw new HomemcpError(
        'UPSTREAM_UNAVAILABLE',
        `Jackett .torrent payload size out of bounds (${buf.byteLength} bytes)`,
      );
    }

    const disp = resp.headers.get('content-disposition') ?? '';
    const fnMatch = /filename\*?=(?:UTF-8''|"?)([^";\r\n"]+)/i.exec(disp);
    const rawName = fnMatch?.[1]?.trim() ?? 'download.torrent';
    const cleanName = rawName.replace(/[^A-Za-z0-9._-]/g, '_') || 'download.torrent';
    const filename = cleanName.endsWith('.torrent') ? cleanName : `${cleanName}.torrent`;

    return {
      kind: 'torrent',
      filename,
      data: new Uint8Array(buf),
    };
  }
}
