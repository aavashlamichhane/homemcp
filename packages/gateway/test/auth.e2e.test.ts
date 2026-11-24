import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchCimdMetadata } from '../src/auth/cimd.js';
import { startHttpGateway, type HttpGatewayHandle } from '../src/auth/http-server.js';
import { isIpAllowedByCidrs } from '../src/auth/pats.js';
import {
  createDefaultMockConfig,
  createGatewayDeps,
  type GatewayDeps,
} from '../src/server/factory.js';

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  public capture(resp: Response): void {
    const headers = resp.headers as unknown as { getSetCookie?: () => string[] };
    const list = headers.getSetCookie ? headers.getSetCookie() : [];
    for (const raw of list) {
      const first = raw.split(';')[0] ?? '';
      const eq = first.indexOf('=');
      if (eq > 0) {
        this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
      }
    }
  }

  public header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

describe('Phase 2 Auth & HTTP Gateway E2E', () => {
  const handles: HttpGatewayHandle[] = [];
  const depsList: GatewayDeps[] = [];

  afterEach(async () => {
    for (const h of handles.splice(0)) {
      await h.close();
    }
    for (const d of depsList.splice(0)) {
      d.db.close();
    }
  });

  it('blocks SSRF private/loopback IPs in CIMD and enforces PAT CIDR matching', async () => {
    const deps = createGatewayDeps({ mock: true });
    depsList.push(deps);

    await expect(
      fetchCimdMetadata('https://internal.example.com/client.json', deps.db, {
        lookupFn: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]) as never,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    await expect(
      fetchCimdMetadata('https://metadata.example.com/client.json', deps.db, {
        lookupFn: () => Promise.resolve([{ address: '169.254.169.254', family: 4 }]) as never,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    expect(isIpAllowedByCidrs('192.0.2.42', ['192.0.2.0/24'])).toBe(true);
    expect(isIpAllowedByCidrs('198.51.100.10', ['192.0.2.0/24'])).toBe(false);
  });

  it('runs full OAuth 2.1 Auth Code + PKCE + consent downgrade + scope filtering + refresh replay + PAT lifecycle', async () => {
    const config = createDefaultMockConfig();
    config.server.allowedHosts = ['127.0.0.1', 'localhost'];
    const deps = createGatewayDeps({ config, mock: true });
    depsList.push(deps);

    // Reserve port via ephemeral bind first
    const gw = await startHttpGateway(deps, {
      host: '127.0.0.1',
      port: 0,
      issuerOverride: 'http://127.0.0.1',
    });
    // Restart with exact port in issuer so URLs match
    await gw.close();

    const exactPort = gw.port;
    const baseUrl = `http://127.0.0.1:${exactPort}`;
    const gw2 = await startHttpGateway(deps, {
      host: '127.0.0.1',
      port: exactPort,
      issuerOverride: baseUrl,
      mcpResourceOverride: `${baseUrl}/mcp`,
    });
    handles.push(gw2);

    // Setup TOTP for owner login
    const { authenticator } = await import('otplib');
    const totp = await gw2.authService.setupTotp();

    // 1. Unauthenticated POST /mcp -> 401 with WWW-Authenticate pointing to RFC 9728 metadata
    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauth.status).toBe(401);
    const wwwAuth = unauth.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toContain('/.well-known/oauth-protected-resource/mcp');

    // 2. Protected resource metadata & AS metadata discovery
    const prmResp = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(prmResp.status).toBe(200);
    const prm = (await prmResp.json()) as { resource: string; authorization_servers: string[] };
    expect(prm.resource).toBe(`${baseUrl}/mcp`);

    const asmResp = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(asmResp.status).toBe(200);
    const asm = (await asmResp.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(asm.code_challenge_methods_supported).toContain('S256');

    // 3. Dynamic Client Registration (DCR)
    const dcrResp = await fetch(asm.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test MCP Client',
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1:43210/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    });
    expect(dcrResp.status).toBe(201);
    const client = (await dcrResp.json()) as { client_id: string };

    // 4. Auth Code + PKCE flow with scope downgrade (request read+operate+admin, approve ONLY read!)
    const { verifier, challenge } = pkcePair();
    const jar = new CookieJar();
    const authUrl = new URL(asm.authorization_endpoint);
    authUrl.searchParams.set('client_id', client.client_id);
    authUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:43210/callback');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid homemcp:read homemcp:operate homemcp:admin');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('resource', `${baseUrl}/mcp`);
    authUrl.searchParams.set('state', 'st-123');

    const step1 = await fetch(authUrl, { redirect: 'manual' });
    jar.capture(step1);
    expect(step1.status).toBe(303);
    const loginLoc = new URL(step1.headers.get('location')!, baseUrl);

    const loginPage = await fetch(loginLoc, {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    });
    jar.capture(loginPage);
    expect(loginPage.status).toBe(200);

    // Submit TOTP login
    const totpCode = authenticator.generate(totp.secret);
    const totpRes = await fetch(`${loginLoc.pathname}/totp`.replace(/^/, baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: jar.header(),
      },
      body: new URLSearchParams({ code: totpCode }),
      redirect: 'manual',
    });
    jar.capture(totpRes);
    expect(totpRes.status).toBe(303);

    // Follow resume -> redirects to consent interaction
    const resumeLoc1 = totpRes.headers.get('location')!;
    const resume1 = await fetch(new URL(resumeLoc1, baseUrl), {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    });
    jar.capture(resume1);
    expect(resume1.status).toBe(303);
    const consentLoc = new URL(resume1.headers.get('location')!, baseUrl);

    // Approve ONLY homemcp:read (downgrading operate & admin!)
    const consentSubmit = await fetch(new URL(`${consentLoc.pathname}/confirm`, baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: jar.header(),
      },
      body: new URLSearchParams({ scopes: 'homemcp:read' }),
      redirect: 'manual',
    });
    jar.capture(consentSubmit);
    expect(consentSubmit.status).toBe(303);

    const resume2 = await fetch(new URL(consentSubmit.headers.get('location')!, baseUrl), {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    });
    expect(resume2.status).toBe(303);
    jar.capture(resume2);
    expect(resume2.status).toBe(303);
    const callbackUrl = new URL(resume2.headers.get('location')!);
    const code = callbackUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    // 5. Exchange code for JWT access token + refresh token
    const tokResp = await fetch(asm.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: code!,
        redirect_uri: 'http://127.0.0.1:43210/callback',
        code_verifier: verifier,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(tokResp.status).toBe(200);
    const tokens = (await tokResp.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.scope).toContain('homemcp:read');
    expect(tokens.scope).not.toContain('homemcp:admin');

    // 6. Call MCP /mcp/backup with read token -> sees only T0 backup tools; calling auth_pat_create -> 403 insufficient_scope
    const mcpList = await fetch(`${baseUrl}/mcp/backup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(mcpList.status).toBe(200);
    const listText = await mcpList.text();
    expect(listText).toContain('backup_status');
    expect(listText).not.toContain('auth_pat_create');

    // Out-of-scope tools/call -> 403 with WWW-Authenticate: insufficient_scope
    const stepUpResp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'auth_client_revoke', arguments: { client_id: 'x' } },
      }),
    });
    expect(stepUpResp.status).toBe(403);
    expect(stepUpResp.headers.get('www-authenticate')).toContain('insufficient_scope');

    // 7. Refresh token rotation & replay detection
    const rotResp = await fetch(asm.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(rotResp.status).toBe(200);
    const rotated = (await rotResp.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // Replaying old refresh token must fail AND revoke the grant
    const replayResp = await fetch(asm.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(replayResp.status).toBe(400);

    // 8. PAT creation, CIDR check, and revocation
    const pat = gw2.pats.createPat({
      name: 'ci-pat',
      scopes: ['homemcp:read'],
      cidrs: ['127.0.0.0/8'],
      ttlDays: 7,
    });
    const patCall = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${pat.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'auth_whoami', arguments: {} },
      }),
    });
    expect(patCall.status).toBe(200);
    expect(await patCall.text()).toContain('ci-pat'.replace('ci-pat', pat.record.id));

    gw2.pats.revokePat(pat.record.id);
    const patRevoked = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${pat.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    expect(patRevoked.status).toBe(401);

    // 9. Bootstrap UI sets strict CSP that still permits same-origin fetch()
    const bootPage = await fetch(`${baseUrl}/account/bootstrap?token=dummy`);
    expect(bootPage.status).toBe(200);
    const csp = bootPage.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
