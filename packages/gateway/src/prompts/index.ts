import * as z from 'zod/v4';
import type { GatewayDeps } from '../server/factory.js';

export function registerPrompts(deps: GatewayDeps): void {
  const { registry } = deps;

  registry.registerPrompt({
    name: 'triage_service',
    title: 'Triage Service',
    description: 'Investigate health, logs, routes, and resource usage for one service',
    argsSchema: z.object({
      service: z.string().describe('Container or stack name to inspect'),
    }),
    handler: (args) => {
      const service = typeof args['service'] === 'string' ? args['service'] : 'navidrome';
      return Promise.resolve({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Diagnose service "${service}" on the homelab server:
1. Call docker_service_profile({ name: "${service}" }) for full metadata, health, mounts, routes, and recent log errors.
2. Call docker_stats({ name: "${service}" }) and docker_logs({ name: "${service}", tail: 200 }) if errors appear.
3. Call system_health() if host resource pressure is suspected.
Summarize findings clearly and recommend safe next steps.`,
            },
          },
        ],
      });
    },
  });

  registry.registerPrompt({
    name: 'security_review',
    title: 'Security Review',
    description: 'Audit host firewall, SSH, listening ports, public routes, and Vaultwarden posture',
    handler: () =>
      Promise.resolve({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Perform a read-only security posture review:
1. Call system_security_audit() to inspect UFW, sshd, wildcard listeners, failed SSH logins, and Tailscale.
2. Call network_audit() and network_routes({ probe: false }) to review public hostnames without Cloudflare Access and stale routes.
3. Call vaultwarden_health() and backup_status({ set: "vaultwarden" }).
Report any findings sorted by severity.`,
            },
          },
        ],
      }),
  });
}
