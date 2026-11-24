#!/usr/bin/env bash
# Upgrade homemcpd permissions for Phase 5 (Docker socket access + allowlisted systemctl)
set -Eeuo pipefail

usermod -aG docker homemcpd

mkdir -p /etc/systemd/system/homemcpd.service.d
cat > /etc/systemd/system/homemcpd.service.d/30-ops.conf <<'EOF'
[Service]
SupplementaryGroups=adm systemd-journal docker
NoNewPrivileges=no
EOF

systemctl daemon-reload
systemctl restart homemcpd.service
systemctl is-active homemcpd.service
