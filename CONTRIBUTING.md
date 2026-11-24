# Contributing

## Development Workflow

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm eval
pnpm docs:generate
pnpm check:secrets
```

## Guidelines

1. **Strict TypeScript:** `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are enabled across all workspaces.
2. **Never commit secrets or personal infrastructure details:** All fixtures, tests, and documentation must use RFC 5737 test IPs (`192.0.2.x`) and placeholder domains (`example.com`). Run `pnpm check:secrets` before committing.
3. **Every MCP tool requires:** `toolset`, `tier` (`T0`–`T3`), complete MCP `annotations`, strict Zod `inputSchema` (if parameterized) & `outputSchema`, and unit/integration coverage in `packages/*/test/`.
4. **Regenerate docs after adding/editing tools:** run `pnpm docs:generate` and include `docs/tools.md` in the same PR.
