# Runbook: Add & Expose a New Service Safely

1. Inspect curated templates with `stacks_templates_list()` and `stacks_template_get({ name })`.
2. Call `stacks_plan({ name, template, params })` (never author privileged or host-networked compose files).
3. Approve the confirmation link in your browser (`T2`), then call `stacks_apply({ plan_id })` — any required template secrets are generated directly into `0600` `.env` by `homemcpd`.
4. To expose over the internet: call `expose_plan({ hostname, upstream_host: name, upstream_port, access_emails })`, complete **WebAuthn passkey confirmation (`T3`)**, and call `expose_apply({ plan_id })`.
5. Verify HTTPS reachability with `network_routes({ probe: true })`.
