# Runbook: Restore Vaultwarden

1. **Do NOT overwrite the live Vaultwarden database blindly.**
2. Use `vaultwarden_backup_snapshots()` (or `backup_snapshots({ set: "vaultwarden" })`) to confirm the latest verified snapshot.
3. Run `vaultwarden_backup_test()` (T1) or trigger a T3 staging restore via `vaultwarden_backup_restore_staging({ snapshot_id: "<id>", staging_subdir: "vw-recovery" })` after fresh passkey confirmation.
4. On the host with maintenance outage communicated:
   - Stop Vaultwarden (`docker compose -f /home/homelab/docker-containers/vaultwarden-server/docker-compose.yml stop vaultwarden`).
   - Copy the current `/mnt/storage/vaultwarden/data/db.sqlite3` to a backup path.
   - Restore files from staging into `/mnt/storage/vaultwarden/data/` and start Vaultwarden (`docker compose up -d`).
   - Verify `/alive` returns HTTP 200 (or call `vaultwarden_health()`) and decrypt one test item.
