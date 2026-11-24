# homemcp Reference — Tools, Resources, and Prompts

> Auto-generated from `HomemcpRegistry` via `pnpm docs:generate`. Do not edit by hand.

**Totals:** 133 tools across 15 toolsets, 9 resources, 8 prompts.

## Toolsets Summary

| Toolset | Tools | Tiers |
|---|---|---|
| `alerts` | 6 | T0, T1, T2 |
| `apps` | 1 | T0 |
| `auth` | 6 | T0, T2, T3 |
| `backup` | 6 | T0, T1, T3 |
| `core` | 6 | T0, T1 |
| `docker` | 12 | T0, T2 |
| `downloads` | 4 | T0, T1, T2 |
| `files` | 10 | T0, T1, T2 |
| `media` | 12 | T0, T1, T2 |
| `music` | 14 | T0, T1, T2 |
| `naviload` | 10 | T0, T1 |
| `network` | 14 | T0, T2, T3 |
| `stacks` | 11 | T0, T1, T2, T3 |
| `system` | 13 | T0, T2, T3 |
| `vaultwarden` | 8 | T0, T1, T2, T3 |

## Tools by Toolset

### `alerts`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `alerts_ack` | T1 | `homemcp:operate` | -/-/I/- | Acknowledges an active alert so repeat notifications are suppressed while investigated. |
| `alerts_list` | T0 | `homemcp:read` | R/-/I/- | Lists open or recent alerts evaluated by the homemcp watcher. Read-only. |
| `alerts_rule_set` | T2 | `homemcp:admin` | -/-/I/- | Updates an alert rule threshold, severity, pending window, or enabled state (plan-first). |
| `alerts_rules_list` | T0 | `homemcp:read` | R/-/I/- | Lists configured alert rules, severities, thresholds, and pending windows. Read-only. |
| `alerts_snooze` | T1 | `homemcp:operate` | -/-/I/- | Snoozes an alert for a duration (e.g., 2h, 30m). |
| `alerts_test_notification` | T1 | `homemcp:operate` | -/-/-/O | Sends a test push notification via ntfy (or queues if currently offline). |

### `apps`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `apps_health` | T0 | `homemcp:read` | R/-/I/- | Runs configured HTTP health checks against self-hosted web apps (e.g., filebrowser, naviload, wordchain, browser-savepoint). Read-only. Example: apps_health(). |

### `auth`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `auth_client_revoke` | T3 | `homemcp:admin` | -/D/I/- | Revokes an OAuth client and all of its active grants/refresh tokens. T3 critical action. Example: auth_client_revoke({ client_id: "https://client.example.com/oauth.json" }). |
| `auth_clients_list` | T0 | `homemcp:read` | R/-/I/- | Lists registered and CIMD-cached OAuth clients. Read-only. Example: auth_clients_list(). |
| `auth_pat_create` | T3 | `homemcp:admin` | -/-/-/- | Creates a Personal Access Token (PAT) for headless agents with explicit scopes, optional toolsets, optional CIDRs, and TTL (max 90 days). Never returns the secret in tool output; returns a one-time /account/pat-reveal URL requiring a passkey session. Example: auth_pat_create({ name: "ci-reader", scopes: ["homemcp:read"], ttl_days: 30 }). |
| `auth_pat_list` | T0 | `homemcp:read` | R/-/I/- | Lists Personal Access Tokens (metadata only, never secret hashes or values). Read-only. Example: auth_pat_list(). |
| `auth_pat_revoke` | T2 | `homemcp:admin` | -/D/I/- | Revokes a Personal Access Token by id. Example: auth_pat_revoke({ id: "..." }). |
| `auth_whoami` | T0 | `homemcp:read` | R/-/I/- | Returns the authenticated caller subject, client_id, token kind/id, scopes, and auth_time. Read-only. Example: auth_whoami(). |

