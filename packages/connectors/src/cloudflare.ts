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

export function assertSafeTunnelIngress(
  prev: CloudflareTunnelConfig['config'],
  next: CloudflareTunnelConfig['config'],
): void {
  const ingress = next.ingress;
  if (!Array.isArray(ingress) || ingress.length === 0) {
    throw new HomemcpError('POLICY_DENIED', 'Cloudflare tunnel ingress cannot be empty');
  }
  const last = ingress[ingress.length - 1];
  if (!last || last.hostname || last.service !== 'http_status:404') {
    throw new HomemcpError(
      'POLICY_DENIED',
      'Cloudflare tunnel ingress last rule MUST remain catch-all service "http_status:404"',
    );
  }
  // Protected prefixes (ssh.* and homemcp.*) present in prev MUST NOT be dropped
  for (const oldRule of prev.ingress) {
    if (
      oldRule.hostname &&
      (oldRule.hostname.startsWith('ssh.') || oldRule.hostname.startsWith('homemcp.'))
    ) {
      const preserved = ingress.find(
        (r) => r.hostname === oldRule.hostname && r.service === oldRule.service,
      );
      if (!preserved) {
        throw new HomemcpError(
          'POLICY_DENIED',
          `Cannot drop or alter protected Cloudflare ingress rule for ${oldRule.hostname}`,
        );
      }
    }
  }
  if (prev['warp-routing'] && !next['warp-routing']) {
    throw new HomemcpError('POLICY_DENIED', 'Cannot drop warp-routing tunnel setting');
  }
}

export interface CloudflareConnector {
  getTunnelStatus(): Promise<{
    id: string;
    name: string;
    status: string;
    connections: Array<{
      id: string;
      origin_ip: string;
      client_version: string;
      opened_at: string;
    }>;
  }>;
  getTunnelConfig(): Promise<CloudflareTunnelConfig>;
  listDnsRecords(): Promise<CloudflareDnsRecord[]>;
  listAccessApps(): Promise<CloudflareAccessApp[]>;
  updateTunnelIngress(
    mutateFn: (current: CloudflareTunnelConfig['config']) => CloudflareTunnelConfig['config'],
  ): Promise<{ previous: CloudflareTunnelConfig; current: CloudflareTunnelConfig }>;
  upsertDnsCname(zoneName: string, hostname: string): Promise<CloudflareDnsRecord>;
  deleteDnsCname(zoneId: string, recordId: string): Promise<void>;
  upsertAccessApp(opts: {
    name: string;
    domain: string;
    allowedEmails: readonly string[];
  }): Promise<CloudflareAccessApp>;
  deleteAccessApp(appId: string): Promise<void>;
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

  private async cfRequest<T>(apiPath: string, method: string, body?: unknown): Promise<T> {
    const env = await fetchJson<CfEnvelope<T>>(`${this.baseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

  public async updateTunnelIngress(
    mutateFn: (current: CloudflareTunnelConfig['config']) => CloudflareTunnelConfig['config'],
  ): Promise<{ previous: CloudflareTunnelConfig; current: CloudflareTunnelConfig }> {
    const previous = await this.getTunnelConfig();
    const clonedPrev = structuredClone(previous.config);
    const nextConfig = mutateFn(structuredClone(previous.config));
    assertSafeTunnelIngress(clonedPrev, nextConfig);

    const updated = await this.cfRequest<CloudflareTunnelConfig>(
      `/accounts/${this.accountId}/cfd_tunnel/${this.tunnelId}/configurations`,
      'PUT',
      { config: nextConfig },
    );
    return { previous, current: updated };
  }

  public async upsertDnsCname(zoneName: string, hostname: string): Promise<CloudflareDnsRecord> {
    const zones = await this.cfGet<Array<{ id: string; name: string }>>(
      `/zones?name=${encodeURIComponent(zoneName)}`,
    );
    const zone = zones[0];
    if (!zone) {
      throw new HomemcpError('NOT_FOUND', `Cloudflare zone not found: ${zoneName}`);
    }
    const existing = await this.cfGet<
      Array<{ id: string; name: string; type: string; content: string; proxied?: boolean }>
    >(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`);
    const target = `${this.tunnelId}.cfargotunnel.com`;
    const body = { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 };
    const saved = existing[0]
      ? await this.cfRequest<{
          id: string;
          name: string;
          type: string;
          content: string;
          proxied?: boolean;
        }>(`/zones/${zone.id}/dns_records/${existing[0].id}`, 'PUT', body)
      : await this.cfRequest<{
          id: string;
          name: string;
          type: string;
          content: string;
          proxied?: boolean;
        }>(`/zones/${zone.id}/dns_records`, 'POST', body);
    return {
      id: saved.id,
      zone_id: zone.id,
      zone_name: zone.name,
      name: saved.name,
      type: saved.type,
      content: saved.content,
      proxied: Boolean(saved.proxied),
    };
  }

  public async deleteDnsCname(zoneId: string, recordId: string): Promise<void> {
    const rec = await this.cfGet<{ id: string; content: string; type: string }>(
      `/zones/${zoneId}/dns_records/${recordId}`,
    );
    const expected = `${this.tunnelId}.cfargotunnel.com`;
    if (rec.type !== 'CNAME' || rec.content !== expected) {
      throw new HomemcpError(
        'POLICY_DENIED',
        `Refusing to delete DNS record ${recordId}: target ${rec.content} does not match ${expected}`,
      );
    }
    await this.cfRequest(`/zones/${zoneId}/dns_records/${recordId}`, 'DELETE');
  }

  public async upsertAccessApp(opts: {
    name: string;
    domain: string;
    allowedEmails: readonly string[];
  }): Promise<CloudflareAccessApp> {
    const apps = await this.listAccessApps();
    const existing = apps.find((a) => a.domain === opts.domain);
    const appPayload = {
      name: opts.name,
      domain: opts.domain,
      type: 'self_hosted',
      session_duration: '24h',
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: 'lax',
      policies: [
        {
          name: 'owner',
          decision: 'allow',
          include: opts.allowedEmails.map((email) => ({ email: { email } })),
        },
      ],
    };
    const res = existing
      ? await this.cfRequest<{ id: string; name: string; domain: string; type: string }>(
          `/accounts/${this.accountId}/access/apps/${existing.id}`,
          'PUT',
          appPayload,
        )
      : await this.cfRequest<{ id: string; name: string; domain: string; type: string }>(
          `/accounts/${this.accountId}/access/apps`,
          'POST',
          appPayload,
        );
    return { id: res.id, name: res.name, domain: res.domain, type: res.type };
  }

  public async deleteAccessApp(appId: string): Promise<void> {
    await this.cfRequest(`/accounts/${this.accountId}/access/apps/${appId}`, 'DELETE');
  }
}
