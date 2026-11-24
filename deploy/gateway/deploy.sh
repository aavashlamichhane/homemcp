#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Missing .env (copy from .env.example, chmod 600)"; exit 1; }
chmod 600 .env
docker compose config --quiet
docker compose build
docker compose up -d --remove-orphans
docker compose ps
