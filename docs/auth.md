# Authentication & OAuth 2.1

`homemcp` includes a built-in OAuth 2.1 / OIDC Authorization Server (`oidc-provider` v9) mounted under `/oauth` alongside RFC 9728 Protected Resource Metadata:

## Flows Supported

1. **Client ID Metadata Documents (CIMD):** HTTPS `client_id` URLs resolved via SSRF-safe DNS/IP filtering (blocking loopback, RFC 1918 private, link-local, CGNAT, and ULA ranges) with `Cache-Control` caching (`cimd_cache`).
2. **Dynamic Client Registration (`POST /oauth/register`):** Rate-limited to 10 registrations/hour per IP.
3. **Authorization Code + PKCE (`S256`) + Resource Indicators (RFC 8707):** Issued ES256 JWT access tokens carry `aud: https://homemcp.example.com/mcp`, `sub`, `scope`, `auth_time`, and `exp` (15m default). Refresh tokens rotate on every exchange and revoke the entire grant on replay.
4. **Owner Authentication (`/oauth/interaction/:uid`, `/account/bootstrap`, `/confirm/:id`):** WebAuthn Passkeys (`@simplewebauthn/server` v14) primary + TOTP (`otplib` v12) & 10 recovery codes fallback, with 5-attempt / 15-minute lockout, consent-screen scope downgrade, strict CSP (`default-src 'none'; connect-src 'self'; ...`), and `HttpOnly; SameSite=Lax; Secure` (on HTTPS) session cookies.
5. **Personal Access Tokens (`hmp_` prefix):** Argon2id hashed at rest, scoped by `scopes`, optional `toolsets`, optional IPv4/IPv6 CIDR allowlists (`CF-Connecting-IP` honored when `trustProxy: true`), and one-time browser reveal (`/account/pat-reveal/:id`).

## Scopes & HTTP 403 Step-Up

- `homemcp:read` — Tier 0 read-only tools & resources
- `homemcp:operate` — Tier 0 + Tier 1 non-destructive actions
- `homemcp:admin` — Tier 0–3 (additionally gated by `/confirm/:id` passkey for T3)
- `homemcp:audit` — `audit_query` & `homemcp://audit/recent`

Out-of-scope `tools/call` requests return HTTP `403 Forbidden` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`.
