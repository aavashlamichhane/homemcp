import { AsyncLocalStorage } from 'node:async_hooks';
import type http from 'node:http';
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { type Express, type Request, type Response } from 'express';
import { ALL_SCOPES, type AuthContext } from '@homemcp/core';
import { buildMcpServer, type GatewayDeps } from '../server/factory.js';
import type { PatManager } from './pats.js';
import { createOidcProvider } from './provider.js';
import { registerAuthUiRoutes } from './ui.js';
import { createHomemcpTokenVerifier } from './verifier.js';
import { OwnerAuthService } from './webauthn.js';

export interface HttpGatewayHandle {
  app: Express;
  server: http.Server;
  port: number;
  baseUrl: string;
  pats: PatManager;
  authService: OwnerAuthService;
  close(): Promise<void>;
}

export async function startHttpGateway(
  deps: GatewayDeps,
  opts?: {
    port?: number | undefined;
    host?: string | undefined;
    issuerOverride?: string | undefined;
    mcpResourceOverride?: string | undefined;
  },
): Promise<HttpGatewayHandle> {
  const listenParts = deps.config.server.listen.split(':');
  const host = opts?.host ?? (listenParts[0] || '0.0.0.0');
  const port = opts?.port ?? Number(listenParts[1] ?? 8790);

  const publicUrl = (opts?.issuerOverride ?? deps.config.server.publicUrl).replace(/\/+$/, '');
  const rpId = new URL(publicUrl).hostname;

  const pats = deps.pats;
  const authService = new OwnerAuthService(deps.db, {
    rpId,
    rpName: 'homemcp',
    origin: publicUrl,
    secretKey: deps.config.auth.secretKey,
    ownerName: deps.config.auth.owner.name,
  });

  const { provider, getJwks, mcpResourceUrl } = await createOidcProvider(deps.db, deps.config, {
    issuerOverride: publicUrl,
    mcpResourceOverride: opts?.mcpResourceOverride ?? `${publicUrl}${deps.config.server.mcpPath}`,
  });

  const app = createMcpExpressApp({
    host,
    ...(deps.config.server.allowedHosts.length > 0
      ? { allowedHosts: deps.config.server.allowedHosts }
      : {}),
  });
  if (deps.config.server.trustProxy) {
    app.set('trust proxy', true);
  }

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: deps.version, mock: deps.isMock });
  });

  // Rate limit DCR (/oauth/register): 10 requests per hour per IP
  const dcrBuckets = new Map<string, { count: number; resetAt: number }>();
  app.use('/oauth/register', (req, res, next) => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const ip =
      (deps.config.server.trustProxy
        ? (req.headers['cf-connecting-ip'] as string | undefined)
        : undefined) ??
      req.ip ??
      'unknown';
    const now = Date.now();
    const bucket = dcrBuckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      dcrBuckets.set(ip, { count: 1, resetAt: now + 3_600_000 });
      next();
      return;
    }
    if (bucket.count >= 10) {
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }
    bucket.count++;
    next();
  });

  const mcpUrl = new URL(mcpResourceUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: {
        issuer: publicUrl,
        authorization_endpoint: `${publicUrl}/oauth/authorize`,
        token_endpoint: `${publicUrl}/oauth/token`,
        registration_endpoint: `${publicUrl}/oauth/register`,
        jwks_uri: `${publicUrl}/oauth/jwks`,
        revocation_endpoint: `${publicUrl}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', ...ALL_SCOPES],
        client_id_metadata_document_supported: deps.config.auth.clientRegistration.cimd,
      },
      resourceServerUrl: mcpUrl,
      scopesSupported: [...ALL_SCOPES],
      resourceName: 'homemcp',
    }),
  );

  // Store request IP in AsyncLocalStorage so OAuthTokenVerifier checks PAT CIDRs accurately
  const reqIpStorage = new AsyncLocalStorage<string | undefined>();
  app.use((req, _res, next) => {
    const cfIp = deps.config.server.trustProxy
      ? (req.headers['cf-connecting-ip'] as string | undefined)
      : undefined;
    const ip = cfIp?.trim() || req.ip;
    reqIpStorage.run(ip, next);
  });

  const verifier = createHomemcpTokenVerifier({
    db: deps.db,
    pats,
    issuer: publicUrl,
    expectedAudience: mcpResourceUrl,
    getJwks,
    getClientIp: () => reqIpStorage.getStore(),
  });

  const bearerAuth = requireBearerAuth({
    verifier,
    resourceMetadataUrl,
    expectedResource: mcpUrl,
  });

  const mcpHandler = (toolsetsParam?: string) => async (req: Request, res: Response) => {
    const authInfo = (req as Request & { auth?: AuthContext & { extra?: Record<string, unknown> } }).auth;
    const extra = authInfo?.extra ?? {};
    const auth: AuthContext | undefined = authInfo
      ? {
          subject: typeof extra['subject'] === 'string' ? extra['subject'] : 'owner',
          clientId: (authInfo as unknown as { clientId?: string }).clientId ?? 'unknown',
          tokenKind: (extra['tokenKind'] as AuthContext['tokenKind']) ?? 'oauth',
          tokenId: typeof extra['tokenId'] === 'string' ? extra['tokenId'] : 'unknown',
          scopes: (authInfo as unknown as { scopes?: string[] }).scopes ?? [],
          allowedToolsets: Array.isArray(extra['allowedToolsets'])
            ? (extra['allowedToolsets'] as AuthContext['allowedToolsets'])
            : undefined,
          authTime: typeof extra['authTime'] === 'number' ? extra['authTime'] : undefined,
        }
      : undefined;

    const nodeHandler = toNodeHandler(
      createMcpHandler(() => buildMcpServer(deps, { toolsetFilter: toolsetsParam, auth })),
    );
    await nodeHandler(req, res, req.body);
  };

  app.post('/mcp', bearerAuth, (req, res) => void mcpHandler(undefined)(req, res));
  app.delete('/mcp', bearerAuth, (req, res) => void mcpHandler(undefined)(req, res));
  app.post('/mcp/:toolsets', bearerAuth, (req, res) =>
    void mcpHandler(String(req.params['toolsets']))(req, res),
  );
  app.delete('/mcp/:toolsets', bearerAuth, (req, res) =>
    void mcpHandler(String(req.params['toolsets']))(req, res),
  );

  // Interactive login/consent/account/bootstrap/confirm UI
  registerAuthUiRoutes(app, {
    db: deps.db,
    config: deps.config,
    provider,
    authService,
    pats,
    plans: deps.plans,
    confirmations: deps.confirmations,
    mcpResourceUrl,
  });

  // Mount oidc-provider for /oauth/* and /.well-known/openid-configuration
  const oidcCallback = provider.callback();
  app.use('/oauth', (req, res) => {
    void oidcCallback(req, res);
  });
  app.get('/.well-known/openid-configuration', (req, res) => {
    void oidcCallback(req, res);
  });

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once('error', reject);
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    app,
    server,
    port: actualPort,
    baseUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    pats,
    authService,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