### `backup`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `backup_restore` | T3 | `homemcp:admin` | -/-/-/- | Restores a backup snapshot strictly into an isolated staging directory (never overwrites live data). Requires T3 passkey confirmation. |
| `backup_restore_test` | T1 | `homemcp:operate` | -/-/I/- | Runs an automated temporary restore integrity test for Vaultwarden (`homemcp-backup restore-test vaultwarden`). |
| `backup_run` | T1 | `homemcp:operate` | -/-/-/O | Runs an on-demand restic backup for one configured set or "all" via homemcpd as a tracked background job. |
| `backup_snapshots` | T0 | `homemcp:read` | R/-/I/- | Lists restic backup snapshots from the exported snapshots.json metadata. Optionally filters by backup set tag. Read-only. Example: backup_snapshots({ set: "vaultwarden" }). |
| `backup_status` | T0 | `homemcp:read` | R/-/I/- | Reports backup freshness per configured set against RPO, last restore test status, and R2 repository size vs budget. Read-only. Example: backup_status({ set: "vaultwarden" }). |
| `backup_verify` | T1 | `homemcp:operate` | -/-/I/O | Runs restic repository maintenance and integrity check (`homemcp-backup maint`) as a tracked job. |

### `core`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `audit_query` | T0 | `homemcp:audit` | R/-/I/- | Filters the homemcp audit log by tool, status, or start timestamp. Requires homemcp:audit scope. Read-only. Example: audit_query({ limit: 20 }). |
| `homemcp_capabilities` | T0 | `homemcp:read` | R/-/I/- | Lists enabled toolsets, registered tools, connector readiness, caller scopes, and server version. Read-only. Example: homemcp_capabilities(). |
| `homemcp_overview` | T0 | `homemcp:read` | R/-/I/- | Start here. Summarizes host health, unhealthy/restarting containers, disk usage, backup freshness, pending OS updates, and stale/dead routes, with drill-down hints. Read-only. Example: call homemcp_overview() first for any status question. |
| `jobs_cancel` | T1 | `homemcp:operate` | -/-/I/- | Requests cancellation of a queued, running, or waiting background job. Example: jobs_cancel({ job_id: "job_123" }). |
| `jobs_get` | T0 | `homemcp:read` | R/-/I/- | Returns detailed step logs, progress percentage, and redacted output for a single background job. Read-only. Example: jobs_get({ job_id: "job_123" }). |
| `jobs_list` | T0 | `homemcp:read` | R/-/I/- | Lists background and async jobs tracked by homemcp (e.g., playlist downloads, backups, updates). Read-only. Example: jobs_list({ status: "running" }). |

### `docker`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `docker_check_updates` | T0 | `homemcp:read` | R/-/I/O | Compares running container image digests against remote OCI registries (Docker Hub, GHCR, LSIO) to detect available updates. Read-only. Example: docker_check_updates(). |
| `docker_container_action` | T2 | `homemcp:admin` | -/-/-/- | Starts, stops, or restarts a Docker container. Protected containers require T3 passkey confirmation + override_protected=true; plan-first when plan_id is omitted. |
| `docker_disk_usage` | T0 | `homemcp:read` | R/-/I/- | Reports Docker disk usage breakdown across images, containers, and volumes (`system df`). Read-only. Example: docker_disk_usage(). |
| `docker_events` | T0 | `homemcp:read` | R/-/I/- | Returns recent Docker engine events (die, oom, restart, health_status) over the last N minutes. Read-only. Example: docker_events({ minutes: 60 }). |
| `docker_list_services` | T0 | `homemcp:read` | R/-/I/- | Lists all running/stopped containers, Compose projects, and dormant stacks discovered on disk (including policy findings). Read-only. Example: docker_list_services(). |
| `docker_logs` | T0 | `homemcp:read` | R/-/I/- | Fetches container stdout/stderr logs with tail/since/until/grep filtering, secret redaction, and untrusted-data fencing. Read-only. Example: docker_logs({ name: "navidrome", tail: 100 }). |
| `docker_prune_apply` | T2 | `homemcp:admin` | -/D/-/- | Executes a confirmed Docker prune plan (never deletes volumes). |
| `docker_prune_plan` | T0 | `homemcp:read` | R/-/I/- | Previews Docker prune (stopped containers, dangling images, unused networks; NEVER volumes) and creates a plan_id for docker_prune_apply. Read-only. |
| `docker_rollback_service` | T2 | `homemcp:admin` | -/-/-/- | Rolls back a Docker Compose service to a specified previous image digest (plan-first if plan_id omitted). |
| `docker_service_profile` | T0 | `homemcp:read` | R/-/I/O | Deep profile of one container/service ("tell me everything"): redacted compose definition, image digest/version, env keys only, mounts, networks, health, logs summary, NPM/Cloudflare routes, and update check. Read-only. Example: docker_service_profile({ name: "navidrome" }). |
| `docker_stats` | T0 | `homemcp:read` | R/-/I/- | Returns one-shot CPU and memory stats for running containers (or one named container). Read-only. Example: docker_stats(). |
| `docker_update_service` | T2 | `homemcp:admin` | -/-/-/O | Safely updates a Compose service with 120s health gate and automatic rollback to prior image digest on failure. Pass only stack_dir + service first to generate a plan, then re-call with plan_id after confirmation. |

