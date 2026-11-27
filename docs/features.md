# Feature Catalog & Capabilities

`homemcp` exposes **141 MCP tools across 15 toolsets**, **9 MCP resources**, and **8 workflow prompts**, protected by OAuth 2.1 + PKCE, WebAuthn passkeys, risk tiers (`T0`–`T3`), strict Compose policy, and centralized secret redaction.

For an auto-generated, schema-exact table of every tool, resource URI, and prompt, see [docs/tools.md](./tools.md).

---

## Safety Tiers & Scopes

| Tier                          | Required Scope    | Execution Gate                                         | Examples                                                                                                 |
| ----------------------------- | ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **T0** Read / Inspect         | `homemcp:read`    | Immediate                                              | `system_health`, `docker_logs`, `vaultwarden_health`, `vaultwarden_backup_status`                        |
| **T1** Operational            | `homemcp:operate` | Immediate, audited, async jobs                         | `backup_run`, `vaultwarden_backup_run`, `vaultwarden_backup_test`, `music_playlist_create`               |
| **T2** Sensitive State Change | `homemcp:admin`   | Two-step **Plan -> Confirm -> Apply**                  | `docker_update_service`, `npm_proxy_host_upsert`, `vaultwarden_backup_prune_apply`, `files_trash`        |
| **T3** High-Risk / Recovery   | `homemcp:admin`   | Plan + **Fresh Passkey** (`auth_time <= 5m`) + Confirm | `vaultwarden_backup_restore_staging`, `backup_restore`, `expose_apply`, `stacks_remove`, `system_reboot` |

### Scoped Toolset Routing

Clients can connect to `/mcp` for all enabled toolsets or `/mcp/<comma-separated-toolsets>` (for example `/mcp/music,naviload` or `/mcp/vaultwarden,backup`) to cut LLM context overhead and restrict exposed capabilities per chat session.

---

## Feature Categories

### 1. Core Overview, Async Jobs & Capabilities (`core` — 6 tools)

- `homemcp_overview` (`T0`): Unified dashboard aggregating host CPU/RAM/thermal/battery health, running container counts, disk usage, backup freshness vs RPO, pending OS updates, and stale/dead routes.
- `homemcp_capabilities` (`T0`): Lists enabled toolsets, registered tools, connector readiness, caller scopes, and server version.
- `jobs_list`, `jobs_get`, `jobs_cancel` (`T0`/`T1`): Track and cancel long-running background operations (container updates, Restic backups, library scans, download imports).
- `audit_query` (`T0`, `homemcp:audit`): Filters redacted audit log entries by tool, status, or start timestamp.

### 2. Host System & Security (`system` — 13 tools)

- **Live Telemetry (`T0`):** `system_health` (CPU load, RAM/swap, thermal zones, battery/AC status, uptime, reboot-required flag, failed units, OOM kill count), `system_metrics_history` (sysstat `sadf` trends), `system_processes`.
- **Storage & Logs (`T0`):** `system_disks` (filesystems, inodes, growth forecast, SMART summary), `system_smart_details`, `system_logs_query` (journald filtered by unit/priority/grep with untrusted-data fencing), `system_errors_summary` (deduplicated 24h/7d errors).
- **Networking & Patching (`T0`):** `system_network`, `system_updates` (pending apt & security updates), `system_services` (allowlisted systemd units), `system_security_audit` (UFW status, SSH posture, listening sockets, failed logins, Tailscale state).
- **Controlled Mutations:** `system_service_action` (`T2`, start/stop/restart allowlisted systemd units — protected units such as `ssh`, `tailscaled`, and `homemcpd` denied), `system_reboot` (`T3`, passkey-confirmed delayed reboot with `ntfy` notice).

### 3. Docker & Auto-Rollback Updates (`docker` — 12 tools)

