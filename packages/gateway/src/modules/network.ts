import * as z from 'zod/v4';
import { HomemcpError } from '@homemcp/core';
import type { GatewayDeps } from '../server/factory.js';

export function registerNetworkModule(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'network_routes',
    toolset: 'network',
    tier: 'T0',
    description:
      'Builds the unified public route table linking DNS -> Cloudflare Tunnel ingress -> NPM proxy host -> container/listener -> HTTP probe, flagging dead upstreams, DNS/ingress mismatches, and expiring certificates. Read-only. Example: network_routes({ probe: true }).',
    annotations: {
      title: 'Unified Route Table',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z
      .object({
        probe: z.boolean().default(true),
      })
      .strict(),
    outputSchema: z.object({
      routes: z.array(
        z.object({
          hostname: z.string(),
          dns_ok: z.boolean(),
          tunnel_service: z.string().nullable(),
          npm_upstream: z.string().nullable(),
          npm_enabled: z.boolean().nullable(),
          access_protected: z.boolean(),
          probe_ok: z.boolean().nullable(),
          probe_status: z.number().nullable(),
          cert_expires_on: z.string().nullable(),
          flags: z.array(z.string()),
        }),
      ),
      dead_count: z.number().int(),
    }),
    handler: async ({ probe }) => {
      const [npmHosts, tunnelCfg, dnsRecords, accessApps, containers, secAudit] = await Promise.all([
        deps.npm ? deps.npm.listProxyHosts().catch(() => []) : Promise.resolve([]),
        deps.cloudflare ? deps.cloudflare.getTunnelConfig().catch(() => null) : Promise.resolve(null),
        deps.cloudflare ? deps.cloudflare.listDnsRecords().catch(() => []) : Promise.resolve([]),
        deps.cloudflare ? deps.cloudflare.listAccessApps().catch(() => []) : Promise.resolve([]),
        deps.docker ? deps.docker.listContainers(true).catch(() => []) : Promise.resolve([]),
        deps.agent
          .call<{ listening_sockets: Array<{ port: string }> }>('system.security_audit')
          .catch(() => ({ listening_sockets: [] })),
      ]);

      const listeningPorts = new Set(secAudit.listening_sockets.map((s) => Number(s.port)));
      for (const c of containers) {
        if (c.State === 'running') {
          for (const p of c.Ports) {
            if (p.PublicPort) listeningPorts.add(p.PublicPort);
          }
        }
      }

      const hostnames = new Set<string>();
      for (const h of npmHosts) {
        for (const d of h.domain_names) hostnames.add(d);
      }
      for (const rule of tunnelCfg?.config.ingress ?? []) {
        if (rule.hostname) hostnames.add(rule.hostname);
      }

      const accessDomains = new Set(accessApps.map((a) => a.domain));
      const nowMs = Date.now();

      const routes = await Promise.all(
        [...hostnames].sort().map(async (hostname) => {
          const flags: string[] = [];
          const dnsRec = dnsRecords.find((d) => d.name === hostname);
          const dnsOk = Boolean(dnsRec);
          const ingress = tunnelCfg?.config.ingress.find((r) => r.hostname === hostname);
          const npmHost = npmHosts.find((h) => h.domain_names.includes(hostname));
          const accessProtected = accessDomains.has(hostname);

          if (!dnsOk) flags.push('missing_dns');
          if (!ingress) flags.push('missing_tunnel_ingress');
          if (ingress && !npmHost && !ingress.service.startsWith('ssh://') && !ingress.service.includes('homemcp')) {
            flags.push('ingress_without_npm_host');
          }

          let npmUpstream: string | null = null;
          let probeOk: boolean | null = null;
          let probeStatus: number | null = null;
          let certExpiresOn: string | null = null;

          if (npmHost) {
            npmUpstream = `${npmHost.forward_scheme}://${npmHost.forward_host}:${npmHost.forward_port}`;
            certExpiresOn = npmHost.certificate?.expires_on ?? null;
            if (certExpiresOn) {
              const daysLeft = (Date.parse(certExpiresOn) - nowMs) / 86_400_000;
              if (Number.isFinite(daysLeft) && daysLeft < 14) {
                flags.push('cert_expiring_soon');
              }
            }
            if (!listeningPorts.has(npmHost.forward_port) && !npmHost.forward_host.match(/^[a-z]/i)) {
              flags.push('no_local_listener_on_upstream_port');
            }
          }

          if (probe && !ingress?.service.startsWith('ssh://')) {
            const pRes = await deps.httpProbe.probe(`https://${hostname}/`, { timeoutMs: 5_000 });
            probeOk = pRes.ok || pRes.status_code === 302 || pRes.status_code === 401 || pRes.status_code === 403;
            probeStatus = pRes.status_code ?? null;
            if (!probeOk) {
              flags.push('probe_failed');
            }
          }

          return {
            hostname,
            dns_ok: dnsOk,
            tunnel_service: ingress?.service ?? null,
            npm_upstream: npmUpstream,
            npm_enabled: npmHost ? npmHost.enabled : null,
            access_protected: accessProtected,
            probe_ok: probeOk,
            probe_status: probeStatus,
            cert_expires_on: certExpiresOn,
            flags,
          };
        }),
      );

      const deadCount = routes.filter(
        (r) => r.flags.includes('probe_failed') || r.flags.includes('no_local_listener_on_upstream_port'),
      ).length;

      return {
        summary: `${routes.length} routes inspected; ${deadCount} dead/stale routes flagged`,
        structured: { routes, dead_count: deadCount },
      };
    },
  });

  registry.registerTool({
    name: 'network_audit',
    toolset: 'network',
    tier: 'T0',
    description:
      'Audits public hostnames without Cloudflare Access, wildcard listening sockets, and stale NPM routes. Read-only. Example: network_audit().',
    annotations: {
      title: 'Network Exposure Audit',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      unprotected_hostnames: z.array(z.string()),
      wildcard_sockets: z.array(z.record(z.string(), z.unknown())),
      access_apps: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      const [tunnelCfg, accessApps, secAudit] = await Promise.all([
        deps.cloudflare ? deps.cloudflare.getTunnelConfig().catch(() => null) : Promise.resolve(null),
        deps.cloudflare ? deps.cloudflare.listAccessApps().catch(() => []) : Promise.resolve([]),
        deps.agent.call<{
          listening_sockets: Array<{ proto: string; address: string; port: string; wildcard: boolean }>;
        }>('system.security_audit'),
      ]);

      const protectedSet = new Set(accessApps.map((a) => a.domain));
      const unprotected = (tunnelCfg?.config.ingress ?? [])
        .map((r) => r.hostname)
        .filter((h): h is string => typeof h === 'string' && h.length > 0 && !protectedSet.has(h));
      const wildcards = secAudit.listening_sockets.filter((s) => s.wildcard);

      return {
        summary: `${unprotected.length} public hostnames without Access, ${wildcards.length} wildcard listeners`,
        structured: {
          unprotected_hostnames: unprotected,
          wildcard_sockets: wildcards,
          access_apps: accessApps as unknown as Array<Record<string, unknown>>,
        },
      };
    },
  });

  registry.registerTool({
    name: 'network_probe',
    toolset: 'network',
    tier: 'T0',
    description:
      'Probes an HTTP/HTTPS URL and reports status code, latency, redirect chain, and TLS certificate expiration. Read-only. Example: network_probe({ url: "https://vw.example.com/alive" }).',
    annotations: {
      title: 'HTTP(S) Probe',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({ url: z.string().url() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async ({ url }) => {
      const res = await deps.httpProbe.probe(url);
      return {
        summary: `${url} -> ok=${String(res.ok)} status=${String(res.status_code ?? 'err')} (${res.latency_ms}ms)`,
        structured: res as unknown as Record<string, unknown>,
      };
    },
  });

  registry.registerTool({
    name: 'npm_list_proxy_hosts',
    toolset: 'network',
    tier: 'T0',
    description:
      'Lists Nginx Proxy Manager proxy hosts, certificates, and access lists. Read-only. Example: npm_list_proxy_hosts().',
    annotations: {
      title: 'List NPM Proxy Hosts',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      proxy_hosts: z.array(z.record(z.string(), z.unknown())),
      certificates: z.array(z.record(z.string(), z.unknown())),
      access_lists: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async () => {
      if (!deps.npm) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'NPM connector is not configured');
      }
      const [hosts, certs, lists] = await Promise.all([
        deps.npm.listProxyHosts(),
        deps.npm.listCertificates(),
        deps.npm.listAccessLists(),
      ]);
      return {
        summary: `${hosts.length} NPM proxy hosts, ${certs.length} certs, ${lists.length} access lists`,
        structured: {
          proxy_hosts: hosts as unknown as Array<Record<string, unknown>>,
          certificates: certs as unknown as Array<Record<string, unknown>>,
          access_lists: lists as unknown as Array<Record<string, unknown>>,
        },
      };
    },
  });

  registry.registerTool({
    name: 'cloudflare_list_tunnel_ingress',
    toolset: 'network',
    tier: 'T0',
    description:
      'Returns Cloudflare Tunnel status, active connector replicas, and current ingress rules. Read-only. Example: cloudflare_list_tunnel_ingress().',
    annotations: {
      title: 'Cloudflare Tunnel Ingress',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async () => {
      if (!deps.cloudflare) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Cloudflare connector is not configured');
      }
      const [status, cfg] = await Promise.all([
        deps.cloudflare.getTunnelStatus(),
        deps.cloudflare.getTunnelConfig(),
      ]);
      return {
        summary: `Tunnel ${status.name} (${status.status}): ${status.connections.length} connections, ${cfg.config.ingress.length} ingress rules (v${cfg.version})`,
        structured: { tunnel: status, config_version: cfg.version, config: cfg.config },
      };
    },
  });

  registry.registerTool({
    name: 'cloudflare_list_dns',
    toolset: 'network',
    tier: 'T0',
    description:
      'Lists DNS records across all configured Cloudflare zones. Read-only. Example: cloudflare_list_dns().',
    annotations: {
      title: 'Cloudflare DNS Records',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    outputSchema: z.object({ records: z.array(z.record(z.string(), z.unknown())) }),
    handler: async () => {
      if (!deps.cloudflare) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Cloudflare connector is not configured');
      }
      const records = await deps.cloudflare.listDnsRecords();
      return {
        summary: `Listed ${records.length} DNS records across configured zones`,
        structured: { records: records as unknown as Array<Record<string, unknown>> },
      };
    },
  });

  registry.registerTool({
    name: 'tailscale_status',
    toolset: 'network',
    tier: 'T0',
    description:
      'Reports Tailscale break-glass VPN connection state, tailnet IPs, and DNS name. Read-only. Example: tailscale_status().',
    annotations: {
      title: 'Tailscale Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async () => {
      const audit = await deps.agent.call<{ tailscale: Record<string, unknown> }>(
        'system.security_audit',
      );
      const state =
        typeof audit.tailscale['backend_state'] === 'string'
          ? audit.tailscale['backend_state']
          : 'Unknown';
      return {
        summary: `Tailscale state: ${state}`,
        structured: audit.tailscale,
      };
    },
  });
}
