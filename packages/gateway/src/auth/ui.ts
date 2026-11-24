import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import express, { type Express, type Request, type Response } from 'express';
import type Provider from 'oidc-provider';
import { ALL_SCOPES, type HomemcpConfig, type Scope } from '@homemcp/core';
import type { HomemcpDb } from '../db/database.js';
import { listOAuthClients, revokeOAuthClientAndGrants } from './adapter.js';
import type { PatManager } from './pats.js';
import type { OwnerAuthService } from './webauthn.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function signSessionCookie(
  payload: { sub: string; authTime: number; csrf: string; exp: number },
  secretKey: string,
): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', `sess:${secretKey}`).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionCookie(
  cookieVal: string | undefined,
  secretKey: string,
): { sub: string; authTime: number; csrf: string; exp: number } | null {
  if (!cookieVal) return null;
  const [data, sig] = cookieVal.split('.');
  if (!data || !sig) return null;
  const expected = createHmac('sha256', `sess:${secretKey}`).update(data).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as {
      sub: string;
      authTime: number;
      csrf: string;
      exp: number;
    };
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function renderLayout(title: string, body: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} — homemcp</title>
  <style nonce="${nonce}">
    body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:2rem}
    .card{max-width:560px;margin:2rem auto;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem}
    h1,h2{margin-top:0;color:#f8fafc}
    button,.btn{background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:.65rem 1.1rem;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
    button.danger{background:#dc2626}
    input[type=text],input[type=password]{width:100%;padding:.55rem;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#f8fafc;margin:.35rem 0 1rem;box-sizing:border-box}
    label.scope{display:flex;gap:.5rem;align-items:center;padding:.45rem 0}
    code,pre{background:#0f172a;padding:.25rem .45rem;border-radius:6px;overflow:auto}
    .muted{color:#94a3b8;font-size:.9rem}
    .err{color:#fca5a5;margin:.5rem 0}
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

const WEBAUTHN_HELPER_JS = `
async function b64uToBuf(s){const b=s.replace(/-/g,'+').replace(/_/g,'/');const pad='='.repeat((4-b.length%4)%4);const raw=atob(b+pad);return Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer;}
function bufToB64u(buf){const bytes=new Uint8Array(buf);let bin='';for(const b of bytes)bin+=String.fromCharCode(b);return btoa(bin).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
async function runPasskeyReg(beginUrl, finishUrl, nameInputId, extraBody){
  const r1=await fetch(beginUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(extraBody||{})});
  const opts=await r1.json();
  if(!r1.ok)throw new Error(opts.error||'Registration start failed');
  opts.challenge=await b64uToBuf(opts.challenge);
  opts.user.id=await b64uToBuf(opts.user.id);
  if(opts.excludeCredentials){opts.excludeCredentials=await Promise.all(opts.excludeCredentials.map(async c=>({...c,id:await b64uToBuf(c.id)})));}
  const cred=await navigator.credentials.create({publicKey:opts});
  const payload={id:cred.id,rawId:bufToB64u(cred.rawId),type:cred.type,response:{clientDataJSON:bufToB64u(cred.response.clientDataJSON),attestationObject:bufToB64u(cred.response.attestationObject),transports:cred.response.getTransports?cred.response.getTransports():[]}};
  const r2=await fetch(finishUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...extraBody,response:payload,name:document.getElementById(nameInputId)?.value||'Passkey'})});
  const j=await r2.json();if(!r2.ok)throw new Error(j.error||'Registration verify failed');return j;
}
async function runPasskeyAuth(beginUrl, finishUrl, extraBody){
  const r1=await fetch(beginUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(extraBody||{})});
  const opts=await r1.json();
  if(!r1.ok)throw new Error(opts.error||'Auth start failed');
  opts.challenge=await b64uToBuf(opts.challenge);
  if(opts.allowCredentials){opts.allowCredentials=await Promise.all(opts.allowCredentials.map(async c=>({...c,id:await b64uToBuf(c.id)})));}
  const cred=await navigator.credentials.get({publicKey:opts});
  const payload={id:cred.id,rawId:bufToB64u(cred.rawId),type:cred.type,response:{clientDataJSON:bufToB64u(cred.response.clientDataJSON),authenticatorData:bufToB64u(cred.response.authenticatorData),signature:bufToB64u(cred.response.signature),userHandle:cred.response.userHandle?bufToB64u(cred.response.userHandle):null}};
  const r2=await fetch(finishUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...extraBody,response:payload})});
  const j=await r2.json();if(!r2.ok)throw new Error(j.error||'Auth verify failed');return j;
}`;

export function registerAuthUiRoutes(
  app: Express,
  deps: {
    db: HomemcpDb;
    config: HomemcpConfig;
    provider: Provider;
    authService: OwnerAuthService;
    pats: PatManager;
    mcpResourceUrl: string;
  },
): void {
  const { db, config, provider, authService, pats } = deps;

  app.use((req, res, next) => {
    if (req.path.startsWith('/oauth/interaction') || req.path.startsWith('/account')) {
      const nonce = randomBytes(16).toString('base64');
      res.locals['cspNonce'] = nonce;
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'`,
      );
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    next();
  });

  const setSession = (res: Response, authTime: number) => {
    const csrf = randomBytes(16).toString('hex');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const val = signSessionCookie({ sub: 'owner', authTime, csrf, exp }, config.auth.secretKey);
    res.setHeader(
      'Set-Cookie',
      `homemcp_sess=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
    );
    return csrf;
  };

  const getSession = (req: Request) =>
    verifySessionCookie(parseCookies(req)['homemcp_sess'], config.auth.secretKey);

  // 1) Bootstrap page
  app.get('/account/bootstrap', (req, res) => {
    const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
    const nonce = String(res.locals['cspNonce'] ?? '');
    if (!token) {
      res.status(400).send(renderLayout('Bootstrap', '<p class="err">Missing bootstrap token.</p>', nonce));
      return;
    }
    const html = renderLayout(
      'Owner Bootstrap',
      `<h1>Bootstrap homemcp Owner</h1>
      <p class="muted">Register your primary Passkey and set up TOTP + recovery codes.</p>
      <label>Passkey Name<input id="pk-name" type="text" value="Primary Passkey" /></label>
      <button id="btn-reg">Register Passkey & Setup TOTP</button>
      <div id="out"></div>
      <script nonce="${nonce}">${WEBAUTHN_HELPER_JS}
      document.getElementById('btn-reg').onclick=async()=>{
        try{
          const r=await runPasskeyReg('/account/bootstrap/webauthn/begin','/account/bootstrap/webauthn/finish','pk-name',{token:${JSON.stringify(token)}});
          document.getElementById('out').innerHTML='<h2>TOTP & Recovery Codes</h2><p>Scan QR in authenticator app:</p><img src="'+r.totp.qrDataUrl+'" alt="TOTP QR" /><p>Secret: <code>'+r.totp.secret+'</code></p><pre>'+r.totp.recoveryCodes.join('\\n')+'</pre><p><a class="btn" href="/account">Go to Account Portal</a></p>';
        }catch(e){document.getElementById('out').innerHTML='<p class="err">'+e.message+'</p>';}
      };</script>`,
      nonce,
    );
    res.type('html').send(html);
  });

  app.post('/account/bootstrap/webauthn/begin', express.json(), async (req, res) => {
    try {
      const token = String((req.body as { token?: string })?.token ?? '');
      if (!token) {
        res.status(400).json({ error: 'Missing token' });
        return;
      }
      const options = await authService.beginPasskeyRegistration(`boot:${token.slice(0, 12)}`);
      res.json(options);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  app.post('/account/bootstrap/webauthn/finish', express.json(), async (req, res) => {
    try {
      const body = req.body as {
        token?: string;
        name?: string;
        response?: RegistrationResponseJSON;
      };
      if (!body.token || !body.response || !pats.consumeBootstrapToken(body.token)) {
        res.status(403).json({ error: 'Invalid or expired bootstrap token' });
        return;
      }
      const key = await authService.finishPasskeyRegistration(
        `boot:${body.token.slice(0, 12)}`,
        body.response,
        body.name ?? 'Primary Passkey',
      );
      const totp = await authService.setupTotp();
      setSession(res, Math.floor(Date.now() / 1000));
      res.json({ ok: true, credentialId: key.credential_id, totp });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  // 2) OIDC Interaction: Login & Consent
  app.get('/oauth/interaction/:uid', async (req, res) => {
    const nonce = String(res.locals['cspNonce'] ?? '');
    try {
      const details = await provider.interactionDetails(req, res);
      const { uid, prompt, params } = details;
      const clientId = typeof params['client_id'] === 'string' ? params['client_id'] : 'unknown';

      if (prompt.name === 'login') {
        const html = renderLayout(
          'Sign In',
          `<h1>Sign in to homemcp</h1>
          <p class="muted">Client: <code>${escapeHtml(clientId)}</code></p>
          <button id="btn-pk">Sign in with Passkey</button>
          <p id="pk-err" class="err"></p>
          <hr />
          <form method="post" action="/oauth/interaction/${escapeHtml(uid)}/totp">
            <label>Or TOTP / Recovery Code<input name="code" type="text" autocomplete="one-time-code" required /></label>
            <button type="submit">Verify Code</button>
          </form>
          <script nonce="${nonce}">${WEBAUTHN_HELPER_JS}
          document.getElementById('btn-pk').onclick=async()=>{
            try{
              const r=await runPasskeyAuth('/oauth/interaction/${encodeURIComponent(uid)}/webauthn/begin','/oauth/interaction/${encodeURIComponent(uid)}/webauthn/finish',{});
              if(r.redirectTo)location.href=r.redirectTo;
            }catch(e){document.getElementById('pk-err').textContent=e.message;}
          };</script>`,
          nonce,
        );
        res.type('html').send(html);
        return;
      }

      if (prompt.name === 'consent') {
        const reqScopeStr = typeof params['scope'] === 'string' ? params['scope'] : 'homemcp:read';
        const reqScopes = reqScopeStr.split(/\s+/).filter(Boolean);
        const homemcpScopes = ALL_SCOPES.filter((s) => reqScopes.includes(s));
        const scopesToShow = homemcpScopes.length > 0 ? homemcpScopes : ['homemcp:read'];
        const redirectUri =
          typeof params['redirect_uri'] === 'string' ? params['redirect_uri'] : '';

        const checkboxes = scopesToShow
          .map(
            (s) =>
              `<label class="scope"><input type="checkbox" name="scopes" value="${escapeHtml(s)}" checked /> <code>${escapeHtml(s)}</code></label>`,
          )
          .join('');

        const html = renderLayout(
          'Authorize Access',
          `<h1>Authorize Client</h1>
          <p><strong>Client:</strong> <code>${escapeHtml(clientId)}</code></p>
          <p class="muted">Redirect URI: <code>${escapeHtml(redirectUri)}</code></p>
          <form method="post" action="/oauth/interaction/${escapeHtml(uid)}/confirm">
            <h3>Permitted Scopes (untick to downgrade)</h3>
            ${checkboxes}
            <br />
            <button type="submit">Approve</button>
          </form>
          <form method="post" action="/oauth/interaction/${escapeHtml(uid)}/abort" style="margin-top:.75rem">
            <button type="submit" class="danger">Deny</button>
          </form>`,
          nonce,
        );
        res.type('html').send(html);
        return;
      }

      res.status(400).send(renderLayout('Interaction', `<p>Unsupported prompt: ${escapeHtml(prompt.name)}</p>`, nonce));
    } catch (err) {
      res.status(400).send(renderLayout('Error', `<p class="err">${escapeHtml(err instanceof Error ? err.message : 'Interaction error')}</p>`, nonce));
    }
  });

  app.post('/oauth/interaction/:uid/webauthn/begin', async (req, res) => {
    try {
      const uid = String(req.params['uid']);
      const options = await authService.beginPasskeyAuthentication(`oidc:${uid}`);
      res.json(options);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  app.post('/oauth/interaction/:uid/webauthn/finish', express.json(), async (req, res) => {
    try {
      const uid = String(req.params['uid']);
      const body = req.body as { response?: AuthenticationResponseJSON };
      if (!body.response) {
        res.status(400).json({ error: 'Missing assertion' });
        return;
      }
      const verified = await authService.finishPasskeyAuthentication(`oidc:${uid}`, body.response);
      setSession(res, verified.authTime);
      const redirectTo = await provider.interactionResult(
        req,
        res,
        { login: { accountId: 'owner', ts: verified.authTime } },
        { mergeWithLastSubmission: false },
      );
      res.json({ ok: true, redirectTo });
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : 'Auth failed' });
    }
  });

  app.post(
    '/oauth/interaction/:uid/totp',
    express.urlencoded({ extended: false }),
    async (req, res) => {
      try {
        const code = String((req.body as { code?: string })?.code ?? '');
        const ok = await authService.verifyTotpOrRecovery(code);
        if (!ok) {
          res.status(403).send('Invalid TOTP or recovery code');
          return;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        setSession(res, nowSec);
        await provider.interactionFinished(
          req,
          res,
          { login: { accountId: 'owner', ts: nowSec } },
          { mergeWithLastSubmission: false },
        );
      } catch (err) {
        res.status(403).send(err instanceof Error ? err.message : 'TOTP error');
      }
    },
  );

  app.post(
    '/oauth/interaction/:uid/confirm',
    express.urlencoded({ extended: false }),
    async (req, res) => {
      try {
        const details = await provider.interactionDetails(req, res);
        const rawScopes = (req.body as { scopes?: string | string[] })?.scopes;
        const selected = Array.isArray(rawScopes)
          ? rawScopes
          : typeof rawScopes === 'string'
            ? [rawScopes]
            : [];
        const allowed = selected.filter((s): s is Scope =>
          (ALL_SCOPES as readonly string[]).includes(s),
        );

        const grant = details.grantId
          ? await provider.Grant.find(details.grantId)
          : new provider.Grant({
              accountId: details.session?.accountId ?? 'owner',
              clientId: String(details.params['client_id']),
            });
        if (!grant) {
          res.status(400).send('Grant not found');
          return;
        }

        const reqScopeStr = typeof details.params['scope'] === 'string' ? details.params['scope'] : '';
        const requestedTokens = reqScopeStr.split(/\s+/).filter(Boolean);
        const oidcScopes = requestedTokens.filter((s) => s === 'openid' || s === 'offline_access');
        if (oidcScopes.length > 0) {
          grant.addOIDCScope(oidcScopes.join(' '));
        }
        const missingClaims = (details.prompt.details as { missingOIDCClaims?: string[] })
          .missingOIDCClaims;
        if (Array.isArray(missingClaims) && missingClaims.length > 0) {
          grant.addOIDCClaims(missingClaims);
        }

        const grantWithReject = grant as unknown as {
          rejectOIDCScope?: (scope: string) => void;
          rejectResourceScope?: (resource: string, scope: string) => void;
        };

        if (allowed.length > 0) {
          grant.addResourceScope(deps.mcpResourceUrl, allowed.join(' '));
        }
        const requestedHomemcp = requestedTokens.filter((s): s is Scope =>
          (ALL_SCOPES as readonly string[]).includes(s),
        );
        const rejected = requestedHomemcp.filter((s) => !allowed.includes(s));
        if (rejected.length > 0) {
          grantWithReject.rejectResourceScope?.(deps.mcpResourceUrl, rejected.join(' '));
          grantWithReject.rejectOIDCScope?.(rejected.join(' '));
        }

        const grantId = await grant.save();
        await provider.interactionFinished(
          req,
          res,
          { consent: { grantId } },
          { mergeWithLastSubmission: true },
        );
      } catch (err) {
        res.status(400).send(err instanceof Error ? err.message : 'Consent error');
      }
    },
  );

  app.post('/oauth/interaction/:uid/abort', async (req, res) => {
    await provider.interactionFinished(
      req,
      res,
      { error: 'access_denied', error_description: 'Owner denied request' },
      { mergeWithLastSubmission: false },
    );
  });

  // 3) Account management & one-time PAT reveal
  app.get('/account', (req, res) => {
    const nonce = String(res.locals['cspNonce'] ?? '');
    const sess = getSession(req);
    if (!sess) {
      res.type('html').send(
        renderLayout(
          'Account Login',
          `<h1>homemcp Account Portal</h1>
          <button id="btn-login">Sign in with Passkey</button>
          <p id="err" class="err"></p>
          <script nonce="${nonce}">${WEBAUTHN_HELPER_JS}
          document.getElementById('btn-login').onclick=async()=>{
            try{await runPasskeyAuth('/account/webauthn/begin','/account/webauthn/finish',{});location.reload();}
            catch(e){document.getElementById('err').textContent=e.message;}
          };</script>`,
          nonce,
        ),
      );
      return;
    }

    const keys = authService.listPasskeys();
    const clients = listOAuthClients(db);
    const patList = pats.listPats();
    res.type('html').send(
      renderLayout(
        'Account Portal',
        `<h1>Account Portal</h1>
        <h2>Passkeys (${keys.length})</h2>
        <ul>${keys.map((k) => `<li>${escapeHtml(k.name)} (<code>${escapeHtml(k.credential_id.slice(0, 12))}...</code>)</li>`).join('')}</ul>
        <h2>OAuth Clients (${clients.length})</h2>
        <ul>${clients
          .map(
            (c) =>
              `<li><code>${escapeHtml(c.client_id)}</code> (${c.source}) <form method="post" action="/account/clients/revoke" style="display:inline"><input type="hidden" name="csrf" value="${sess.csrf}" /><input type="hidden" name="client_id" value="${escapeHtml(c.client_id)}" /><button class="danger" type="submit">Revoke</button></form></li>`,
          )
          .join('')}</ul>
        <h2>PATs (${patList.length})</h2>
        <ul>${patList.map((p) => `<li>${escapeHtml(p.name)} (<code>${escapeHtml(p.prefix)}...</code>) expires ${escapeHtml(p.expires_at)}${p.revoked_at ? ' [REVOKED]' : ''}</li>`).join('')}</ul>`,
        nonce,
      ),
    );
  });

  app.post('/account/webauthn/begin', async (_req, res) => {
    try {
      res.json(await authService.beginPasskeyAuthentication('account'));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  app.post('/account/webauthn/finish', express.json(), async (req, res) => {
    try {
      const body = req.body as { response?: AuthenticationResponseJSON };
      if (!body.response) {
        res.status(400).json({ error: 'Missing assertion' });
        return;
      }
      const verified = await authService.finishPasskeyAuthentication('account', body.response);
      setSession(res, verified.authTime);
      res.json({ ok: true });
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : 'Failed' });
    }
  });

  app.post('/account/clients/revoke', express.urlencoded({ extended: false }), (req, res) => {
    const sess = getSession(req);
    const body = req.body as { csrf?: string; client_id?: string };
    if (!sess || body.csrf !== sess.csrf || !body.client_id) {
      res.status(403).send('Forbidden');
      return;
    }
    revokeOAuthClientAndGrants(db, body.client_id);
    res.redirect('/account');
  });

  app.get('/account/pat-reveal/:id', (req, res) => {
    const nonce = String(res.locals['cspNonce'] ?? '');
    const sess = getSession(req);
    if (!sess) {
      res.status(401).send(renderLayout('Auth Required', '<p>Sign in at <a class="btn" href="/account">/account</a> first.</p>', nonce));
      return;
    }
    const token = pats.consumeOneTimeReveal(String(req.params['id']));
    if (!token) {
      res.status(404).send(renderLayout('Expired', '<p class="err">PAT reveal link expired or already viewed.</p>', nonce));
      return;
    }
    res.type('html').send(
      renderLayout(
        'Reveal PAT',
        `<h1>Personal Access Token</h1>
        <p class="muted">Copy this token now. It will not be shown again.</p>
        <pre>${escapeHtml(token)}</pre>`,
        nonce,
      ),
    );
  });
}
