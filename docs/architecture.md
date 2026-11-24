# Architecture

`homemcp` splits responsibilities across five workspace packages so unprivileged MCP protocol handling is isolated from host OS privileges:

## Packages

| Package | Responsibility |
|---|---|
| `@homemcp/core` | Zod config validation (`env:` resolution), 5-layer `Redactor`, `HomemcpError`, `tiers`/`scopes`, safe symlink-aware `resolveSafePath`, and `validateComposePolicy`. |
| `@homemcp/connectors` | Typed HTTP/socket connectors with timeouts & error mapping (`docker`, `registry`, `npm`, `cloudflare`, `vaultwarden`, `http-probe`, `subsonic`, `track-matcher`, `naviload`, `jellyfin`, `qbittorrent`, `ntfy`, `healthchecks`). |
| `@homemcp/agent` | `homemcpd` host daemon listening on Unix socket `0660` with HMAC-SHA256 request signing (±30s clock skew + 60s nonce replay cache) and allowlisted verbs. |
| `@homemcp/gateway` | MCP server (`@modelcontextprotocol/server`, Express + Node 24 `node:sqlite`), built-in OAuth 2.1 + WebAuthn/TOTP/PAT auth, `JobRunner`, `PlanManager`, `ConfirmationGate`, `SagaRunner`, `AlertWatcher`, and all 15 toolset modules. |
| `@homemcp/mock` | Stateful synthetic homelab fixtures (`homelab-01`, `192.0.2.10`, `example.com`), `MockExecutor`, and mock connectors for fast local development and evals. |

## Network & Privilege Isolation

- **Gateway container (`homemcp`)**: `user: 1000:1000`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges: true`, zero published host ports.
- **Docker visibility**: via `tecnativa/docker-socket-proxy` (`POST=0`, internal network only) so the gateway cannot mutate Docker directly.
- **Host operations**: via `homemcpd` Unix socket mounted into the gateway container (`/run/homemcpd/homemcpd.sock`), enforcing compose policy and `.env` read denial inside the agent independently of gateway checks.