### `downloads`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `downloads_add` | T1 | `homemcp:operate` | -/-/-/O | Adds a magnet link or torrent URL to qBittorrent under a configured category (e.g., movies, series, anime) after verifying target filesystem free space is above safety threshold. |
| `downloads_control` | T1 | `homemcp:operate` | -/-/I/- | Pauses, resumes, or forces recheck on one or more torrents by infohash. |
| `downloads_remove` | T2 | `homemcp:admin` | -/D/-/- | Removes torrents from qBittorrent (plan-first; deleting downloaded files requires T3 passkey confirmation). |
| `downloads_status` | T0 | `homemcp:read` | R/-/I/- | Shows qBittorrent transfer speeds, connection state, active/stalled torrents, and target storage disk free space. Read-only. |

### `files`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `files_disk_usage` | T0 | `homemcp:read` | R/-/I/- | Reports per-entry byte sizes under an allowed directory path. Read-only. |
| `files_list` | T0 | `homemcp:read` | R/-/I/- | Lists directory entries within allowed stacks/media/shares roots. Read-only. |
| `files_mkdir` | T1 | `homemcp:operate` | -/-/I/- | Creates a directory inside allowed roots. |
| `files_move` | T2 | `homemcp:admin` | -/-/-/- | Moves/renames a file inside allowed roots (plan-first when overwrite=true or plan_id omitted). |
| `files_read` | T0 | `homemcp:read` | R/-/I/- | Reads a UTF-8 text file (<=256 KB) within allowed roots; strictly blocks .env, .key, .pem, and SSH/credential files and redacts output. Read-only. |
| `files_search` | T0 | `homemcp:read` | R/-/I/- | Searches filenames matching a case-insensitive pattern within allowed roots (skips denied files). Read-only. |
| `files_stat` | T0 | `homemcp:read` | R/-/I/- | Inspects file or directory metadata (type, size, octal mode, mtime). Read-only. |
| `files_trash` | T2 | `homemcp:admin` | -/D/-/- | Moves a file or directory to `.trash` inside its root (30-day soft delete; plan-first). |
| `files_write_apply` | T2 | `homemcp:admin` | -/-/I/- | Applies a confirmed file write plan via homemcpd. |
| `files_write_plan` | T0 | `homemcp:read` | R/-/I/- | Plans writing a non-secret file inside stack roots and returns a diff plan_id for files_write_apply. Read-only. |

### `media`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `jellyfin_activity_log` | T0 | `homemcp:read` | R/-/I/- | Returns recent Jellyfin authentication and admin activity log entries. Read-only. |
| `jellyfin_find_problems` | T0 | `homemcp:read` | R/-/I/- | Scans Jellyfin library items for unidentified entries (missing ProviderIds), missing primary images, duplicate TMDB IDs, and non-standard Movie/Episode filenames. Read-only. |
| `jellyfin_health` | T0 | `homemcp:read` | R/-/I/- | Reports Jellyfin /health status, version, active playback/transcode count, hardware acceleration usage, failed scheduled tasks, and container health. Read-only. |
| `jellyfin_libraries` | T0 | `homemcp:read` | R/-/I/- | Lists configured Jellyfin virtual folders and refresh states. Read-only. |
| `jellyfin_recently_added` | T0 | `homemcp:read` | R/-/I/- | Lists recently added items in Jellyfin. Read-only. |
| `jellyfin_run_task` | T1 | `homemcp:operate` | -/-/I/- | Triggers a Jellyfin scheduled task by ID or exact task name (e.g., Scan Media Library). |
| `jellyfin_scheduled_tasks` | T0 | `homemcp:read` | R/-/I/- | Lists Jellyfin scheduled tasks and last execution results. Read-only. |
| `jellyfin_search` | T0 | `homemcp:read` | R/-/I/- | Searches Jellyfin library items by title or media type. Read-only. |
| `jellyfin_sessions` | T0 | `homemcp:read` | R/-/I/- | Lists active Jellyfin playback sessions including codec, hardware acceleration, and transcode reasons. Read-only. |
| `jellyfin_users` | T0 | `homemcp:read` | R/-/I/- | Lists configured Jellyfin user accounts and admin flags (redacted). Read-only. |
| `media_rename_apply` | T2 | `homemcp:admin` | -/-/-/- | Executes a confirmed media rename plan and triggers a Jellyfin library scan. |
| `media_rename_plan` | T0 | `homemcp:read` | R/-/I/- | Plans renaming media files under allowed media roots to Jellyfin conventions (`Title (Year)` / `SxxExx`) before a library scan. Read-only. |

