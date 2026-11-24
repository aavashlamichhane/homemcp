import { createHash } from 'node:crypto';
import type { JWK } from 'jose';
import Provider, { errors, type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { ALL_SCOPES, parseDurationMs, type HomemcpConfig } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';
import { createSqliteAdapterFactory } from './adapter.js';
import { decryptAtRest, encryptAtRest, generateSigningKeyPair } from './crypto.js';

export interface AuthProviderBundle {
  provider: Provider;
  getJwks: () => { keys: JWK[] };
  mcpResourceUrl: string;
}

export async function loadOrCreateSigningKeys(
  db: HomemcpDb,
  secretKey: string,
): Promise<{ publicJwk: JWK; privateJwk: JWK }> {
  const existing = db.db
    .prepare(
      'SELECT kid, alg, public_jwk_json, private_jwk_enc FROM auth_keys ORDER BY created_at ASC LIMIT 1',
    )
    .get() as
    { kid: string; alg: string; public_jwk_json: string; private_jwk_enc: string } | undefined;

  if (existing) {
    return {
      publicJwk: JSON.parse(existing.public_jwk_json) as JWK,
      privateJwk: JSON.parse(decryptAtRest(existing.private_jwk_enc, secretKey)) as JWK,
    };
  }

  const generated = await generateSigningKeyPair();
  const encPriv = encryptAtRest(JSON.stringify(generated.privateJwk), secretKey);
  db.db
    .prepare(
      'INSERT INTO auth_keys (kid, alg, public_jwk_json, private_jwk_enc, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      generated.kid,
      generated.alg,
      JSON.stringify(generated.publicJwk),
      encPriv,
      new Date().toISOString(),
    );
  return { publicJwk: generated.publicJwk, privateJwk: generated.privateJwk };
}

export async function createOidcProvider(
  db: HomemcpDb,
  config: HomemcpConfig,
  opts?: { issuerOverride?: string | undefined; mcpResourceOverride?: string | undefined },
): Promise<AuthProviderBundle> {
  const issuer = (opts?.issuerOverride ?? config.auth.issuer).replace(/\/+$/, '');
  const mcpResourceUrl = (
    opts?.mcpResourceOverride ??
    `${config.server.publicUrl.replace(/\/+$/, '')}${config.server.mcpPath}`
  ).replace(/\/+$/, '');

  const { publicJwk, privateJwk } = await loadOrCreateSigningKeys(db, config.auth.secretKey);
  const cookieSecret = createHash('sha256')
    .update(`oidc-cookie:${config.auth.secretKey}`)
    .digest('hex');

  const accessTtlSec = Math.floor(parseDurationMs(config.auth.accessTokenTtl) / 1000);
  const refreshTtlSec = Math.floor(parseDurationMs(config.auth.refreshTokenTtl) / 1000);
  const supportedScopes = ['openid', 'offline_access'];

  const oidcConfig: Configuration = {
    adapter: createSqliteAdapterFactory(db),
    jwks: { keys: [privateJwk] },
    clientDefaults: {
      id_token_signed_response_alg: 'ES256',
    },
    cookies: {
      keys: [cookieSecret],
      long: { signed: true, httpOnly: true, sameSite: 'lax' },
      short: { signed: true, httpOnly: true, sameSite: 'lax' },
    },
    routes: {
      authorization: '/authorize',
      token: '/token',
      jwks: '/jwks',
      registration: '/register',
      revocation: '/revoke',
      introspection: '/introspect',
      userinfo: '/userinfo',
      end_session: '/logout',
    },
    scopes: supportedScopes,
    claims: {
      openid: ['sub', 'name'],
    },
    pkce: {
      required: () => true,
    },
    ttl: {
      AccessToken: accessTtlSec,
      RefreshToken: refreshTtlSec,
      Grant: refreshTtlSec,
      Interaction: 600,
      Session: 86_400,
      AuthorizationCode: 300,
    },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: () => true,
    features: {
      devInteractions: { enabled: false },
      registration: {
        enabled: config.auth.clientRegistration.dcr,
        initialAccessToken: false,
      },
      revocation: { enabled: true },
      introspection: { enabled: false },
      userinfo: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => mcpResourceUrl,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx: KoaContextWithOIDC, resourceIndicator: string) => {
          const norm = resourceIndicator.replace(/\/+$/, '');
          if (norm === mcpResourceUrl || norm.startsWith(`${mcpResourceUrl}/`)) {
            return {
              scope: ALL_SCOPES.join(' '),
              audience: mcpResourceUrl,
              accessTokenFormat: 'jwt',
              accessTokenTTL: accessTtlSec,
            };
          }
          throw new errors.InvalidTarget('Unknown resource indicator');
        },
      },
    },
    formats: {
      customizers: {
        jwt(_ctx, token, jwt) {
          if ('grantId' in token && token.grantId) {
            jwt.payload['grant_id'] = token.grantId;
          }
          if (token.clientId) {
            jwt.payload['client_id'] = token.clientId;
          }
          if ('accountId' in token && token.accountId) {
            jwt.payload['sub'] = token.accountId;
          }
        },
      },
    },
    interactions: {
      url(_ctx: KoaContextWithOIDC, interaction: { uid: string }) {
        return `/oauth/interaction/${interaction.uid}`;
      },
    },
    findAccount(_ctx: KoaContextWithOIDC, id: string) {
      if (id !== 'owner') return undefined;
      return Promise.resolve({
        accountId: 'owner',
        claims() {
          return Promise.resolve({
            sub: 'owner',
            name: config.auth.owner.name,
          });
        },
      });
    },
  };

  const provider = new Provider(issuer, oidcConfig);
  if (config.server.trustProxy) {
    provider.proxy = true;
  }

  return {
    provider,
    getJwks: () => ({ keys: [publicJwk] }),
    mcpResourceUrl,
  };
}
