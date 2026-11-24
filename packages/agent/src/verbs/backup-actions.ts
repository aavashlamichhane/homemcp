import * as z from 'zod/v4';
import type { CommandRunner } from '../exec.js';
import type { VerbRegistry } from '../registry.js';

export const BACKUP_SETS = [
  'vaultwarden',
  'configs',
  'npm',
  'navidrome',
  'system',
  'jellyfin',
  'userdata',
  'all',
] as const;

export function registerBackupActionVerbs(registry: VerbRegistry, runner: CommandRunner): void {
  registry.register({
    name: 'backup.run',
    inputSchema: z
      .object({
        set: z.enum(BACKUP_SETS),
      })
      .strict(),
    outputSchema: z.object({
      set: z.string(),
      exit_code: z.number().int(),
      output: z.string(),
    }),
    handler: async ({ set }) => {
      const res = await runner.run(
        '/usr/bin/sudo',
        ['-n', '/usr/local/sbin/homemcp-backup', 'run', set],
        { timeoutMs: 300_000, allowNonZero: true },
      );
      return {
        set,
        exit_code: res.exitCode,
        output: `${res.stdout}\n${res.stderr}`.trim().slice(-8000),
      };
    },
  });

  registry.register({
    name: 'backup.verify',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      exit_code: z.number().int(),
      output: z.string(),
    }),
    handler: async () => {
      const res = await runner.run(
        '/usr/bin/sudo',
        ['-n', '/usr/local/sbin/homemcp-backup', 'maint'],
        { timeoutMs: 300_000, allowNonZero: true },
      );
      return {
        exit_code: res.exitCode,
        output: `${res.stdout}\n${res.stderr}`.trim().slice(-8000),
      };
    },
  });

  registry.register({
    name: 'backup.restore_test',
    inputSchema: z
      .object({
        set: z.enum(['vaultwarden']).default('vaultwarden'),
        snapshot_id: z
          .string()
          .regex(/^(?:latest|[a-f0-9]{6,64})$/)
          .default('latest'),
      })
      .strict(),
    outputSchema: z.object({
      set: z.string(),
      exit_code: z.number().int(),
      output: z.string(),
    }),
    handler: async ({ set, snapshot_id }) => {
      const cmdArgs =
        snapshot_id === 'latest'
          ? ['-n', '/usr/local/sbin/homemcp-backup', 'restore-test', set]
          : ['-n', '/usr/local/sbin/homemcp-backup', 'restore-test', set, snapshot_id];
      const res = await runner.run('/usr/bin/sudo', cmdArgs, {
        timeoutMs: 180_000,
        allowNonZero: true,
      });
      return {
        set,
        exit_code: res.exitCode,
        output: `${res.stdout}\n${res.stderr}`.trim().slice(-8000),
      };
    },
  });

  registry.register({
    name: 'backup.restore_staging',
    inputSchema: z
      .object({
        set: z.enum([
          'vaultwarden',
          'configs',
          'npm',
          'navidrome',
          'system',
          'jellyfin',
          'userdata',
        ]),
        snapshot_id: z
          .string()
          .regex(/^(?:latest|[a-f0-9]{6,64})$/)
          .default('latest'),
        staging_subdir: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,40}$/)
          .default('manual-restore'),
      })
      .strict(),
    outputSchema: z.object({
      set: z.string(),
      snapshot_id: z.string(),
      staging_target: z.string(),
      exit_code: z.number().int(),
      output: z.string(),
    }),
    handler: async ({ set, snapshot_id, staging_subdir }) => {
      const res = await runner.run(
        '/usr/bin/sudo',
        [
          '-n',
          '/usr/local/sbin/homemcp-backup',
          'restore-staging',
          set,
          snapshot_id,
          staging_subdir,
        ],
        { timeoutMs: 300_000, allowNonZero: true },
      );
      return {
        set,
        snapshot_id,
        staging_target: `/var/lib/homemcp/backup/staging-restore/${staging_subdir}`,
        exit_code: res.exitCode,
        output: `${res.stdout}\n${res.stderr}`.trim().slice(-8000),
      };
    },
  });

  registry.register({
    name: 'backup.prune_set',
    inputSchema: z
      .object({
        set: z.enum([
          'vaultwarden',
          'configs',
          'npm',
          'navidrome',
          'system',
          'jellyfin',
          'userdata',
        ]),
        dry_run: z.boolean().default(true),
      })
      .strict(),
    outputSchema: z.object({
      set: z.string(),
      dry_run: z.boolean(),
      exit_code: z.number().int(),
      output: z.string(),
    }),
    handler: async ({ set, dry_run }) => {
      const args = dry_run
        ? ['-n', '/usr/local/sbin/homemcp-backup', 'prune-set', set, '--dry-run']
        : ['-n', '/usr/local/sbin/homemcp-backup', 'prune-set', set];
      const res = await runner.run('/usr/bin/sudo', args, {
        timeoutMs: 300_000,
        allowNonZero: true,
      });
      return {
        set,
        dry_run,
        exit_code: res.exitCode,
        output: `${res.stdout}\n${res.stderr}`.trim().slice(-8000),
      };
    },
  });
}