### `music`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `music_build_playlist` | T0 | `homemcp:read` | R/-/I/O | Plans a playlist from requested songs: matches tracks already in Navidrome, searches NaviLoad for YouTube candidates for missing tracks, scores official/Topic channels, and returns a plan_id to pass to music_build_playlist_apply. |
| `music_build_playlist_apply` | T1 | `homemcp:operate` | -/-/-/O | Executes a playlist build plan: creates the Navidrome playlist immediately with matched tracks, queues selected YouTube downloads via NaviLoad as a tracked background job, and pauses at waiting_user if any downloaded tracks await human tag review. |
| `music_find_tracks` | T0 | `homemcp:read` | R/-/I/- | Batch-matches requested tracks [{artist, title, video_id?}] against Navidrome using Unicode NFKD, feat./video suffix stripping, YouTube ID matching, and artist/title swap tolerance. Read-only. |
| `music_library_stats` | T0 | `homemcp:read` | R/-/I/- | Returns Navidrome artist/playlist counts and library scan status. Read-only. |
| `music_now_playing` | T0 | `homemcp:read` | R/-/I/- | Shows active music playback sessions in Navidrome. Read-only. |
| `music_playlist_create` | T1 | `homemcp:operate` | -/-/-/- | Creates a new Navidrome playlist with optional initial song IDs. |
| `music_playlist_delete` | T2 | `homemcp:admin` | -/D/-/- | Deletes a Navidrome playlist (plan-first + confirmation required). |
| `music_playlist_get` | T0 | `homemcp:read` | R/-/I/- | Fetches a single Navidrome playlist and all its track entries. Read-only. |
| `music_playlist_update` | T1 | `homemcp:operate` | -/-/-/- | Updates a Navidrome playlist (rename, comment, visibility, add/remove songs). |
| `music_playlists_list` | T0 | `homemcp:read` | R/-/I/- | Lists playlists in Navidrome with track counts and durations. Read-only. |
| `music_recently_added` | T0 | `homemcp:read` | R/-/I/- | Lists recently added or frequent albums in Navidrome. Read-only. |
| `music_scan` | T1 | `homemcp:operate` | -/-/I/- | Triggers a Navidrome library scan and returns current scan status. |
| `music_search` | T0 | `homemcp:read` | R/-/I/- | Searches Navidrome artists, albums, and songs via Subsonic search3. Read-only. Example: music_search({ query: "Midnight City" }). |
| `music_smart_playlist_create` | T1 | `homemcp:operate` | -/-/I/- | Creates a Navidrome Smart Playlist (.nsp) JSON rule file in the stacks/navidrome directory and triggers a library scan. |

### `naviload`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `naviload_cancel` | T1 | `homemcp:operate` | -/-/I/- | Cancels a queued or staged NaviLoad track. |
| `naviload_download` | T1 | `homemcp:operate` | -/-/-/O | Queues YouTube URLs for download into NaviLoad staging. |
| `naviload_health` | T0 | `homemcp:read` | R/-/I/- | Returns NaviLoad /healthz, queue depth, pending review count, and failed track count. Read-only. |
| `naviload_inspect` | T0 | `homemcp:read` | R/-/I/O | Inspects a YouTube URL or playlist via NaviLoad without downloading. Read-only. |
| `naviload_queue` | T0 | `homemcp:read` | R/-/I/- | Lists active, pending-review, failed, and saved tracks in NaviLoad. Read-only. |
| `naviload_retry` | T1 | `homemcp:operate` | -/-/-/O | Retries a failed NaviLoad track download. |
| `naviload_review_decide` | T1 | `homemcp:operate` | -/-/-/- | Applies an explicit human-selected metadata tag policy (keep_youtube, suggestion, or manual) to a staged NaviLoad track. Enforces human review: rejects calls without user_confirmed_decision=true or interactive elicitation. |
| `naviload_review_list` | T0 | `homemcp:read` | R/-/I/- | Lists NaviLoad tracks awaiting human metadata review alongside AcoustID/MusicBrainz suggestions. Read-only. |
| `naviload_save` | T1 | `homemcp:operate` | -/-/-/- | Publishes a reviewed NaviLoad track into the Navidrome music library and reconciles any waiting playlist build jobs. |
| `naviload_search_youtube` | T0 | `homemcp:read` | R/-/I/O | Searches YouTube via NaviLoad for candidate tracks with duration, channel, and already-downloaded hints. Read-only. |

