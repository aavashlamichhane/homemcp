# `@homemcp/mock`

Stateful in-memory mock executor and HTTP connector implementations used for local testing, demos, integration tests, and automated evals (`pnpm eval`).

## Contents

- **`fixtures.ts` (`createMockState`):** Seeds realistic server state (`homelab-01`, `192.0.2.10`) including Docker containers (`navidrome`, `jellyfin`, `vaultwarden`, `cloudflared-cloudflared-1`), synthetic secrets to test redaction, Compose stacks, Cloudflare Tunnel + NPM routes, Restic/R2 backup snapshots & stats, music library & playlists, Jellyfin items, and qBittorrent torrents.
- **`mock-executor.ts` (`MockExecutor`):** Implements all `@homemcp/agent` verbs in memory, mutating `MockState` safely (container updates, backup runs/tests/staging restores/prunes, soft-trash file operations, stack policy validation).
- **`mock-connectors.ts`:** In-memory implementations of Docker, NPM, Cloudflare, Vaultwarden `/alive`, HTTP probes, Navidrome Subsonic, NaviLoad, Jellyfin, qBittorrent, `ntfy`, and Healthchecks.io.

## Usage

Run the gateway without a Linux server or Docker daemon:

```bash
node packages/gateway/dist/cli.js serve --mock --port 8790
```
