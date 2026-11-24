#!/usr/bin/env bash
# Cleanly remove homemcpd systemd unit and sudoers entry (preserves /etc/homemcp config unless --purge)
set -Eeuo pipefail

systemctl disable --now homemcpd.service 2>/dev/null || true
rm -f /etc/systemd/system/homemcpd.service
rm -rf /etc/systemd/system/homemcpd.service.d /etc/sudoers.d/homemcpd
systemctl daemon-reload

if [ "${1:-}" = "--purge" ]; then
  rm -rf /opt/homemcp/agent /run/homemcpd
  userdel homemcpd 2>/dev/null || true
fi
echo "homemcpd uninstalled."
