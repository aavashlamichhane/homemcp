# Runbook: Disk Space Full / Low-Space Incident

1. Run `system_disks()` to identify which filesystem crossed 85% and inspect `days_until_full`.
2. Run `docker_disk_usage()` and `docker_prune_plan({ include_build_cache: false })` to check safely reclaimable container/image space (volumes are never pruned).
3. Run `files_disk_usage` on `/mnt/storage/media` and `/home/homelab/docker-containers`.
4. Pause new large downloads with `downloads_control`; remove unwanted completed torrents with `downloads_remove`.
5. Move unneeded staging files to `.trash/` using `files_trash` after human confirmation.
