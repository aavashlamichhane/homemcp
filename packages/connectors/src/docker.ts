import { HomemcpError, Redactor } from '@homemcp/core';
import { fetchJson, fetchWithTimeout } from './http.js';

export interface DockerContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  Status: string;
  Created: number;
  Labels: Record<string, string>;
  Ports: Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type: string }>;
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
  };
}

export interface DockerInspectSanitized {
  Id: string;
  Name: string;
  Created: string;
  Image: string;
  ImageDigest?: string | undefined;
  State: {
    Status: string;
    Running: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Health?: {
      Status: string;
      FailingStreak: number;
      Log: Array<{ Start: string; End: string; ExitCode: number; Output: string }>;
    };
  };
  RestartCount: number;
  Config: {
    Image: string;
    EnvKeys: string[];
    Labels: Record<string, string>;
    Cmd?: string[];
  };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
  Networks: string[];
  Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  HostConfig: {
    NetworkMode: string;
    Memory: number;
    PidsLimit?: number | null;
    LogConfig?: { Type: string; Config: Record<string, string> };
  };
}

export interface DockerConnector {
  listContainers(all?: boolean): Promise<DockerContainerSummary[]>;
  inspectContainer(idOrName: string): Promise<DockerInspectSanitized>;
  getContainerLogs(
    idOrName: string,
    opts?: { tail?: number | undefined; since?: number | undefined; until?: number | undefined },
  ): Promise<string>;
  getContainerStats(idOrName: string): Promise<Record<string, unknown>>;
  listImages(): Promise<Array<Record<string, unknown>>>;
  getEvents(sinceEpochSec: number, untilEpochSec?: number): Promise<Array<Record<string, unknown>>>;
  getSystemDf(): Promise<Record<string, unknown>>;
}

function asStr(val: unknown, fallback = ''): string {
  return typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'
    ? String(val)
    : fallback;
}

function stripDockerLogMultiplexing(buf: Buffer): string {
  if (buf.length < 8) return buf.toString('utf8');
  const lines: string[] = [];
  let offset = 0;
  let looksMultiplexed = true;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset]!;
    if (
      (streamType === 1 || streamType === 2 || streamType === 0) &&
      buf[offset + 1] === 0 &&
      buf[offset + 2] === 0 &&
      buf[offset + 3] === 0
    ) {
      const size = buf.readUInt32BE(offset + 4);
      offset += 8;
      const end = Math.min(buf.length, offset + size);
      lines.push(buf.subarray(offset, end).toString('utf8'));
      offset = end;
    } else {
      looksMultiplexed = false;
      break;
    }
  }
  return looksMultiplexed ? lines.join('') : buf.toString('utf8');
}

export class HttpDockerConnector implements DockerConnector {
  private readonly baseUrl: string;
  private readonly redactor: Redactor;

