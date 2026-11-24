# `@homemcp/agent` (`homemcpd`)

Privileged Linux host agent exposing a strictly allowlisted set of typed, Zod-validated verbs over a Unix domain socket (`/run/homemcpd/homemcpd.sock`).

## Security Design

- **No arbitrary shell:** All host commands run through `ExecaCommandRunner` (`shell: false`) with an explicit binary allowlist (`AGENT_ALLOWED_BINARIES`).
- **HMAC request signing (`src/auth.ts`):** Every call requires an `x-homemcp-ts`, `x-homemcp-nonce`, and `x-homemcp-sig` HMAC-SHA256 signature verified with constant-time comparison and a 30-second anti-replay window.
- **Verb modules (`src/verbs/`):**
  - `system-read.ts`: Health, `sadf` metrics, disks/SMART, processes, journald logs, security audit, updates, allowlisted systemd unit status.
  - `stacks-read.ts`: Scan compose projects under configured roots, policy check, `.env` metadata-only inspection (never reads secret contents).
  - `backup-read.ts` & `backup-actions.ts`: Read `/var/lib/homemcp/backup/*.json`, run `homemcp-backup` sets, trigger Vaultwarden restore tests, isolate staging restores, and prune expired snapshots.
  - `ops-write.ts` & `stacks-files-write.ts`: Safe Docker/systemd actions, Compose writes/up/down, root-confined file operations, and soft-delete moves to `.trash/`.

## Development

```bash
pnpm --filter @homemcp/agent build
pnpm --filter @homemcp/agent typecheck
```
