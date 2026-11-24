#!/usr/bin/env bash
# Upgrade homemcpd permissions for Phase 6 (read-write ACLs on stacks & media roots; existing .env stays 0600)
set -Eeuo pipefail

ADMIN_USER="${ADMIN_USER:-homelab}"
STACKS_ROOT="${STACKS_ROOT:-/home/$ADMIN_USER/docker-containers}"
MEDIA_ROOT="${MEDIA_ROOT:-/mnt/storage/media}"
SHARE_ROOTS="${SHARE_ROOTS:-/mnt/storage/shares}"
read -r -a SHARE_ARR <<< "$SHARE_ROOTS"

if command -v setfacl >/dev/null 2>&1; then
  setfacl -R -m u:homemcpd:rwX -d -m u:homemcpd:rwX "$STACKS_ROOT" "$MEDIA_ROOT" "${SHARE_ARR[@]}" || true
  find "$STACKS_ROOT" -maxdepth 4 \( -name '.env*' ! -name '*.example' -o -name '*.key' -o -name '*.pem' \) -user "$ADMIN_USER" -exec setfacl -b {} + -exec chmod 600 {} + 2>/dev/null || true
fi

mkdir -p /etc/systemd/system/homemcpd.service.d
cat > /etc/systemd/system/homemcpd.service.d/40-write-paths.conf <<EOF
[Service]
ProtectHome=false
ReadWritePaths=$STACKS_ROOT $MEDIA_ROOT ${SHARE_ARR[*]}
EOF

systemctl daemon-reload
systemctl restart homemcpd.service
systemctl is-active homemcpd.service
