import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose';
import type { HomemcpDb } from '../db/database.js';
import { isGrantActive } from './adapter.js';
import type { PatManager } from './pats.js';

export function createHomemcpTokenVerifier(opts: {
  db: HomemcpDb;
  pats: PatManager;
  issuer: string;
  expectedAudience: string;
  getJwks: () => { keys: JWK[] };
  getClientIp?: () => string | undefined;
}): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token.startsWith('hmp_')) {
        const ip = opts.getClientIp?.();
        let pat;
        try {
          pat = opts.pats.verifyPat(token, ip);
        } catch (err) {
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            err instanceof Error ? err.message : 'PAT rejected',
          );
        }
        if (!pat) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid, expired, or revoked PAT');
        }
        return {
          token,
          clientId: `pat:${pat.id}`,
          scopes: pat.scopes,
          expiresAt: Math.floor(Date.parse(pat.expires_at) / 1000),
          resource: new URL(opts.expectedAudience),
          extra: {
            subject: 'owner',
            tokenKind: 'pat',
            tokenId: pat.id,
            allowedToolsets: pat.toolsets,
          },
        };
      }

      try {
        const jwks = createLocalJWKSet(opts.getJwks());
        const { payload } = await jwtVerify(token, jwks, {
          issuer: opts.issuer,
          audience: opts.expectedAudience,
        });

        const grantId = typeof payload['grant_id'] === 'string' ? payload['grant_id'] : undefined;
        if (grantId && !isGrantActive(opts.db, grantId)) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'OAuth grant has been revoked');
        }

        const scopeStr = typeof payload['scope'] === 'string' ? payload['scope'] : '';
        const scopes = scopeStr
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean);

        return {
          token,
          clientId: typeof payload['client_id'] === 'string' ? payload['client_id'] : 'unknown',
          scopes,
          ...(payload.exp !== undefined ? { expiresAt: payload.exp } : {}),
          resource: new URL(opts.expectedAudience),
          extra: {
            subject: typeof payload.sub === 'string' ? payload.sub : 'owner',
            tokenKind: 'oauth',
            tokenId: typeof payload.jti === 'string' ? payload.jti : (grantId ?? 'jwt'),
            authTime: typeof payload['auth_time'] === 'number' ? payload['auth_time'] : undefined,
          },
        };
      } catch (err) {
        if (err instanceof OAuthError) throw err;
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          err instanceof Error ? err.message : 'Invalid access token',
        );
      }
    },
  };
}
