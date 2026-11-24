# Deployment Assets (`deploy/`)

Production manifests and progressive host installation scripts for `homemcpd` (host agent) and the containerized `homemcp` gateway.

## Host Agent (`deploy/agent/`)

| File               | Purpose                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `build-release.sh` | Packages `@homemcp/agent` production bundle for deployment                      |
| `homemcpd.service` | Hardened `systemd` unit running `homemcpd` with `0660` socket permissions       |
| `sudoers.homemcpd` | Minimal passwordless `sudo` rules scoped specifically to `homemcp-backup` verbs |
| `install-p1.sh`    | Baseline read-only setup (`system`, `stacks.scan`, `backup.read_status`)        |
| `install-p4.sh`    | Enables backup sudoers & `/var/lib/homemcp/backup` access                       |
| `install-p5.sh`    | Enables controlled Docker updates and allowlisted systemd restarts              |
| `install-p6.sh`    | Enables POSIX ACLs on allowed stack/media/share directories                     |
| `uninstall.sh`     | Clean removal of service, socket, and sudoers entries                           |

## Gateway Container (`deploy/gateway/`)

| File                 | Purpose                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `Dockerfile`         | Multi-stage Node 24 build running unprivileged uid `1000:1000`                                         |
| `docker-compose.yml` | Hardened stack (`read_only: true`, `cap_drop: ALL`, `no-new-privileges`, `homemcp_internal` network)   |
| `.env.example`       | Required environment variables template (`HOMEMCP_SECRET_KEY`, `HOMEMCPD_HMAC_SECRET`, service tokens) |
| `deploy.sh`          | Builds, validates, and starts the containerized gateway                                                |

See [docs/deployment.md](../docs/deployment.md) for the complete rollout sequence.
