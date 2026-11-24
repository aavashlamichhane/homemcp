#!/usr/bin/env bash
# Package self-contained homemcpd agent release tarball (core + agent + deploy scripts)
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/dist-release}"
VERSION="${VERSION:-0.1.0}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/homemcpd-$VERSION"

cd "$ROOT_DIR"
pnpm build
pnpm --filter @homemcp/agent deploy --prod "$OUT_DIR/homemcpd-$VERSION/agent"
cp -a deploy/agent "$OUT_DIR/homemcpd-$VERSION/scripts"

tar -C "$OUT_DIR" -czf "$OUT_DIR/homemcpd-${VERSION}-linux-amd64.tar.gz" "homemcpd-$VERSION"
sha256sum "$OUT_DIR/homemcpd-${VERSION}-linux-amd64.tar.gz" > "$OUT_DIR/homemcpd-${VERSION}-linux-amd64.tar.gz.sha256"
echo "Built $OUT_DIR/homemcpd-${VERSION}-linux-amd64.tar.gz"