### `network`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `cloudflare_ingress_restore` | T3 | `homemcp:admin` | -/-/-/O | Restores Cloudflare Tunnel ingress configuration from a historical cf_ingress_history snapshot (T3 passkey confirmation required). |
| `cloudflare_list_dns` | T0 | `homemcp:read` | R/-/I/O | Lists DNS records across all configured Cloudflare zones. Read-only. Example: cloudflare_list_dns(). |
| `cloudflare_list_tunnel_ingress` | T0 | `homemcp:read` | R/-/I/O | Returns Cloudflare Tunnel status, active connector replicas, and current ingress rules. Read-only. Example: cloudflare_list_tunnel_ingress(). |
| `expose_apply` | T3 | `homemcp:admin` | -/-/-/O | Executes a confirmed expose plan as an atomic saga (NPM -> Cloudflare Tunnel ingress -> DNS CNAME -> Access -> probe), rolling back all prior steps on any failure. |
| `expose_plan` | T0 | `homemcp:read` | R/-/I/- | Plans exposing an internal service publicly via NPM proxy host + Cloudflare Tunnel ingress + proxied DNS CNAME + optional Cloudflare Access. Creates a T3 plan_id requiring passkey confirmation before expose_apply. |
| `network_audit` | T0 | `homemcp:read` | R/-/I/- | Audits public hostnames without Cloudflare Access, wildcard listening sockets, and stale NPM routes. Read-only. Example: network_audit(). |
| `network_probe` | T0 | `homemcp:read` | R/-/I/O | Probes an HTTP/HTTPS URL and reports status code, latency, redirect chain, and TLS certificate expiration. Read-only. Example: network_probe({ url: "https://vw.example.com/alive" }). |
| `network_routes` | T0 | `homemcp:read` | R/-/I/O | Builds the unified public route table linking DNS -> Cloudflare Tunnel ingress -> NPM proxy host -> container/listener -> HTTP probe, flagging dead upstreams, DNS/ingress mismatches, and expiring certificates. Read-only. Example: network_routes({ probe: true }). |
| `npm_list_proxy_hosts` | T0 | `homemcp:read` | R/-/I/- | Lists Nginx Proxy Manager proxy hosts, certificates, and access lists. Read-only. Example: npm_list_proxy_hosts(). |
| `npm_proxy_host_delete` | T2 | `homemcp:admin` | -/D/-/- | Deletes an NPM proxy host by ID (plan-first). |
| `npm_proxy_host_upsert` | T2 | `homemcp:admin` | -/-/I/- | Creates or updates an Nginx Proxy Manager proxy host (plan-first). |
| `tailscale_status` | T0 | `homemcp:read` | R/-/I/- | Reports Tailscale break-glass VPN connection state, tailnet IPs, and DNS name. Read-only. Example: tailscale_status(). |
| `unexpose_apply` | T3 | `homemcp:admin` | -/D/-/O | Executes a confirmed unexpose plan. |
| `unexpose_plan` | T0 | `homemcp:read` | R/-/I/- | Plans removing public Access, DNS CNAME, tunnel ingress, and NPM proxy host for a hostname. Read-only. |

