import { HomemcpError } from '@homemcp/core';
import { fetchJson } from './http.js';

export interface CloudflareIngressRule {
  hostname?: string | undefined;
  service: string;
  path?: string | undefined;
  originRequest?: Record<string, unknown> | undefined;
}

export interface CloudflareTunnelConfig {
  version: number;
  config: {
    ingress: CloudflareIngressRule[];
    'warp-routing'?: { enabled?: boolean } | undefined;
  };
}

export interface CloudflareDnsRecord {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
}

export interface CloudflareAccessApp {
  id: string;
  name: string;
  domain: string;
  type: string;
}

export interface CloudflareConnector {
  getTunnelStatus(): Promise<{
    id: string;
    name: string;
    status: string;
    connections: Array<{ id: string; origin_ip: string; client_version: string; opened_at: string }>;
  }>;
  getTunnelConfig(): Promise<CloudflareTunnelConfig>;
  listDnsRecords(): Promise<CloudflareDnsRecord[]>;
  listAccessApps(): Promise<CloudflareAccessApp[]>;
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

export class HttpCloudflareConnector implements CloudflareConnector {
  private readonly accountId: string;
  private readonly tunnelId: string;
  private readonly apiToken: string;
  private readonly zones: readonly string[];
  private readonly baseUrl = 'https://api.cloudflare.com/client/v4';

  public constructor(opts: {
    accountId: string;
    tunnelId: string;
    apiToken: string;
    zones: readonly string[];
  }) {
    this.accountId = opts.accountId;
    this.tunnelId = opts.tunnelId;
    this.apiToken = opts.apiToken;
    this.zones = opts.zones;
  }

  private async cfGet<T>(apiPath: string): Promise<T> {
    const env = await fetchJson<CfEnvelope<T>>(`${this.baseUrl}${apiPath}`, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
      serviceName: 'cloudflare',
    });
    if (!env.success) {
      throw new HomemcpError(
        'UPSTREAM_UNAVAILABLE',
        `Cloudflare API error: ${env.errors?.map((e) => e.message).join('; ') || 'unknown'}`,
      );
    }
    return env.result;
  }

  public async getTunnelStatus() {
    const tunnel = await this.cfGet<{
      id: string;
      name: string;
      status: string;
      connections?: Array<{
        id?: string;
        origin_ip?: string;
        client_version?: string;
        opened_at?: string;
      }>;
    }>(`/accounts/${this.accountId}/cfd_tunnel/${this.tunnelId}`);

    return {
      id: tunnel.id,
      name: tunnel.name,
      status: tunnel.status,
      connections: (tunnel.connections ?? []).map((c) => ({
        id: c.id ?? '',
        origin_ip: c.origin_ip ?? '',
        client_version: c.client_version ?? '',
        opened_at: c.opened_at ?? '',
      })),
    };
  }

  public async getTunnelConfig(): Promise<CloudflareTunnelConfig> {
    return this.cfGet<CloudflareTunnelConfig>(
      `/accounts/${this.accountId}/cfd_tunnel/${this.tunnelId}/configurations`,
    );
  }

  public async listDnsRecords(): Promise<CloudflareDnsRecord[]> {
    const out: CloudflareDnsRecord[] = [];
    for (const zoneName of this.zones) {
      const zones = await this.cfGet<Array<{ id: string; name: string }>>(
        `/zones?name=${encodeURIComponent(zoneName)}`,
      );
      const zone = zones[0];
      if (!zone) continue;
      const recs = await this.cfGet<
        Array<{
          id: string;
          name: string;
          type: string;
          content: string;
          proxied?: boolean;
        }>
      >(`/zones/${zone.id}/dns_records?per_page=100`);
      for (const r of recs) {
        out.push({
          id: r.id,
          zone_id: zone.id,
          zone_name: zone.name,
          name: r.name,
          type: r.type,
          content: r.content,
          proxied: Boolean(r.proxied),
        });
      }
    }
    return out;
  }

  public async listAccessApps(): Promise<CloudflareAccessApp[]> {
    const apps = await this.cfGet<
      Array<{ id: string; name?: string; domain?: string; type?: string }>
    >(`/accounts/${this.accountId}/access/apps?per_page=100`);
    return apps.map((a) => ({
      id: a.id,
      name: a.name ?? '',
      domain: a.domain ?? '',
      type: a.type ?? 'self_hosted',
    }));
  }
}
