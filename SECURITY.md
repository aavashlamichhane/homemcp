# Security Policy

## Trust Model Summary

`homemcp` is built for single-owner homelab administration exposed selectively over the internet:

- **No arbitrary command execution:** `homemcpd` exposes typed, Zod-validated verbs invoking explicit absolute binary paths with `shell: false`.
- **Mandatory redaction:** Every tool output, resource read, prompt response, job log, and outbound notification passes through `@homemcp/core` `Redactor`.
- **Untrusted external data fencing:** Logs, filenames, and service metadata are tagged as `untrusted_source` / `untrusted_data` so clients treat them as data rather than instructions.
- **Human-in-the-loop guarantees:** Tier 2/3 mutations enforce `PlanManager` SHA-256 payload digests and `ConfirmationGate` out-of-band confirmation; Tier 3 operations (`expose_apply`, `unexpose_apply`, `backup_restore`, `stacks_remove`, `system_reboot`) require fresh WebAuthn passkey verification (`auth_time <= 5m`).

## Reporting Vulnerabilities

If you discover a security issue, please avoid posting live credentials, domains, or exploit payloads publicly. Open a private security advisory or contact the repository maintainer privately with reproduction steps and affected commit/version.
