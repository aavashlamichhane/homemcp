#!/usr/bin/env bash
# Install homemcpd (Phase 1 read-only host agent)
# Run with sudo after reviewing variables: sudo ADMIN_USER=homelab STACKS_ROOT=/home/homelab/docker-containers bash install-p1.sh
set -Eeuo pipefail

ADMIN_USER="${ADMIN_USER:-homelab}"
STACKS_ROOT="${STACKS_ROOT:-/home/$ADMIN_USER/docker-containers}"
PROJECTS_ROOT="${PROJECTS_ROOT:-/home/$ADMIN_USER/projects}"
NODE_VERSION="${NODE_VERSION:-v24.13.0}"

getent group homemcp >/dev/null || groupadd --system homemcp
id -u homemcpd >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin -g homemcp -G adm,systemd-journal homemcpd
usermod -aG homemcp "$ADMIN_USER"

mkdir -p /opt/homemcp /etc/homemcp
if [ ! -x /opt/homemcp/node/bin/node ]; then
  TMPD=$(mktemp -d)
  curl -fsSLO --output-dir "$TMPD" "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSLO --output-dir "$TMPD" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  (cd "$TMPD" && grep "node-${NODE_VERSION}-linux-x64.tar.xz" SHASUMS256.txt | sha256sum -c -)
  tar -C /opt/homemcp -xJf "$TMPD/node-${NODE_VERSION}-linux-x64.tar.xz"
  ln -sfn "/opt/homemcp/node-${NODE_VERSION}-linux-x64" /opt/homemcp/node
  rm -rf "$TMPD"
fi

if [ ! -f /etc/homemcp/agent-hmac.secret ]; then
  openssl rand -hex 32 > /etc/homemcp/agent-hmac.secret
  chown root:homemcp /etc/homemcp/agent-hmac.secret
  chmod 0640 /etc/homemcp/agent-hmac.secret
fi

if command -v setfacl >/dev/null 2>&1; then
  setfacl -m u:homemcpd:rx "/home/$ADMIN_USER"
  setfacl -R -m u:homemcpd:rX -d -m u:homemcpd:rX "$STACKS_ROOT" "$PROJECTS_ROOT" || true
  find "$STACKS_ROOT" "$PROJECTS_ROOT" -maxdepth 4 \( -name '.env*' ! -name '*.example' -o -name '*.key' -o -name '*.pem' \) -exec setfacl -b {} + -exec chmod 600 {} + 2>/dev/null || true
fi

install -m 0644 "$(dirname "$0")/homemcpd.service" /etc/systemd/system/homemcpd.service
systemctl daemon-reload
systemctl enable --now homemcpd.service
systemctl is-active homemcpd.service
