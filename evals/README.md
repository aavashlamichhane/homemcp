# Evaluation Suite (`evals/`)

Deterministic MCP evaluation harness running directly against the mock gateway (`InMemoryTransport`) to catch regressions in functionality, scope enforcement, secret redaction, safety gating, and prompt-injection resilience.

## Files

- `tasks.yaml`: 40 structured test scenarios spanning user stories `U1`–`U12`, redaction checks, tier gates, and adversarial prompt-injection cases.
- `runner.ts`: Executes every task, asserts required fields and forbidden secret substrings, measures schema size reduction across full (`/mcp`) vs focused (`/mcp/music,naviload`) toolsets, and writes `evals/results/latest.json` (git-ignored).

## Running Evals

```bash
pnpm build
pnpm eval
```

See [docs/evals.md](../docs/evals.md) for latest measured pass rates and schema reduction metrics.
