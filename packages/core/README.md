# `@homemcp/core`

Shared domain primitives, configuration schemas, centralized secret redaction, Compose security policy validation, and path confinement for the `homemcp` monorepo.

## Responsibilities

- **Errors (`src/errors.ts`):** `HomemcpError` with stable error codes (`POLICY_DENIED`, `UNAUTHENTICATED`, `CONFIRMATION_REQUIRED`, `NOT_FOUND`, `CONFLICT`, `INVALID_ARGUMENT`, `INTERNAL_ERROR`, etc.) and MCP-safe error payloads.
- **Tiers & Scopes (`src/tiers.ts`):** `T0`–`T3` risk classification mapped to required OAuth scopes (`homemcp:read`, `homemcp:operate`, `homemcp:admin`, `homemcp:audit`).
- **Centralized Secret Redaction (`src/redact.ts`):** Single `Redactor` path scanning strings and nested objects for tokens, private keys, JWTs, bearer headers, env secrets, and registered secret literals (`«redacted:…»`).
- **Config Schema (`src/config.ts`):** Zod-validated YAML loader supporting `env:VAR_NAME` indirection without leaking env secrets into config dumps.
- **Compose Policy (`src/compose-policy.ts`):** `validateComposePolicy` blocks `privileged: true`, host network/PID/IPC modes, dangerous Linux capabilities, and disallowed bind mounts unless allowlisted.
- **Path Safety (`src/paths.ts`, `src/untrusted.ts`):** Root containment helpers, `isDeniedPath` denylist (`.env`, private keys), and untrusted external data wrappers.

## Development

```bash
pnpm --filter @homemcp/core build
pnpm --filter @homemcp/core typecheck
```