- **Inspection (`T0`):** `docker_list_services`, `docker_service_profile` (compose YAML, image digest, env keys only, mounts, health, logs, routes, update status), `docker_logs`, `docker_stats`, `docker_events`, `docker_disk_usage`, `docker_check_updates`.
- **Safe Mutations (`T2`):** `docker_container_action` (start/stop/restart; protected containers require T3 passkey + override), `docker_update_service` (pulls image digest -> 120s health gate -> **automatically rolls back** to prior image digest on failure), `docker_rollback_service` (explicit rollback to a prior digest), `docker_prune_plan` (`T0`) / `docker_prune_apply` (`T2`, never deletes volumes).

### 4. Curated Stacks & Compose Policy (`stacks` — 11 tools)

- **Catalog & Validation (`T0`):** `stacks_templates_list`, `stacks_template_get` (`actual-budget`, `homepage`, `it-tools`, `ntfy`, `searxng`, `shlink`, `uptime-kuma`), `stacks_list`, `stacks_get`, `stacks_validate`.
- **Policy Enforcement:** `validateComposePolicy` rejects `privileged: true`, `network_mode: host`, unsafe capabilities, and disallowed host binds (`docker.sock`, `/etc`, `/`) unless explicitly allowlisted in host policy.
- **Lifecycle (`T1`–`T3`):** `stacks_plan` (`T0`) & `stacks_apply` (`T2`, renders templates + validates policy + generates secrets cleanly into `0600` `.env`), `stacks_adopt` (`T2`), `stacks_up` (`T1`), `stacks_down` (`T2`), `stacks_remove` (`T3`, brings stack down and moves directory to `.trash` rather than deleting permanently).

### 5. Network Exposure Sagas (`network` — 14 tools)

- **Inspection (`T0`):** `network_routes`, `npm_list_proxy_hosts`, `cloudflare_list_tunnel_ingress`, `cloudflare_list_dns`, `network_probe`, `network_audit`, `tailscale_status`.
- **Reversible Exposure Saga (`T0`/`T3`):** `expose_plan` & `expose_apply` create the NPM proxy host, Cloudflare Tunnel ingress, proxied DNS CNAME, optional Cloudflare Access, and verification probe — rolling back created steps automatically on failure (`unexpose_plan` & `unexpose_apply` reverse the route).
- **Direct Controls (`T2`–`T3`):** `npm_proxy_host_upsert`, `npm_proxy_host_delete`, and `cloudflare_ingress_restore`.

### 6. Backups & Vaultwarden Backup Management (`backup` — 6 tools, `vaultwarden` — 8 tools)

See [docs/backups.md](./backups.md) for full details:

- General Restic/R2 monitoring & triggers (`backup_status`, `backup_snapshots`, `backup_run`, `backup_verify`, `backup_restore_test`, `backup_restore`).
- Dedicated Vaultwarden health & backup lifecycle (`vaultwarden_health`, `vaultwarden_backup_status`, `vaultwarden_backup_snapshots`, `vaultwarden_backup_run`, `vaultwarden_backup_test`, `vaultwarden_backup_restore_staging`, `vaultwarden_backup_prune_plan`, `vaultwarden_backup_prune_apply`).

### 7. Self-Hosted App Probes (`apps` — 1 tool)

- `apps_health` (`T0`): Executes configured HTTP/HTTPS health probes against self-hosted web apps (`filebrowser`, `naviload`, and other configured targets).

### 8. Music Library & On-Demand Downloads (`music` — 14 tools, `naviload` — 10 tools)

- **Navidrome Subsonic API (`music`):** Search tracks/artists/albums (`music_search`), inspect playlists (`music_playlists_list`, `music_playlist_get`), batch-match songs (`music_find_tracks`), end-to-end playlist builder (`music_build_playlist` / `music_build_playlist_apply`), manage playlists (`music_playlist_create`, `music_playlist_update`, `music_playlist_delete`, `music_smart_playlist_create`), and check/refresh library state (`music_library_stats`, `music_scan`, `music_recently_added`, `music_now_playing`).
- **NaviLoad Downloader (`naviload`):** Inspect service health/queue (`naviload_health`, `naviload_queue`), search or inspect YouTube candidates (`naviload_search_youtube`, `naviload_inspect`), download tracks (`naviload_download`), perform human-confirmed tag review (`naviload_review_list`, `naviload_review_decide`), publish to Navidrome (`naviload_save`), and retry/cancel jobs (`naviload_retry`, `naviload_cancel`).