### `stacks`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `stacks_adopt` | T2 | `homemcp:admin` | -/-/I/- | Registers an existing compose directory on disk under homemcp management (plan-first). |
| `stacks_apply` | T2 | `homemcp:admin` | -/-/-/O | Applies a confirmed stack plan: validates policy in homemcpd, writes compose, generates secrets cleanly to 0600 .env (values never returned), pulls, and starts. |
| `stacks_down` | T2 | `homemcp:admin` | -/-/I/- | Stops a stack (`docker compose down`) keeping volumes/data intact (plan-first). |
| `stacks_get` | T0 | `homemcp:read` | R/-/I/- | Inspects one stack: redacted compose YAML, .env stats, policy findings, and management metadata. Read-only. |
| `stacks_list` | T0 | `homemcp:read` | R/-/I/- | Lists managed, adopted, and unmanaged stacks on disk alongside compose policy status and container status. Read-only. |
| `stacks_plan` | T0 | `homemcp:read` | R/-/I/- | Plans deploying a curated template or custom compose YAML: renders template, validates compose policy, checks port/name conflicts, and returns a plan_id for stacks_apply. Read-only. |
| `stacks_remove` | T3 | `homemcp:admin` | -/D/-/- | Brings a stack down and moves its directory to `.trash/<name>-<ts>` (never deletes permanently). Requires T3 passkey confirmation. |
| `stacks_template_get` | T0 | `homemcp:read` | R/-/I/- | Returns a curated template’s parameter schema, README, and Handlebars compose source. Read-only. |
| `stacks_templates_list` | T0 | `homemcp:read` | R/-/I/- | Lists curated Compose service templates available in the homemcp catalog. Read-only. |
| `stacks_up` | T1 | `homemcp:operate` | -/-/I/- | Starts a stack (`docker compose up -d`) inside allowed stack roots. |
| `stacks_validate` | T0 | `homemcp:read` | R/-/I/- | Validates candidate Docker Compose YAML against homemcp security policy without writing any files. Read-only. |

### `system`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `system_disks` | T0 | `homemcp:read` | R/-/I/- | Returns mounted filesystems (bytes, inodes), growth forecast (days_until_full) from daily snapshots, and SMART health summary. Read-only. Example: system_disks(). |
| `system_errors_summary` | T0 | `homemcp:read` | R/-/I/- | Deduplicates journald error/critical signatures over 24h or 7d and flags known-noise patterns. Read-only. Example: system_errors_summary({ since: "24h" }). |
| `system_health` | T0 | `homemcp:read` | R/-/I/- | Returns CPU load, RAM/swap usage, thermal zone temperatures, battery/AC power status, uptime, reboot-required flag, failed systemd units, and OOM kill count (24h). Read-only. Example: system_health(). |
| `system_logs_query` | T0 | `homemcp:read` | R/-/I/- | Queries journald logs by unit, priority, time range, or grep pattern. Log messages are wrapped as untrusted data and redacted. Read-only. Example: system_logs_query({ unit: "docker.service", limit: 100 }). |
| `system_metrics_history` | T0 | `homemcp:read` | R/-/I/- | Queries sysstat historical metrics (cpu, mem, io, net, load) via sadf, downsampled to <=120 points. Read-only. Example: system_metrics_history({ group: "cpu" }). |
| `system_network` | T0 | `homemcp:read` | R/-/I/- | Lists host network interfaces, IP addresses, routing table, and DNS nameservers. Read-only. Example: system_network(). |
| `system_processes` | T0 | `homemcp:read` | R/-/I/- | Lists top N host processes sorted by CPU or memory usage with secret redaction. Read-only. Example: system_processes({ sort_by: "cpu", limit: 15 }). |
| `system_reboot` | T3 | `homemcp:admin` | -/D/-/- | Schedules a host reboot in 1 minute with an ntfy alert. Requires T3 passkey confirmation via /confirm/:id. |
| `system_security_audit` | T0 | `homemcp:read` | R/-/I/- | Reports UFW firewall status, effective sshd settings, listening sockets (flagging wildcard binds), failed SSH logins, and Tailscale break-glass state. Read-only. Example: system_security_audit(). |
| `system_service_action` | T2 | `homemcp:admin` | -/-/-/- | Starts, stops, or restarts an allowlisted host systemd unit (protected units always denied). Plan-first when plan_id is omitted. |
| `system_services` | T0 | `homemcp:read` | R/-/I/- | Checks status, PID, restarts, and memory of allowlisted host systemd services. Read-only. Example: system_services(). |
| `system_smart_details` | T0 | `homemcp:read` | R/-/I/- | Returns detailed SMART attributes for one block device (e.g., sda, sdb) from the exported status snapshot. Read-only. Example: system_smart_details({ device: "sda" }). |
| `system_updates` | T0 | `homemcp:read` | R/-/I/- | Checks pending apt package updates (highlighting security updates), unattended-upgrades last run, and reboot-required status. Read-only. Example: system_updates(). |

### `vaultwarden`

