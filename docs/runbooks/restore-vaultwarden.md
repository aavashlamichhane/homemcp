# Runbook: Restore Vaultwarden

1. **Do NOT overwrite the live Vaultwarden database blindly.**
2. Use `backup_snapshots({ set: "vaultwarden" })` to confirm the latest verified snapshot.
3. Run `backup_restore_test({ set: "vaultwarden" })` or trigger a T3 staging restore via `backup_restore({ set: "vaultwarden", staging_subdir: "vw-recovery" })` after passkey confirmation.
4. On the host with maintenance outage communicated:
   - Stop Vaultwarden (`docker compose -f /home/homelab/docker-containers/vaultwarden-server/docker-compose.yml stop vaultwarden`).
   - Copy the current `/mnt/storage/vaultwarden/data/db.sqlite3` to a backup path.
   - Restore files from staging into `/mnt/storage/vaultwarden/data/` and start Vaultwarden (`docker compose up -d`).
   - Verify `/alive` returns HTTP 200 and decrypt one test item.
