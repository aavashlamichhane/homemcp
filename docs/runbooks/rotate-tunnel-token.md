# Runbook: Rotate Cloudflare Tunnel Token

1. Log in to **Cloudflare Zero Trust -> Networks -> Tunnels**.
2. Open your homelab tunnel and click **Refresh / Rotate Token**.
3. Immediately SSH to the host and update `TUNNEL_TOKEN=...` in `/home/homelab/docker-containers/cloudflared/.env` (`chmod 600 .env`).
4. Run `docker compose -f /home/homelab/docker-containers/cloudflared/docker-compose.yml up -d --remove-orphans`.
5. Confirm all replicas report `Registered tunnel connection` in `docker compose logs` and verify `homemcp_overview()` + `network_routes()` from MCP.
6. Confirm no unknown connector IPs appear in the Cloudflare dashboard.
