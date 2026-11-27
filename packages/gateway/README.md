# `@homemcp/gateway`

The unprivileged `homemcp` MCP server, OAuth 2.1 + WebAuthn passkey identity server, SQLite state store, alert watcher, and 15 tool modules.

## Components

- **CLI (`src/cli.ts`):** Runs `serve` (HTTP + SSE/Streamable MCP + OAuth UI), `stdio` (local transport), or `auth bootstrap` (passkey/TOTP/recovery setup), with `--mock` support for local development.
- **MCP Server (`src/server/factory.ts`, `src/server/registry.ts`):** Supports global `/mcp` and dynamic toolset-filtered `/mcp/<toolsets>` routing, strict Zod input/output schemas, centralized `Redactor`, scope checks, and audit logging.
- **Modules (`src/modules/`):** 141 tools across `core`, `system`, `docker`, `stacks`, `network`, `backup`, `vaultwarden`, `apps`, `music`, `naviload`, `media`, `downloads`, `alerts`, `files`, and `auth`.
- **Auth & Step-Up (`src/auth/`):** OAuth 2.1 Authorization Code + PKCE (`oidc-provider`), Client ID Metadata Documents (CIMD), DCR, WebAuthn (`@simplewebauthn/server`), TOTP (`otplib`), Personal Access Tokens (PATs), and fresh-passkey `auth_time` checks for `T3` actions.
- **Background Orchestration (`src/jobs/`, `src/watcher/`):** Async job runner, two-step `PlanManager` + `ConfirmationGate`, saga rollback coordinator, and threshold/offline-ntfy alert watcher backed by SQLite migrations (`src/db/migrations/`).

## Quick Run

```bash
pnpm --filter @homemcp/gateway build
node packages/gateway/dist/cli.js serve --transport stdio --mock
```
