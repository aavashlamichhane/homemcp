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

export function registerBackupActionVerbs(
  registry: VerbRegistry,
  runner: CommandRunner,
): void {
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
        ['-n', '/usr/local/sbin/homemcp-backup', 'restore-test', set],
        { timeoutMs: 180_000, allowNonZero: true },
      );
      return {
        set,
        exit_code: res.exitCode,
        output: `${res.stdout}\n${res.stderr}`.trim().slice(-8000),
      };
    },
  });
}
