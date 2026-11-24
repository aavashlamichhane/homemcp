import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import type { CloudflareTunnelConfig } from '@homemcp/connectors';
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
      const [npmHosts, tunnelCfg, dnsRecords, accessApps, containers, secAudit] = await Promise.all(
        [
          deps.npm ? deps.npm.listProxyHosts().catch(() => []) : Promise.resolve([]),
          deps.cloudflare
            ? deps.cloudflare.getTunnelConfig().catch(() => null)
            : Promise.resolve(null),
          deps.cloudflare ? deps.cloudflare.listDnsRecords().catch(() => []) : Promise.resolve([]),
          deps.cloudflare ? deps.cloudflare.listAccessApps().catch(() => []) : Promise.resolve([]),
          deps.docker ? deps.docker.listContainers(true).catch(() => []) : Promise.resolve([]),
          deps.agent
            .call<{ listening_sockets: Array<{ port: string }> }>('system.security_audit')
            .catch(() => ({ listening_sockets: [] })),
        ],
      );

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
          if (
            ingress &&
            !npmHost &&
            !ingress.service.startsWith('ssh://') &&
            !ingress.service.includes('homemcp')
          ) {
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
            if (
              !listeningPorts.has(npmHost.forward_port) &&
              !npmHost.forward_host.match(/^[a-z]/i)
            ) {
              flags.push('no_local_listener_on_upstream_port');
            }
          }

          if (probe && !ingress?.service.startsWith('ssh://')) {
            const pRes = await deps.httpProbe.probe(`https://${hostname}/`, { timeoutMs: 5_000 });
            probeOk =
              pRes.ok ||
              pRes.status_code === 302 ||
              pRes.status_code === 401 ||
              pRes.status_code === 403;
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
        (r) =>
          r.flags.includes('probe_failed') ||
          r.flags.includes('no_local_listener_on_upstream_port'),
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
        deps.cloudflare
          ? deps.cloudflare.getTunnelConfig().catch(() => null)
          : Promise.resolve(null),
        deps.cloudflare ? deps.cloudflare.listAccessApps().catch(() => []) : Promise.resolve([]),
        deps.agent.call<{
          listening_sockets: Array<{
            proto: string;
            address: string;
            port: string;
            wildcard: boolean;
          }>;
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

  registry.registerTool({
    name: 'expose_plan',
    toolset: 'network',
    tier: 'T0',
    description:
      'Plans exposing an internal service publicly via NPM proxy host + Cloudflare Tunnel ingress + proxied DNS CNAME + optional Cloudflare Access. Creates a T3 plan_id requiring passkey confirmation before expose_apply.',
    annotations: {
      title: 'Plan Public Service Exposure',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        hostname: z.string().min(3),
        upstream_host: z.string().min(1),
        upstream_port: z.number().int().min(1).max(65535),
        scheme: z.enum(['http', 'https']).default('http'),
        access_emails: z.array(z.string().email()).optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: (args, ctx) => {
      if (!deps.npm || !deps.cloudflare) {
        throw new HomemcpError(
          'UPSTREAM_UNAVAILABLE',
          'NPM or Cloudflare connector not configured',
        );
      }
      const zones = deps.config.modules.network?.cloudflare?.zones ?? [];
      const zoneName = zones.find((z) => args.hostname === z || args.hostname.endsWith(`.${z}`));
      if (!zoneName) {
        throw new HomemcpError(
          'INVALID_ARGUMENT',
          `Hostname ${args.hostname} does not match any configured Cloudflare zone`,
        );
      }

      const plan = deps.plans.createPlan({
        tool: 'expose_apply',
        tier: 'T3',
        payload: {
          hostname: args.hostname,
          zone_name: zoneName,
          upstream_host: args.upstream_host,
          upstream_port: args.upstream_port,
          scheme: args.scheme,
          access_emails: args.access_emails ?? [],
        },
        summary: `Expose https://${args.hostname} -> ${args.scheme}://${args.upstream_host}:${args.upstream_port} via NPM + CF Tunnel + DNS`,
        diff: `+ NPM Proxy Host: ${args.hostname} -> ${args.scheme}://${args.upstream_host}:${args.upstream_port}\n+ CF Tunnel Ingress: ${args.hostname} -> ${deps.config.modules.network?.cloudflare?.originService ?? 'http://192.0.2.10'}:80\n+ CF DNS CNAME (proxied): ${args.hostname}`,
        sideEffects: [
          `Service becomes reachable at https://${args.hostname}`,
          args.access_emails?.length
            ? `Protected by Cloudflare Access (${args.access_emails.join(', ')})`
            : 'Publicly reachable without Cloudflare Access OTP',
        ],
        rollback: [
          'Saga auto-reverses completed steps on any failure; unexpose_plan removes all created records',
        ],
        createdBy: ctx.auth.subject,
      });
      const chal = deps.confirmations.createChallenge(plan.id, 'url');
      const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
      return Promise.resolve({
        summary: `Expose plan ${plan.id} ready; passkey confirm at ${publicUrl}/confirm/${chal.id}`,
        structured: {
          plan_id: plan.id,
          confirmation_id: chal.id,
          confirm_url: `${publicUrl}/confirm/${chal.id}`,
          diff: plan.diff,
          side_effects: plan.side_effects,
        },
        planId: plan.id,
        confirmationId: chal.id,
      });
    },
  });

  registry.registerTool({
    name: 'expose_apply',
    toolset: 'network',
    tier: 'T3',
    description:
      'Executes a confirmed expose plan as an atomic saga (NPM -> Cloudflare Tunnel ingress -> DNS CNAME -> Access -> probe), rolling back all prior steps on any failure.',
    annotations: {
      title: 'Apply Public Exposure Saga',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({ plan_id: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!deps.npm || !deps.cloudflare) {
        throw new HomemcpError(
          'UPSTREAM_UNAVAILABLE',
          'NPM or Cloudflare connector not configured',
        );
      }
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'expose_apply',
        tier: 'T3',
        auth: ctx.auth,
        mcpCtx: ctx.mcpCtx,
        publicUrl: deps.config.server.publicUrl,
      });
      if (!gate.approved) {
        return {
          summary: `Passkey confirmation required at ${gate.confirmUrl}`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: gate.plan.id,
            confirmation_id: gate.confirmationId,
            confirm_url: gate.confirmUrl,
          },
          planId: gate.plan.id,
          confirmationId: gate.confirmationId,
        };
      }

      const p = gate.plan.payload as {
        hostname: string;
        zone_name: string;
        upstream_host: string;
        upstream_port: number;
        scheme: 'http' | 'https';
        access_emails: string[];
      };
      const originSvc =
        deps.config.modules.network?.cloudflare?.originService ?? 'http://192.0.2.10';

      let createdNpmId: number | undefined;
      let prevIngress: CloudflareTunnelConfig['config'] | undefined;
      let createdDns: { zone_id: string; id: string } | undefined;
      let createdAccessId: string | undefined;

      const sagaRes = await deps.saga.run([
        {
          name: 'npm_proxy_host',
          run: async () => {
            const h = await deps.npm!.createProxyHost({
              domain_names: [p.hostname],
              forward_scheme: p.scheme,
              forward_host: p.upstream_host,
              forward_port: p.upstream_port,
            });
            createdNpmId = h.id;
            return h;
          },
          undo: async () => {
            if (createdNpmId !== undefined) {
              await deps.npm!.deleteProxyHost(createdNpmId);
            }
          },
        },
        {
          name: 'cf_tunnel_ingress',
          run: async () => {
            const res = await deps.cloudflare!.updateTunnelIngress((cfg) => {
              const filtered = cfg.ingress.filter((r) => r.hostname !== p.hostname);
              const catchAllIdx = filtered.findIndex(
                (r) => !r.hostname && r.service === 'http_status:404',
              );
              const insertAt = catchAllIdx >= 0 ? catchAllIdx : filtered.length;
              filtered.splice(insertAt, 0, {
                hostname: p.hostname,
                service: `${originSvc}:80`,
              });
              return { ...cfg, ingress: filtered };
            });
            prevIngress = res.previous.config;
            deps.db.db
              .prepare(
                `INSERT INTO cf_ingress_history (id, version, config_json, changed_by, ts, reason)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(
                `cfh_${randomUUID().slice(0, 12)}`,
                res.previous.version,
                JSON.stringify(res.previous.config),
                ctx.auth.subject,
                new Date().toISOString(),
                `expose ${p.hostname}`,
              );
            return res.current;
          },
          undo: async () => {
            if (prevIngress) {
              const snapshot = prevIngress;
              await deps.cloudflare!.updateTunnelIngress(() => snapshot);
            }
          },
        },
        {
          name: 'cf_dns_cname',
          run: async () => {
            const rec = await deps.cloudflare!.upsertDnsCname(p.zone_name, p.hostname);
            createdDns = { zone_id: rec.zone_id, id: rec.id };
            return rec;
          },
          undo: async () => {
            if (createdDns) {
              await deps.cloudflare!.deleteDnsCname(createdDns.zone_id, createdDns.id);
            }
          },
        },
        ...(p.access_emails.length > 0
          ? [
              {
                name: 'cf_access_app',
                run: async () => {
                  const app = await deps.cloudflare!.upsertAccessApp({
                    name: p.hostname,
                    domain: p.hostname,
                    allowedEmails: p.access_emails,
                  });
                  createdAccessId = app.id;
                  return app;
                },
                undo: async () => {
                  if (createdAccessId) {
                    await deps.cloudflare!.deleteAccessApp(createdAccessId);
                  }
                },
              },
            ]
          : []),
        {
          name: 'http_probe',
          run: () => deps.httpProbe.probe(`https://${p.hostname}/`, { timeoutMs: 8_000 }),
        },
      ]);

      deps.plans.markApplied(gate.plan.id);
      if (!sagaRes.ok) {
        return {
          summary: `Expose saga failed at "${sagaRes.failed_step ?? 'unknown'}" (${sagaRes.error ?? ''}); rolled back steps: ${sagaRes.rolled_back_steps.join(', ')}`,
          structured: {
            applied: false,
            status: 'rolled_back',
            ...sagaRes,
          },
          planId: gate.plan.id,
          confirmationId: gate.confirmationId,
        };
      }

      return {
        summary: `Exposed https://${p.hostname} cleanly via NPM, Cloudflare Tunnel, and DNS`,
        structured: {
          applied: true,
          status: 'applied',
          hostname: p.hostname,
          ...sagaRes,
        },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'unexpose_plan',
    toolset: 'network',
    tier: 'T0',
    description:
      'Plans removing public Access, DNS CNAME, tunnel ingress, and NPM proxy host for a hostname. Read-only.',
    annotations: {
      title: 'Plan Service Unexposure',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ hostname: z.string().min(3) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: (args, ctx) => {
      if (args.hostname.startsWith('ssh.') || args.hostname.startsWith('homemcp.')) {
        throw new HomemcpError(
          'POLICY_DENIED',
          `Refusing to unexpose protected hostname ${args.hostname}`,
        );
      }
      const plan = deps.plans.createPlan({
        tool: 'unexpose_apply',
        tier: 'T3',
        payload: { hostname: args.hostname },
        summary: `Unexpose https://${args.hostname} (Access + DNS CNAME + tunnel ingress + NPM proxy host)`,
        diff: `- Access / DNS / Tunnel / NPM for ${args.hostname}`,
        sideEffects: [`https://${args.hostname} will no longer be publicly reachable`],
        rollback: ['Re-run expose_plan/expose_apply or cloudflare_ingress_restore'],
        createdBy: ctx.auth.subject,
      });
      const chal = deps.confirmations.createChallenge(plan.id, 'url');
      const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
      return Promise.resolve({
        summary: `Unexpose plan ${plan.id} created; passkey confirm at ${publicUrl}/confirm/${chal.id}`,
        structured: {
          plan_id: plan.id,
          confirmation_id: chal.id,
          confirm_url: `${publicUrl}/confirm/${chal.id}`,
        },
        planId: plan.id,
        confirmationId: chal.id,
      });
    },
  });

  registry.registerTool({
    name: 'unexpose_apply',
    toolset: 'network',
    tier: 'T3',
    description: 'Executes a confirmed unexpose plan.',
    annotations: {
      title: 'Apply Service Unexposure',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({ plan_id: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!deps.npm || !deps.cloudflare) {
        throw new HomemcpError(
          'UPSTREAM_UNAVAILABLE',
          'NPM or Cloudflare connector not configured',
        );
      }
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'unexpose_apply',
        tier: 'T3',
        auth: ctx.auth,
        mcpCtx: ctx.mcpCtx,
        publicUrl: deps.config.server.publicUrl,
      });
      if (!gate.approved) {
        return {
          summary: `Passkey confirmation required at ${gate.confirmUrl}`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: gate.plan.id,
            confirmation_id: gate.confirmationId,
            confirm_url: gate.confirmUrl,
          },
          planId: gate.plan.id,
          confirmationId: gate.confirmationId,
        };
      }

      const { hostname } = gate.plan.payload as { hostname: string };
      const [apps, dnsRecords, npmHosts] = await Promise.all([
        deps.cloudflare.listAccessApps(),
        deps.cloudflare.listDnsRecords(),
        deps.npm.listProxyHosts(),
      ]);

      const removed: string[] = [];
      for (const a of apps.filter((x) => x.domain === hostname)) {
        await deps.cloudflare.deleteAccessApp(a.id);
        removed.push(`access:${a.id}`);
      }
      for (const d of dnsRecords.filter((x) => x.name === hostname && x.type === 'CNAME')) {
        await deps.cloudflare.deleteDnsCname(d.zone_id, d.id);
        removed.push(`dns:${d.id}`);
      }
      const res = await deps.cloudflare.updateTunnelIngress((cfg) => ({
        ...cfg,
        ingress: cfg.ingress.filter((r) => r.hostname !== hostname),
      }));
      deps.db.db
        .prepare(
          `INSERT INTO cf_ingress_history (id, version, config_json, changed_by, ts, reason)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `cfh_${randomUUID().slice(0, 12)}`,
          res.previous.version,
          JSON.stringify(res.previous.config),
          ctx.auth.subject,
          new Date().toISOString(),
          `unexpose ${hostname}`,
        );
      removed.push('tunnel_ingress');

      for (const h of npmHosts.filter((x) => x.domain_names.includes(hostname))) {
        await deps.npm.deleteProxyHost(h.id);
        removed.push(`npm:${h.id}`);
      }

      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Unexposed ${hostname}: removed ${removed.join(', ')}`,
        structured: { applied: true, status: 'applied', hostname, removed },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'npm_proxy_host_upsert',
    toolset: 'network',
    tier: 'T2',
    description: 'Creates or updates an Nginx Proxy Manager proxy host (plan-first).',
    annotations: {
      title: 'Upsert NPM Proxy Host',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        id: z.number().int().optional(),
        domain_names: z.array(z.string().min(3)).min(1),
        forward_host: z.string().min(1),
        forward_port: z.number().int().min(1).max(65535),
        forward_scheme: z.enum(['http', 'https']).default('http'),
        plan_id: z.string().optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!deps.npm) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'NPM connector not configured');
      }
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'npm_proxy_host_upsert',
          tier: 'T2',
          payload: {
            id: args.id,
            domain_names: args.domain_names,
            forward_host: args.forward_host,
            forward_port: args.forward_port,
            forward_scheme: args.forward_scheme,
          },
          summary: `${args.id ? 'Update' : 'Create'} NPM proxy host for ${args.domain_names.join(', ')}`,
          diff: `${args.domain_names.join(', ')} -> ${args.forward_scheme}://${args.forward_host}:${args.forward_port}`,
          sideEffects: ['Updates Nginx Proxy Manager routing configuration'],
          rollback: ['Delete or update the NPM host ID'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Plan ${plan.id} created`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: plan.id,
            confirmation_id: chal.id,
            confirm_url: `${publicUrl}/confirm/${chal.id}`,
          },
          planId: plan.id,
          confirmationId: chal.id,
        };
      }
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'npm_proxy_host_upsert',
        tier: 'T2',
        auth: ctx.auth,
        mcpCtx: ctx.mcpCtx,
        publicUrl: deps.config.server.publicUrl,
      });
      if (!gate.approved) {
        return {
          summary: `Confirmation required at ${gate.confirmUrl}`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: gate.plan.id,
            confirmation_id: gate.confirmationId,
            confirm_url: gate.confirmUrl,
          },
          planId: gate.plan.id,
          confirmationId: gate.confirmationId,
        };
      }
      const p = gate.plan.payload as {
        id?: number;
        domain_names: string[];
        forward_host: string;
        forward_port: number;
        forward_scheme: 'http' | 'https';
      };
      const host = p.id
        ? await deps.npm.updateProxyHost(p.id, p)
        : await deps.npm.createProxyHost(p);
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Saved NPM proxy host #${host.id} (${host.domain_names.join(', ')})`,
        structured: { applied: true, status: 'applied', host },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'npm_proxy_host_delete',
    toolset: 'network',
    tier: 'T2',
    description: 'Deletes an NPM proxy host by ID (plan-first).',
    annotations: {
      title: 'Delete NPM Proxy Host',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({ id: z.number().int().positive(), plan_id: z.string().optional() })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!deps.npm) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'NPM connector not configured');
      }
      if (!args.plan_id) {
        const plan = deps.plans.createPlan({
          tool: 'npm_proxy_host_delete',
          tier: 'T2',
          payload: { id: args.id },
          summary: `Delete NPM proxy host #${args.id}`,
          diff: `- NPM host #${args.id}`,
          sideEffects: ['Removes NPM proxy host routing rule'],
          rollback: ['Recreate via npm_proxy_host_upsert'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Plan ${plan.id} created`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: plan.id,
            confirmation_id: chal.id,
            confirm_url: `${publicUrl}/confirm/${chal.id}`,
          },
          planId: plan.id,
          confirmationId: chal.id,
        };
      }
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'npm_proxy_host_delete',
        tier: 'T2',
        auth: ctx.auth,
        mcpCtx: ctx.mcpCtx,
        publicUrl: deps.config.server.publicUrl,
      });
      if (!gate.approved) {
        return {
          summary: `Confirmation required at ${gate.confirmUrl}`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: gate.plan.id,
            confirmation_id: gate.confirmationId,
            confirm_url: gate.confirmUrl,
          },
          planId: gate.plan.id,
          confirmationId: gate.confirmationId,
        };
      }
      const { id } = gate.plan.payload as { id: number };
      await deps.npm.deleteProxyHost(id);
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Deleted NPM proxy host #${id}`,
        structured: { applied: true, status: 'applied', deleted_id: id },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });

  registry.registerTool({
    name: 'cloudflare_ingress_restore',
    toolset: 'network',
    tier: 'T3',
    description:
      'Restores Cloudflare Tunnel ingress configuration from a historical cf_ingress_history snapshot (T3 passkey confirmation required).',
    annotations: {
      title: 'Restore Cloudflare Ingress',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z
      .object({ history_id: z.string().optional(), plan_id: z.string().optional() })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    handler: async (args, ctx) => {
      if (!deps.cloudflare) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'Cloudflare connector not configured');
      }
      if (!args.plan_id) {
        const row = args.history_id
          ? (deps.db.db
              .prepare('SELECT * FROM cf_ingress_history WHERE id = ?')
              .get(args.history_id) as Record<string, unknown> | undefined)
          : (deps.db.db
              .prepare('SELECT * FROM cf_ingress_history ORDER BY ts DESC LIMIT 1')
              .get() as Record<string, unknown> | undefined);
        if (!row) {
          throw new HomemcpError('NOT_FOUND', 'No cf_ingress_history snapshot found');
        }
        const plan = deps.plans.createPlan({
          tool: 'cloudflare_ingress_restore',
          tier: 'T3',
          payload: { history_id: String(row['id']) },
          summary: `Restore Cloudflare Tunnel ingress to snapshot ${String(row['id'])} (version ${String(row['version'])})`,
          diff: String(row['config_json']),
          sideEffects: ['Replaces tunnel ingress rules with snapshot'],
          rollback: ['Previous state is recorded as a new snapshot'],
          createdBy: ctx.auth.subject,
        });
        const chal = deps.confirmations.createChallenge(plan.id, 'url');
        const publicUrl = deps.config.server.publicUrl.replace(/\/+$/, '');
        return {
          summary: `Restore plan ${plan.id} created`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: plan.id,
            confirmation_id: chal.id,
            confirm_url: `${publicUrl}/confirm/${chal.id}`,
          },
          planId: plan.id,
          confirmationId: chal.id,
        };
      }
      const gate = await deps.confirmations.requireApprovalOrChallenge({
        planId: args.plan_id,
        expectedTool: 'cloudflare_ingress_restore',
        tier: 'T3',
        auth: ctx.auth,
        mcpCtx: ctx.mcpCtx,
        publicUrl: deps.config.server.publicUrl,
      });
      if (!gate.approved) {
        return {
          summary: `Passkey confirmation required at ${gate.confirmUrl}`,
          structured: {
            applied: false,
            status: 'confirmation_required',
            plan_id: gate.plan.id,
            confirmation_id: gate.confirmationId,
            confirm_url: gate.confirmUrl,
          },
          planId: gate.plan.id,
          confirmationId: gate.confirmationId,
        };
      }
      const { history_id } = gate.plan.payload as { history_id: string };
      const row = deps.db.db
        .prepare('SELECT * FROM cf_ingress_history WHERE id = ?')
        .get(history_id) as { config_json: string } | undefined;
      if (!row) {
        throw new HomemcpError('NOT_FOUND', `Snapshot ${history_id} not found`);
      }
      const targetCfg = JSON.parse(row.config_json) as CloudflareTunnelConfig['config'];
      await deps.cloudflare.updateTunnelIngress(() => targetCfg);
      deps.plans.markApplied(gate.plan.id);
      return {
        summary: `Restored Cloudflare Tunnel ingress from ${history_id}`,
        structured: { applied: true, status: 'applied', history_id },
        planId: gate.plan.id,
        confirmationId: gate.confirmationId,
      };
    },
  });
}