| Tool | Tier | Scope | Hints (R/D/I/O) | Description |
|---|---|---|---|---|
| `vaultwarden_backup_prune_apply` | T2 | `homemcp:admin` | -/D/-/O | Executes a confirmed Vaultwarden retention prune plan via homemcpd. |
| `vaultwarden_backup_prune_plan` | T0 | `homemcp:read` | R/-/I/O | Runs a dry-run retention check (`restic forget --dry-run`) on Vaultwarden snapshots and returns a plan_id to confirm pruning old snapshots. |
| `vaultwarden_backup_restore_staging` | T3 | `homemcp:admin` | -/-/-/- | Restores a Vaultwarden snapshot strictly to an isolated staging directory for inspection or manual recovery (never overwrites live Vaultwarden data). Requires T3 passkey confirmation. |
| `vaultwarden_backup_run` | T1 | `homemcp:operate` | -/-/-/O | Runs an immediate consistent Vaultwarden backup (`db.sqlite3`, RSA keys, config, attachments, sends) to R2 via homemcpd as a tracked job. |
| `vaultwarden_backup_snapshots` | T0 | `homemcp:read` | R/-/I/- | Lists Restic encrypted snapshots specifically for Vaultwarden (newest first) with snapshot IDs and timestamps. Read-only. |
| `vaultwarden_backup_status` | T0 | `homemcp:read` | R/-/I/- | Reports dedicated Vaultwarden backup freshness vs RPO, snapshot count, latest restore-test SQLite cipher check, schedule (every 6h), retention policy, and repo budget. Read-only. Never reads vault contents. |
| `vaultwarden_backup_test` | T1 | `homemcp:operate` | -/-/I/- | Restores a Vaultwarden snapshot into a temporary directory, runs SQLite PRAGMA integrity_check, compares cipher/user counts against the live DB, and cleans up. |
| `vaultwarden_health` | T0 | `homemcp:read` | R/-/I/O | Checks Vaultwarden /alive endpoint, version vs upstream release, signups/admin-panel disabled flags, DOMAIN match against publicUrl, and backup freshness. Never reads vault contents. Read-only. Example: vaultwarden_health(). |

## Resources

| URI / Template | Scope | Mime | Description |
|---|---|---|---|
| `homemcp://overview` | `homemcp:read` | `application/json` | Snapshot of host health, containers, disks, and backups |
| `homemcp://system/health` | `homemcp:read` | `application/json` | Latest host health snapshot |
| `homemcp://docker/services` | `homemcp:read` | `application/json` | Running containers and scanned stacks |
| `homemcp://stacks/{name}/compose` | `homemcp:read` | `text/yaml` | Redacted Docker Compose YAML for a stack |
| `homemcp://network/routes` | `homemcp:read` | `application/json` | NPM proxy hosts, Cloudflare tunnel ingress, and DNS records |
| `homemcp://backup/status` | `homemcp:read` | `application/json` | Restic backup status, snapshots, and repository statistics |
| `homemcp://audit/recent` | `homemcp:audit` | `application/json` | Last 100 homemcp audit entries |
| `homemcp://alerts/open` | `homemcp:read` | `application/json` | Currently pending and firing alerts evaluated by homemcp watcher |
| `homemcp://docs/runbooks/{topic}` | `homemcp:read` | `text/markdown` | Emergency & operational Markdown runbooks (restore-vaultwarden, rotate-tunnel-token, add-service, disk-full, break-glass) |

## Prompts

| Name | Title | Description |
|---|---|---|
| `triage_service` | Triage Service | Investigate health, logs, routes, and resource usage for one service |
| `security_review` | Security Review | Audit host firewall, SSH, listening ports, public routes, and Vaultwarden posture |
| `build_playlist` | Build Playlist | Find matching songs in Navidrome, search YouTube for missing songs via NaviLoad, and build a playlist |
| `daily_briefing` | Daily Server Briefing | Summarize open alerts, host health, backup freshness, downloads, and media sessions |
| `weekly_health_report` | Weekly Health Report | Summarize 7-day disk trends, journal errors, updates, and backup integrity |
| `restore_drill` | Backup Restore Drill | Verify backup integrity and perform a safe restore test for a set |
| `deploy_service` | Deploy & Expose Service | Plan deploying a curated Compose template and optionally exposing it via NPM + Cloudflare |
| `disk_cleanup` | Disk Cleanup Assessment | Inspect disk usage trends, Docker reclaimable space, and media/files directories safely |
