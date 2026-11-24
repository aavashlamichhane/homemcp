# Production Deployment Guide

## 1. Host Agent (`homemcpd`)

Build or download the agent bundle (`deploy/agent/build-release.sh`) and install phase scripts on the Ubuntu/Debian host:

1. Copy built agent artifacts to `/opt/homemcp/agent/`.
2. Configure `/etc/homemcp/agent.yaml` (stack roots, `allowedUnits`, `protectedContainers`, `compose.allow`, `mediaRoot`).
3. Run `sudo ADMIN_USER=homelab bash deploy/agent/install-p1.sh`.
4. Progressively enable write capabilities only when ready for each phase (`install-p4.sh` backup sudo, `install-p5.sh` docker/systemd, `install-p6.sh` stack/media write ACLs).

## 2. Gateway Container Stack (`deploy/gateway/`)

1. Copy `examples/homemcp.config.example.yaml` to `/opt/homemcp/gateway/config/homemcp.config.yaml` and fill in your host/module settings (use `env:VAR_NAME` for all secrets).
2. Copy `deploy/gateway/.env.example` to `/opt/homemcp/gateway/.env` (`chmod 600`), generating `HOMEMCP_SECRET_KEY=$(openssl rand -hex 32)` and setting `HOMEMCPD_HMAC_SECRET`.
3. Deploy with `./deploy/gateway/deploy.sh` (runs read-only container uid `1000:1000`, `cap_drop: ALL`, attached to `homemcp_internal`, `cloudflared_default`, and `proxy`).
4. Route `https://homemcp.example.com` -> `http://homemcp:8790` in Cloudflare Tunnel (no Cloudflare Access gate in front of `/oauth/*` or `/.well-known/*`).
5. Run `docker exec -it homemcp node dist/cli.js auth bootstrap` to enroll your owner passkey, TOTP, and recovery codes.
