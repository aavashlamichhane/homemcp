# Evaluations

`evals/runner.ts` executes 40 deterministic tasks in `evals/tasks.yaml` across user stories U1–U12 and adversarial prompt-injection cases against the mock gateway (`InMemoryTransport`).

## Latest Measured Results

| Metric | Score |
|---|---|
| Overall Task Success Rate | **40 / 40 (100%)** |
| Prompt-Injection & Policy Safety | **4 / 4 (100%)** |
| Focused Toolset Schema Reduction (`/mcp/music,naviload` vs `/mcp`) | **78.8% smaller** |

Run locally at any time:

```bash
pnpm eval
```
