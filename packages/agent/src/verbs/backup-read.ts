import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import type { VerbRegistry } from '../registry.js';

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function registerBackupReadVerbs(registry: VerbRegistry, backupStatusDir: string): void {
  registry.register({
    name: 'backup.read_status',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      status: z.record(z.string(), z.unknown()),
      snapshots: z.array(z.record(z.string(), z.unknown())),
      stats: z.record(z.string(), z.unknown()),
    }),
    handler: async () => {
      const status = await readJsonSafe<Record<string, unknown>>(
        path.join(backupStatusDir, 'status.json'),
        {},
      );
      const snapshots = await readJsonSafe<Array<Record<string, unknown>>>(
        path.join(backupStatusDir, 'snapshots.json'),
        [],
      );
      const stats = await readJsonSafe<Record<string, unknown>>(
        path.join(backupStatusDir, 'stats.json'),
        {},
      );
      return { status, snapshots, stats };
    },
  });
}
