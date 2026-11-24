# Client Setup

See ready-to-adapt sample configs in [examples/clients/](../examples/clients/).

## OAuth 2.1 Remote Endpoint (Recommended)

Point MCP clients supporting HTTP Streamable + OAuth 2.1 to:

- Full server: `https://homemcp.example.com/mcp`
- Focused toolsets (reduces context/schema tokens):
  - `https://homemcp.example.com/mcp/music,naviload`
  - `https://homemcp.example.com/mcp/system,docker,alerts`
  - `https://homemcp.example.com/mcp/stacks,network,files`

## Local / Dev Stdio

Use stdio transport (`node packages/gateway/dist/cli.js serve --transport stdio --mock` or with `--config dev/homemcp.config.yaml` over an SSH-forwarded socket).

## Headless / CI PATs

Create a scoped PAT (`auth_pat_create`) restricted by `scopes`, `toolsets`, and source `cidrs`, reveal once via `/account/pat-reveal/:id`, and send as `Authorization: Bearer hmp_...`.
