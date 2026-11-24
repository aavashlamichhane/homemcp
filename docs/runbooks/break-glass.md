# Runbook: Break-Glass Recovery (If Tunnel or Auth Fails)

If Cloudflare Tunnel or OAuth endpoints become unreachable:

1. Connect over **Tailscale** (`ssh homelab@100.64.x.y`) or local LAN (`192.0.2.x`).
2. Check gateway container and agent status:
   - `docker ps -a` and `docker logs homemcp --tail 100`
   - `systemctl status homemcpd` and `journalctl -u homemcpd -n 100`
3. If `cloudflare_ingress` was misconfigured and gateway is still locally reachable, run `cloudflare_ingress_restore` or restore via `cf_ingress_history` in SQLite.
4. For emergency lockout on owner account, run `docker exec -it homemcp node dist/cli.js auth bootstrap` on the host console to generate a single-use passkey/TOTP reset URL.
