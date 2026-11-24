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

  registry.registerPrompt({
    name: 'build_playlist',
    title: 'Build Playlist',
    description: 'Find matching songs in Navidrome, search YouTube for missing songs via NaviLoad, and build a playlist',
    argsSchema: z.object({
      name: z.string().describe('Playlist name'),
      theme_or_songs: z.string().describe('Theme or comma/newline-separated artist - title list'),
    }),
    handler: (args) => {
      const name = typeof args['name'] === 'string' ? args['name'] : 'Road Trip';
      const songs = typeof args['theme_or_songs'] === 'string' ? args['theme_or_songs'] : '';
      return Promise.resolve({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Build Navidrome playlist "${name}" from: ${songs}
1. Call music_build_playlist({ name: "${name}", tracks: [...] }).
2. Present matched tracks and missing YouTube candidates clearly so the user chooses which to download.
3. Call music_build_playlist_apply with the selected candidates, then check naviload_review_list for staged tracks requiring human metadata review.`,
            },
          },
        ],
      });
    },
  });

  registry.registerPrompt({
    name: 'daily_briefing',
    title: 'Daily Server Briefing',
    description: 'Summarize open alerts, host health, backup freshness, downloads, and media sessions',
    handler: () =>
      Promise.resolve({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Prepare a concise daily briefing:
1. Call homemcp_overview(), alerts_list({ include_resolved: false }), and backup_status().
2. Call jellyfin_health() and downloads_status({ filter: "all" }) if enabled.
Highlight anything requiring attention today.`,
            },
          },
        ],
      }),
  });

  registry.registerPrompt({
    name: 'weekly_health_report',
    title: 'Weekly Health Report',
    description: 'Summarize 7-day disk trends, journal errors, updates, and backup integrity',
    handler: () =>
      Promise.resolve({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Compile a weekly health report:
1. Call system_disks(), system_errors_summary({ since: "7d" }), and system_updates().
2. Call backup_status(), network_audit(), and jellyfin_find_problems({ limit: 50 }).`,
            },
          },
        ],
      }),
  });

  registry.registerPrompt({
    name: 'restore_drill',
    title: 'Backup Restore Drill',
    description: 'Verify backup integrity and perform a safe restore test for a set',
    argsSchema: z.object({ set: z.string().default('vaultwarden') }),
    handler: (args) => {
      const set = typeof args['set'] === 'string' ? args['set'] : 'vaultwarden';
      return Promise.resolve({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Run a non-destructive restore drill for "${set}":
1. Call backup_status({ set: "${set}" }) and backup_snapshots({ set: "${set}" }).
2. Call backup_restore_test({ set: "vaultwarden" }) (or backup_verify() for repository verification).`,
            },
          },
        ],
      });
    },
  });

  registry.registerPrompt({
    name: 'deploy_service',
    title: 'Deploy & Expose Service',
    description: 'Plan deploying a curated Compose template and optionally exposing it via NPM + Cloudflare',
    argsSchema: z.object({
      name: z.string(),
      template: z.string().default('uptime-kuma'),
      hostname: z.string().optional(),
      access: z.boolean().default(false),
    }),
    handler: (args) => {
      const name = typeof args['name'] === 'string' ? args['name'] : 'uptime-kuma';
      const template = typeof args['template'] === 'string' ? args['template'] : 'uptime-kuma';
      const hostname = typeof args['hostname'] === 'string' ? args['hostname'] : '';
      return Promise.resolve({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Deploy service "${name}" using template "${template}"${hostname ? ` and expose at https://${hostname}` : ''}:
1. Call stacks_template_get({ name: "${template}" }) and stacks_plan({ name: "${name}", template: "${template}" }).
2. Guide user through confirming the plan URL, then call stacks_apply.
${hostname ? `3. Call expose_plan({ hostname: "${hostname}", upstream_host: "${name}", upstream_port: ... }) and expose_apply after passkey confirmation.` : ''}`,
            },
          },
        ],
      });
    },
  });

  registry.registerPrompt({
    name: 'disk_cleanup',
    title: 'Disk Cleanup Assessment',
    description: 'Inspect disk usage trends, Docker reclaimable space, and media/files directories safely',
    handler: () =>
      Promise.resolve({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Investigate disk usage and safe cleanup options:
1. Call system_disks(), docker_disk_usage(), and files_disk_usage on media/share roots.
2. Call docker_prune_plan({ include_build_cache: false }) if Docker bloat is significant.
3. Recommend safe deletions via files_trash (never permanent rm without user confirmation).`,
            },
          },
        ],
      }),
  });
}
