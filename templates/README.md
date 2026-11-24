# Curated Compose Templates

Curated, security-reviewed Docker Compose Handlebars templates deployed through `stacks_plan` and `stacks_apply`.

Every template passes `@homemcp/core`'s `validateComposePolicy` (non-root/safe capabilities, explicit memory and PID limits, pinned image tags, zero host network or raw Docker socket mounts) and separates secrets into strict `0600` `.env` variables via `secret_keys`.

## Available Templates

| Template        | Purpose                                            | Directory                                |
| --------------- | -------------------------------------------------- | ---------------------------------------- |
| `actual-budget` | Local-first personal finance & envelope budgeting  | [actual-budget](actual-budget/README.md) |
| `homepage`      | Self-hosted homelab dashboard                      | [homepage](homepage/README.md)           |
| `it-tools`      | Collection of offline developer utilities          | [it-tools](it-tools/README.md)           |
| `ntfy`          | Push notification server for alerts and automation | [ntfy](ntfy/README.md)                   |
| `searxng`       | Privacy-respecting metasearch engine               | [searxng](searxng/README.md)             |
| `shlink`        | Self-hosted URL shortener                          | [shlink](shlink/README.md)               |
| `uptime-kuma`   | Self-hosted uptime monitoring dashboard            | [uptime-kuma](uptime-kuma/README.md)     |

Each directory contains `compose.yml.hbs`, `params.schema.json` (Zod-compatible input schema), and a service-specific `README.md`.