### 9. Media Server & Torrents (`media` — 17 tools, `downloads` — 7 tools)

- **Jellyfin (`media`):** Server health, libraries, recently added items, search, active playback sessions, scheduled tasks, user list, activity log, problem diagnostics (`jellyfin_find_problems` including Series/Movies/Episodes/BoxSets/Music/Books), **item inspection & metadata editor (`jellyfin_item_inspect`, `jellyfin_item_update_metadata`, `jellyfin_refresh_item`)**, **two-step Identify search/apply (`jellyfin_identify_search`, `jellyfin_identify_apply`)**, and **qBittorrent-safe media renaming (`media_rename_plan`, `media_rename_apply`)** alongside `jellyfin_health`, `jellyfin_libraries`, `jellyfin_recently_added`, `jellyfin_search`, `jellyfin_sessions`, `jellyfin_scheduled_tasks`, `jellyfin_run_task`, `jellyfin_users`, and `jellyfin_activity_log`.
- **Jackett + qBittorrent (`downloads`):** Jackett indexer listing (`downloads_indexers`), parallel seeder-ranked search waiting for slow indexers (`downloads_search`), filtered/sorted qBittorrent status (`downloads_status`), torrent file/tracker inspection (`downloads_inspect`), add magnet/URL/`result_id` with disk-space guard (`downloads_add`), 4.6.x/5.x-compatible pause/resume/recheck (`downloads_control`), and plan-first removal (`downloads_remove`).

### 10. Alerting & Offline Notification Queue (`alerts` — 6 tools)

- Built-in rule watcher monitors CPU, memory, thermal sensors, battery/AC loss, SMART health, disk days-until-full, container health, RPO backup staleness, tunnel health, and Vaultwarden checks.
- **Tools (`T0`–`T2`):** `alerts_list`, `alerts_ack`, `alerts_snooze`, `alerts_rules_list`, `alerts_rule_set`, `alerts_test_notification`.
- When upstream `ntfy` is temporarily unreachable, alerts persist in SQLite and flush automatically when connectivity returns.

### 11. Scoped Files & Soft-Delete Trash (`files` — 10 tools)

- All file operations strictly enforce configured `roots.stacks`, `roots.media`, and `roots.shares`, block `..` traversal/symlinks escaping roots, and block reading/writing sensitive files (`.env`, `*.key`, `*.pem`, SSH keys, etc.).
- **Tools (`T0`–`T2`):** `files_list`, `files_stat`, `files_read`, `files_search`, `files_disk_usage`, `files_mkdir`, `files_write_plan`, `files_write_apply`, `files_move`, and `files_trash` (moves files to `.trash` inside its root rather than `rm -rf`).

### 12. Authentication, Sessions & PAT Management (`auth` — 6 tools)

- **OAuth 2.1 + CIMD + DCR + WebAuthn:** Browser-based owner login with passkey registration, TOTP/recovery codes, scope downgrade on consent, and rotating refresh tokens.
- **Headless PATs (`T0`–`T3`):** `auth_whoami`, `auth_clients_list`, `auth_client_revoke`, `auth_pat_list`, `auth_pat_create` (returns a **one-time passkey-protected `/account/pat-reveal` URL**, never leaking the PAT into LLM chat history), `auth_pat_revoke`.

### 13. MCP Resources (9) & Guided Prompts (8)

- **Resources:** `homemcp://overview`, `homemcp://system/health`, `homemcp://docker/services`, `homemcp://stacks/{name}/compose`, `homemcp://network/routes`, `homemcp://backup/status`, `homemcp://audit/recent`, `homemcp://alerts/open`, and `homemcp://docs/runbooks/{topic}`.
- **Prompts:** `triage_service`, `security_review`, `build_playlist`, `daily_briefing`, `weekly_health_report`, `restore_drill`, `deploy_service`, and `disk_cleanup`.
