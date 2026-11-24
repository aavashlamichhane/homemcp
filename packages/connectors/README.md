# `@homemcp/connectors`

Typed HTTP and Unix-socket connectors linking `homemcp` gateway modules to homelab infrastructure and service APIs.

## Included Clients

- **`AgentClient` (`src/agent-client.ts`):** HMAC-SHA256 + timestamp/nonce authenticated client for calling `homemcpd` over `/run/homemcpd/homemcpd.sock`.
- **`DockerConnector` (`src/docker.ts`) & `RegistryClient` (`src/registry.ts`):** Container inspection, stats, logs, lifecycle actions, and digest/tag lookups via `docker-socket-proxy` and container registries.
- **Ingress & DNS (`src/npm.ts`, `src/cloudflare.ts`):** Nginx Proxy Manager proxy host client and Cloudflare Tunnel + DNS CNAME client.
- **Security & Probes (`src/vaultwarden.ts`, `src/http-probe.ts`):** Vaultwarden `/alive` health + upstream version delta checks and configurable app HTTP probes.
- **Media & Music (`src/subsonic.ts`, `src/track-matcher.ts`, `src/naviload.ts`, `src/jellyfin.ts`, `src/qbittorrent.ts`):** Navidrome Subsonic client, fuzzy track matching, NaviLoad downloader client, Jellyfin REST API, and qBittorrent WebUI client.
- **Alerting (`src/ntfy.ts`, `src/healthchecks.ts`):** Push alerts via `ntfy` and dead-man pings via Healthchecks.io.

## Development

```bash
pnpm --filter @homemcp/connectors build
pnpm --filter @homemcp/connectors typecheck
```