  public constructor(baseUrl: string, redactor: Redactor = new Redactor()) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.redactor = redactor;
  }

  public async listContainers(all = true): Promise<DockerContainerSummary[]> {
    return fetchJson<DockerContainerSummary[]>(
      `${this.baseUrl}/containers/json?all=${all ? '1' : '0'}`,
      { serviceName: 'docker-socket-proxy' },
    );
  }

  public async inspectContainer(idOrName: string): Promise<DockerInspectSanitized> {
    const raw = await fetchJson<Record<string, unknown>>(
      `${this.baseUrl}/containers/${encodeURIComponent(idOrName)}/json`,
      { serviceName: 'docker-socket-proxy' },
    );
    const config = (raw['Config'] ?? {}) as Record<string, unknown>;
    const rawEnv = Array.isArray(config['Env']) ? config['Env'] : [];
    const envKeys = rawEnv
      .map((e) => {
        const str = asStr(e);
        const idx = str.indexOf('=');
        return idx > 0 ? str.slice(0, idx) : str;
      })
      .filter(Boolean);

    const rawCmd = Array.isArray(config['Cmd'])
      ? (this.redactor.redactValue(config['Cmd'], { highEntropyContext: true }).value as string[])
      : undefined;

    const hostConfig = (raw['HostConfig'] ?? {}) as Record<string, unknown>;
    const netSettings = (raw['NetworkSettings'] ?? {}) as Record<string, unknown>;
    const networks = Object.keys(netSettings['Networks'] ?? {});
    const mountsRaw = Array.isArray(raw['Mounts'])
      ? (raw['Mounts'] as Array<Record<string, unknown>>)
      : [];

    const stateRaw = (raw['State'] ?? {}) as Record<string, unknown>;
    const healthRaw = stateRaw['Health'] as
      | {
          Status?: string;
          FailingStreak?: number;
          Log?: Array<{ Start: string; End: string; ExitCode: number; Output: string }>;
        }
      | undefined;

    return {
      Id: asStr(raw['Id']),
      Name: asStr(raw['Name']).replace(/^\//, ''),
      Created: asStr(raw['Created']),
      Image: asStr(raw['Image']),
      State: {
        Status: asStr(stateRaw['Status']),
        Running: Boolean(stateRaw['Running']),
        Restarting: Boolean(stateRaw['Restarting']),
        OOMKilled: Boolean(stateRaw['OOMKilled']),
        ExitCode: Number(stateRaw['ExitCode'] ?? 0),
        StartedAt: asStr(stateRaw['StartedAt']),
        FinishedAt: asStr(stateRaw['FinishedAt']),
        ...(healthRaw
          ? {
              Health: {
                Status: asStr(healthRaw.Status, 'none'),
                FailingStreak: Number(healthRaw.FailingStreak ?? 0),
                Log: (healthRaw.Log ?? []).slice(-5).map((l) => ({
                  ...l,
                  Output: this.redactor.redactString(l.Output).text,
                })),
              },
            }
          : {}),
      },
      RestartCount: Number(raw['RestartCount'] ?? 0),
      Config: {
        Image: asStr(config['Image']),
        EnvKeys: envKeys,
        Labels: (config['Labels'] ?? {}) as Record<string, string>,
        ...(rawCmd ? { Cmd: rawCmd } : {}),
      },
      Mounts: mountsRaw.map((m) => ({
        Type: asStr(m['Type']),
        Source: asStr(m['Source']),
        Destination: asStr(m['Destination']),
        RW: Boolean(m['RW']),
      })),
      Networks: networks,
      Ports: (netSettings['Ports'] ?? {}) as Record<
        string,
        Array<{ HostIp: string; HostPort: string }> | null
      >,
      HostConfig: {
        NetworkMode: asStr(hostConfig['NetworkMode']),
        Memory: Number(hostConfig['Memory'] ?? 0),
        ...(hostConfig['PidsLimit'] !== undefined
          ? { PidsLimit: hostConfig['PidsLimit'] as number | null }
          : {}),
        ...(hostConfig['LogConfig']
          ? { LogConfig: hostConfig['LogConfig'] as { Type: string; Config: Record<string, string> } }
          : {}),
      },
    };
  }

  public async getContainerLogs(
    idOrName: string,
    opts?: { tail?: number | undefined; since?: number | undefined; until?: number | undefined },
  ): Promise<string> {
    const qs = new URLSearchParams({
      stdout: '1',
      stderr: '1',
      timestamps: '1',
      tail: String(opts?.tail ?? 200),
    });
    if (opts?.since !== undefined) qs.set('since', String(opts.since));
    if (opts?.until !== undefined) qs.set('until', String(opts.until));

    const resp = await fetchWithTimeout(
      `${this.baseUrl}/containers/${encodeURIComponent(idOrName)}/logs?${qs.toString()}`,
      { serviceName: 'docker-socket-proxy' },
    );
    if (resp.status === 404) {
      throw new HomemcpError('NOT_FOUND', `Container not found: ${idOrName}`);
    }
    if (!resp.ok) {
      throw new HomemcpError('UPSTREAM_UNAVAILABLE', `Docker logs returned HTTP ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const text = stripDockerLogMultiplexing(buf);
    return this.redactor.redactString(text).text;
  }

  public async getContainerStats(idOrName: string): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(
      `${this.baseUrl}/containers/${encodeURIComponent(idOrName)}/stats?stream=false`,
      { serviceName: 'docker-socket-proxy' },
    );
  }

  public async listImages(): Promise<Array<Record<string, unknown>>> {
    return fetchJson<Array<Record<string, unknown>>>(`${this.baseUrl}/images/json`, {
      serviceName: 'docker-socket-proxy',
    });
  }

  public async getEvents(
    sinceEpochSec: number,
    untilEpochSec: number = Math.floor(Date.now() / 1000),
  ): Promise<Array<Record<string, unknown>>> {
    const qs = new URLSearchParams({
      since: String(sinceEpochSec),
      until: String(untilEpochSec),
    });
    const resp = await fetchWithTimeout(`${this.baseUrl}/events?${qs.toString()}`, {
      serviceName: 'docker-socket-proxy',
    });
    if (!resp.ok) {
      throw new HomemcpError('UPSTREAM_UNAVAILABLE', `Docker events returned HTTP ${resp.status}`);
    }
    const raw = await resp.text();
    const events: Array<Record<string, unknown>> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // ignore
      }
    }
    return events;
  }

  public async getSystemDf(): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(`${this.baseUrl}/system/df`, {
      serviceName: 'docker-socket-proxy',
    });
  }
}
