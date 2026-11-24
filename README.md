# homemcp

An authenticated, least-privilege **Model Context Protocol (MCP)** server for safely managing a Linux & Docker homelab server.

> **Security-first architecture:** an unprivileged gateway container talks to a privilege-separated systemd host agent (`homemcpd`) over an HMAC-authenticated Unix socket with typed, allowlisted verbs — never arbitrary shell execution, never SSH-from-AI, never unguarded Docker socket access.

---

## Architecture Overview

```
MCP Client (Antigravity / Claude / VS Code)
   │ HTTPS + OAuth 2.1 (PKCE S256, ES256 JWT, RFC 8707 aud) or hmp_ PAT
   ▼
Cloudflare Tunnel ──► homemcp Gateway (unprivileged Docker container, read_only: true)
                         ├── MCP Streamable HTTP (/mcp, /mcp/:toolsets) + Stdio
                         ├── 5-layer Redactor + SQLite Audit Log + AlertWatcher
                         ├── PlanManager + ConfirmationGate (elicitation / WebAuthn /confirm/:id)
                         ├── Read-only Docker Socket Proxy (POST=0)
                         ├── Service Connectors (Navidrome, NaviLoad, Jellyfin, qBittorrent, NPM, CF, Vaultwarden, ntfy)
                         └── HMAC-SHA256 Unix Socket ──► homemcpd (systemd host agent, allowlisted verbs)
```

## Key Features

- **Privilege Separation:** The gateway has no host shell or docker CLI. All host operations go through `homemcpd` typed Zod-validated verbs (`execa` with `shell: false`).
- **5-Layer Secret Redaction:** Exact registered config values, key-name scrubbing (`token`, `password`, `secret`, etc.), regexes (tunnel JWTs, `Authorization`, PEM keys, PATs), Shannon entropy scanning, and `.env`/`.key`/`.pem` read deny-lists.
- **Tiers & Scopes:** Every tool has `T0`–`T3` risk tier, `homemcp:read | operate | admin | audit` scope, strict Zod input/output schemas, and MCP annotations.
- **Plan / Apply & Out-of-Band Passkey Confirmation:** Tier 2 and Tier 3 mutations require explicit plans with diffs/rollbacks (`10m` expiry, SHA-256 hash check) and human confirmation (`/confirm/:id` passkey assertion for T3).
- **Dynamic Toolset Routing:** Connect to `/mcp` for all enabled tools or `/mcp/music,naviload` to reduce tool schema overhead by ~79%.
- **Curated Stack Templates & Compose Policy Engine:** Deploy `uptime-kuma`, `it-tools`, `ntfy`, `searxng`, `shlink`, `actual-budget`, or `homepage` with dual-enforced policy validation and auto-generated secrets written directly to `0600` `.env`.

## Quickstart in Mock Mode (60 Seconds)

Run locally without touching any live server (uses `packages/mock` stateful homelab fixtures):

```bash
corepack enable
pnpm install
pnpm build
pnpm test
pnpm eval
```

Start the mock gateway over HTTP (`http://127.0.0.1:8790`):

```bash
node packages/gateway/dist/cli.js serve --transport http --mock --port 8790
```

Or run stdio mode:

```bash
node packages/gateway/dist/cli.js serve --transport stdio --mock
```

## Documentation

- [Tools, Resources & Prompts Reference](docs/tools.md) *(auto-generated)*
- [Architecture](docs/architecture.md)
- [Threat Model & Controls](docs/threat-model.md)
- [Authentication & OAuth 2.1](docs/auth.md)
- [Production Deployment](docs/deployment.md)
- [Client Setup](docs/clients.md)
- [Evaluation Results](docs/evals.md)
- [Operational Runbooks](docs/runbooks/)
