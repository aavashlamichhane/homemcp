# Threat Model & Security Controls

| Threat | Mitigation |
|---|---|
| **Prompt injection in container logs / journald / filenames** | Untrusted data wrapped via `wrapUntrusted(...)`; all T2/T3 mutations require out-of-band confirmation (`PlanManager` SHA-256 hash + `/confirm/:id` passkey assertion) that the LLM cannot self-approve. |
| **Secret leakage through inspect, logs, errors, or files_read** | 5-layer `Redactor` registered with every `env:` config secret scrubs tool outputs, resources, prompts, audit args, errors, and alerts. `files.read` enforces `isDeniedPath` (`.env`, `.key`, `.pem`, `.ssh`) and symlink escape rejection via `realpath`. |
| **Privilege escalation via malicious Compose YAML** | Dual-enforced `validateComposePolicy` (gateway + `stacks.apply` inside agent): blocks `privileged`, `network_mode: host`, `pid/ipc/userns: host`, `docker.sock`, sensitive host paths, `cap_add`, `devices`, and `0.0.0.0` port binds unless explicitly allowlisted. |
| **Compromised or overly broad MCP client** | Per-client OAuth 2.1 consent scope downgrade (`homemcp:read` vs `operate`/`admin`), `/mcp/:toolsets` URL filtering, PAT IP CIDR allowlists, ES256 audience-bound JWTs, and refresh token replay revocation. |
| **Cloudflare Tunnel lock-out / route corruption** | `assertSafeTunnelIngress` snapshots prior tunnel config to `cf_ingress_history`, refuses to drop `http_status:404` catch-all or protected `ssh.*`/`homemcp.*` ingress rules, and executes `expose_apply` via reverse-undo `SagaRunner`. |
