#!/usr/bin/env bash
# Upgrade homemcpd permissions for Phase 4 (least-privilege sudo for homemcp-backup)
set -Eeuo pipefail

install -m 0440 "$(dirname "$0")/sudoers.homemcpd" /etc/sudoers.d/homemcpd
visudo -cf /etc/sudoers.d/homemcpd

mkdir -p /etc/systemd/system/homemcpd.service.d
cat > /etc/systemd/system/homemcpd.service.d/20-backup-sudo.conf <<'EOF'
[Service]
NoNewPrivileges=no
EOF

systemctl daemon-reload
systemctl restart homemcpd.service
systemctl is-active homemcpd.service
