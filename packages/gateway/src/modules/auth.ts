import * as z from 'zod/v4';
import { ALL_SCOPES, HomemcpError, TOOLSET_NAMES } from '@homemcp/core';
import { listOAuthClients, revokeOAuthClientAndGrants } from '../auth/adapter.js';
import type { PatManager } from '../auth/pats.js';
import type { GatewayDeps } from '../server/factory.js';

export function registerAuthModule(
  deps: GatewayDeps,
  opts?: { patManager?: PatManager | undefined; publicUrl?: string | undefined },
): void {
  const { registry } = deps;

  registry.registerTool({
    name: 'auth_whoami',
    toolset: 'auth',
    tier: 'T0',
    description:
      'Returns the authenticated caller subject, client_id, token kind/id, scopes, and auth_time. Read-only. Example: auth_whoami().',
    annotations: {
      title: 'Current Auth Identity',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      subject: z.string(),
      client_id: z.string(),
      token_kind: z.string(),
      token_id: z.string(),
      scopes: z.array(z.string()),
      auth_time: z.number().nullable(),
    }),
    handler: (_args, ctx) =>
      Promise.resolve({
        summary: `subject=${ctx.auth.subject}, client=${ctx.auth.clientId}, kind=${ctx.auth.tokenKind}, scopes=${ctx.auth.scopes.join(' ')}`,
        structured: {
          subject: ctx.auth.subject,
          client_id: ctx.auth.clientId,
          token_kind: ctx.auth.tokenKind,
          token_id: ctx.auth.tokenId,
          scopes: [...ctx.auth.scopes],
          auth_time: ctx.auth.authTime ?? null,
        },
      }),
  });

  registry.registerTool({
    name: 'auth_clients_list',
    toolset: 'auth',
    tier: 'T0',
    description:
      'Lists registered and CIMD-cached OAuth clients. Read-only. Example: auth_clients_list().',
    annotations: {
      title: 'List OAuth Clients',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      clients: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: () => {
      const clients = listOAuthClients(deps.db);
      return Promise.resolve({
        summary: `${clients.length} OAuth clients known`,
        structured: { clients: clients.map((c) => ({ ...c })) },
      });
    },
  });

  registry.registerTool({
    name: 'auth_client_revoke',
    toolset: 'auth',
    tier: 'T3',
    description:
      'Revokes an OAuth client and all of its active grants/refresh tokens. T3 critical action. Example: auth_client_revoke({ client_id: "https://client.example.com/oauth.json" }).',
    annotations: {
      title: 'Revoke OAuth Client',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ client_id: z.string().min(1) }).strict(),
    outputSchema: z.object({
      client_id: z.string(),
      revoked_records: z.number().int(),
    }),
    handler: ({ client_id }) => {
      const revoked = revokeOAuthClientAndGrants(deps.db, client_id);
      return Promise.resolve({
        summary: `Revoked client ${client_id} (${revoked} records removed)`,
        structured: { client_id, revoked_records: revoked },
        resources: [client_id],
      });
    },
  });

  registry.registerTool({
    name: 'auth_pat_create',
    toolset: 'auth',
    tier: 'T3',
    description:
      'Creates a Personal Access Token (PAT) for headless agents with explicit scopes, optional toolsets, optional CIDRs, and TTL (max 90 days). Never returns the secret in tool output; returns a one-time /account/pat-reveal URL requiring a passkey session. Example: auth_pat_create({ name: "ci-reader", scopes: ["homemcp:read"], ttl_days: 30 }).',
    annotations: {
      title: 'Create Personal Access Token',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: z
      .object({
        name: z.string().min(1).max(100),
        scopes: z.array(z.enum(ALL_SCOPES)).min(1),
        toolsets: z.array(z.enum(TOOLSET_NAMES)).optional(),
        cidrs: z.array(z.string()).optional(),
        ttl_days: z.number().int().min(1).max(90).default(30),
      })
      .strict(),
    outputSchema: z.object({
      id: z.string(),
      name: z.string(),
      prefix: z.string(),
      scopes: z.array(z.string()),
      expires_at: z.string(),
      reveal_url: z.string(),
    }),
    handler: (args) => {
      if (!opts?.patManager) {
        throw new HomemcpError(
          'UPSTREAM_UNAVAILABLE',
          'PAT manager is only available in HTTP auth mode',
        );
      }
      const { record, revealId } = opts.patManager.createPat({
        name: args.name,
        scopes: args.scopes,
        toolsets: args.toolsets,
        cidrs: args.cidrs,
        ttlDays: args.ttl_days,
      });
      const base = (opts.publicUrl ?? deps.config.server.publicUrl).replace(/\/+$/, '');
      const revealUrl = `${base}/account/pat-reveal/${revealId}`;
      return Promise.resolve({
        summary: `Created PAT "${record.name}" (${record.prefix}...). Reveal once at: ${revealUrl}`,
        structured: {
          id: record.id,
          name: record.name,
          prefix: record.prefix,
          scopes: record.scopes,
          expires_at: record.expires_at,
          reveal_url: revealUrl,
        },
        resources: [record.id],
      });
    },
  });

  registry.registerTool({
    name: 'auth_pat_list',
    toolset: 'auth',
    tier: 'T0',
    description:
      'Lists Personal Access Tokens (metadata only, never secret hashes or values). Read-only. Example: auth_pat_list().',
    annotations: {
      title: 'List Personal Access Tokens',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: z.object({
      pats: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: () => {
      if (!opts?.patManager) {
        return Promise.resolve({ summary: '0 PATs', structured: { pats: [] } });
      }
      const pats = opts.patManager.listPats();
      return Promise.resolve({
        summary: `${pats.length} PATs`,
        structured: { pats: pats as unknown as Array<Record<string, unknown>> },
      });
    },
  });

  registry.registerTool({
    name: 'auth_pat_revoke',
    toolset: 'auth',
    tier: 'T2',
    description: 'Revokes a Personal Access Token by id. Example: auth_pat_revoke({ id: "..." }).',
    annotations: {
      title: 'Revoke Personal Access Token',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({ id: z.string().min(1) }).strict(),
    outputSchema: z.object({ id: z.string(), revoked: z.boolean() }),
    handler: ({ id }) => {
      if (!opts?.patManager) {
        throw new HomemcpError('UPSTREAM_UNAVAILABLE', 'PAT manager is not configured');
      }
      const revoked = opts.patManager.revokePat(id);
      return Promise.resolve({
        summary: revoked ? `Revoked PAT ${id}` : `PAT ${id} was not active or not found`,
        structured: { id, revoked },
        resources: [id],
      });
    },
  });
}
