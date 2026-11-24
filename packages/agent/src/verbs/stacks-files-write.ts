import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import {
  HomemcpError,
  isDeniedPath,
  resolveAgainstAllowedRoots,
  resolveSafePath,
  validateComposePolicy,
  type ComposePolicyAllowEntry,
} from '@homemcp/core';
import type { CommandRunner } from '../exec.js';
import type { VerbRegistry } from '../registry.js';

const MAX_FILE_READ_BYTES = 262_144; // 256 KB

export function registerStacksFilesWriteVerbs(
  registry: VerbRegistry,
  opts: {
    runner: CommandRunner;
    stacksRoot: string;
    extraStackRoots: readonly string[];
    allowedFileRoots: readonly string[];
    mediaRoot: string;
    composeAllow: Record<string, ComposePolicyAllowEntry>;
  },
): void {
  const allStackRoots = [opts.stacksRoot, ...opts.extraStackRoots].filter(Boolean);
  const allFileRoots = [
    ...new Set([...allStackRoots, opts.mediaRoot, ...opts.allowedFileRoots]),
  ].filter(Boolean);

  registry.register({
    name: 'stacks.apply',
    inputSchema: z
      .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        compose_yaml: z.string().min(10),
        secret_keys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
        extra_env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).default({}),
        start: z.boolean().default(true),
      })
      .strict(),
    outputSchema: z.object({
      name: z.string(),
      stack_dir: z.string(),
      generated_secret_keys: z.array(z.string()),
      started: z.boolean(),
      warnings: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async ({ name, compose_yaml, secret_keys, extra_env, start }) => {
      await mkdir(opts.stacksRoot, { recursive: true });
      const stackDir = await resolveSafePath(opts.stacksRoot, name);

      // Defense-in-depth: validate compose policy INSIDE the privileged agent before writing any file
      const policy = validateComposePolicy(compose_yaml, {
        stackName: name,
        stackDir,
        allowedBindRoots: [stackDir, opts.mediaRoot],
        allow: opts.composeAllow,
      });
      if (!policy.allowed) {
        throw new HomemcpError(
          'POLICY_DENIED',
          `Compose policy rejected stack "${name}": ${policy.violations.map((v) => v.message).join('; ')}`,
        );
      }

      await mkdir(stackDir, { recursive: true, mode: 0o755 });
      const composePath = path.join(stackDir, 'docker-compose.yml');
      await writeFile(composePath, compose_yaml, { encoding: 'utf8', mode: 0o644 });

      // Generate secrets directly into 0600 .env without EVER returning their values
      const generatedKeys: string[] = [];
      if (secret_keys.length > 0 || Object.keys(extra_env).length > 0) {
        const envPath = path.join(stackDir, '.env');
        let existingEnv = '';
        try {
          existingEnv = await readFile(envPath, 'utf8');
        } catch {
          existingEnv = '';
        }
        const existingKeys = new Set(
          existingEnv
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#') && l.includes('='))
            .map((l) => l.slice(0, l.indexOf('=')).trim()),
        );
        const linesToAppend: string[] = [];
        for (const k of secret_keys) {
          if (!existingKeys.has(k)) {
            const secret = randomBytes(32).toString('base64url');
            linesToAppend.push(`${k}=${secret}`);
            generatedKeys.push(k);
          }
        }
        for (const [k, v] of Object.entries(extra_env)) {
          if (!existingKeys.has(k)) {
            linesToAppend.push(`${k}=${v}`);
          }
        }
        if (linesToAppend.length > 0) {
          const nextContent =
            existingEnv && !existingEnv.endsWith('\n')
              ? `${existingEnv}\n${linesToAppend.join('\n')}\n`
              : `${existingEnv}${linesToAppend.join('\n')}\n`;
          await writeFile(envPath, nextContent, { encoding: 'utf8', mode: 0o600 });
          await chmod(envPath, 0o600);
        }
      }

      if (start) {
        await opts.runner.run('/usr/bin/docker', ['compose', 'pull'], {
          cwd: stackDir,
          timeoutMs: 180_000,
        });
        await opts.runner.run('/usr/bin/docker', ['compose', 'up', '-d'], {
          cwd: stackDir,
          timeoutMs: 120_000,
        });
      }

      return {
        name,
        stack_dir: stackDir,
        generated_secret_keys: generatedKeys,
        started: start,
        warnings: policy.warnings as unknown as Array<Record<string, unknown>>,
      };
    },
  });

  registry.register({
    name: 'stacks.up',
    inputSchema: z.object({ stack_dir: z.string().min(1) }).strict(),
    outputSchema: z.object({ stack_dir: z.string(), status: z.string() }),
    handler: async ({ stack_dir }) => {
      const resolved = (await resolveAgainstAllowedRoots(allStackRoots, stack_dir)).resolved;
      await opts.runner.run('/usr/bin/docker', ['compose', 'up', '-d'], {
        cwd: resolved,
        timeoutMs: 120_000,
      });
      return { stack_dir: resolved, status: 'up' };
    },
  });

  registry.register({
    name: 'stacks.down',
    inputSchema: z.object({ stack_dir: z.string().min(1) }).strict(),
    outputSchema: z.object({ stack_dir: z.string(), status: z.string() }),
    handler: async ({ stack_dir }) => {
      const resolved = (await resolveAgainstAllowedRoots(allStackRoots, stack_dir)).resolved;
      await opts.runner.run('/usr/bin/docker', ['compose', 'down'], {
        cwd: resolved,
        timeoutMs: 90_000,
      });
      return { stack_dir: resolved, status: 'down' };
    },
  });

  registry.register({
    name: 'stacks.remove',
    inputSchema: z.object({ stack_dir: z.string().min(1) }).strict(),
    outputSchema: z.object({ stack_dir: z.string(), trash_path: z.string() }),
    handler: async ({ stack_dir }) => {
      const match = await resolveAgainstAllowedRoots(allStackRoots, stack_dir);
      const resolved = match.resolved;
      if (resolved === match.root) {
        throw new HomemcpError('POLICY_DENIED', 'Cannot remove entire stacks root');
      }
      await opts.runner.run('/usr/bin/docker', ['compose', 'down'], {
        cwd: resolved,
        allowNonZero: true,
        timeoutMs: 90_000,
      });
      const trashRoot = path.join(opts.stacksRoot, '.trash');
      await mkdir(trashRoot, { recursive: true });
      const trashDest = path.join(trashRoot, `${path.basename(resolved)}-${Date.now()}`);
      await rename(resolved, trashDest);
      return { stack_dir: resolved, trash_path: trashDest };
    },
  });

  registry.register({
    name: 'files.list',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.object({
      path: z.string(),
      entries: z.array(
        z.object({
          name: z.string(),
          type: z.enum(['file', 'dir', 'other']),
          size_bytes: z.number(),
          mtime: z.string(),
        }),
      ),
    }),
    handler: async ({ path: target }) => {
      const { resolved } = await resolveAgainstAllowedRoots(allFileRoots, target);
      const names = await readdir(resolved);
      const entries = await Promise.all(
        names.slice(0, 500).map(async (name) => {
          const full = path.join(resolved, name);
          const st = await stat(full);
          return {
            name,
            type: st.isDirectory()
              ? ('dir' as const)
              : st.isFile()
                ? ('file' as const)
                : ('other' as const),
            size_bytes: st.size,
            mtime: st.mtime.toISOString(),
          };
        }),
      );
      return { path: resolved, entries };
    },
  });

  registry.register({
    name: 'files.stat',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.object({
      path: z.string(),
      type: z.enum(['file', 'dir', 'other']),
      size_bytes: z.number(),
      mode: z.string(),
      mtime: z.string(),
    }),
    handler: async ({ path: target }) => {
      const { resolved } = await resolveAgainstAllowedRoots(allFileRoots, target);
      const st = await stat(resolved);
      const fileType: 'file' | 'dir' | 'other' = st.isDirectory()
        ? 'dir'
        : st.isFile()
          ? 'file'
          : 'other';
      return {
        path: resolved,
        type: fileType,
        size_bytes: st.size,
        mode: `0${(st.mode & 0o777).toString(8)}`,
        mtime: st.mtime.toISOString(),
      };
    },
  });

  registry.register({
    name: 'files.search',
    inputSchema: z
      .object({
        root: z.string().min(1),
        pattern: z.string().min(1),
        max_results: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    outputSchema: z.object({ matches: z.array(z.string()) }),
    handler: async ({ root, pattern, max_results }) => {
      const { resolved } = await resolveAgainstAllowedRoots(allFileRoots, root);
      const q = pattern.toLowerCase();
      const matches: string[] = [];
      async function walk(dir: string, depth: number): Promise<void> {
        if (depth > 4 || matches.length >= max_results) return;
        const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const item of items) {
          if (matches.length >= max_results) break;
          if (item.name === 'node_modules' || item.name === '.git') continue;
          const full = path.join(dir, item.name);
          if (item.name.toLowerCase().includes(q) && !isDeniedPath(full)) {
            matches.push(full);
          }
          if (item.isDirectory()) {
            await walk(full, depth + 1);
          }
        }
      }
      await walk(resolved, 0);
      return { matches };
    },
  });

  registry.register({
    name: 'files.disk_usage',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.object({
      path: z.string(),
      total_bytes: z.number(),
      children: z.array(z.object({ name: z.string(), bytes: z.number() })),
    }),
    handler: async ({ path: target }) => {
      const { resolved } = await resolveAgainstAllowedRoots(allFileRoots, target);
      const names = await readdir(resolved).catch(() => []);
      const children: Array<{ name: string; bytes: number }> = [];
      let total = 0;
      for (const name of names.slice(0, 100)) {
        const st = await stat(path.join(resolved, name)).catch(() => null);
        if (st) {
          children.push({ name, bytes: st.size });
          total += st.size;
        }
      }
      return { path: resolved, total_bytes: total, children };
    },
  });

  registry.register({
    name: 'files.read',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.object({ path: z.string(), content: z.string(), size_bytes: z.number() }),
    handler: async ({ path: target }) => {
      if (isDeniedPath(target)) {
        throw new HomemcpError(
          'POLICY_DENIED',
          `Reading sensitive/denied file is forbidden: ${target}`,
        );
      }
      const { resolved } = await resolveAgainstAllowedRoots(allFileRoots, target);
      if (isDeniedPath(resolved)) {
        throw new HomemcpError('POLICY_DENIED', `Resolved target matches deny-list: ${resolved}`);
      }
      const st = await stat(resolved);
      if (!st.isFile()) {
        throw new HomemcpError('INVALID_ARGUMENT', `Not a regular file: ${resolved}`);
      }
      if (st.size > MAX_FILE_READ_BYTES) {
        throw new HomemcpError(
          'INVALID_ARGUMENT',
          `File size ${st.size} exceeds 256KB read limit (${MAX_FILE_READ_BYTES})`,
        );
      }
      const buf = await readFile(resolved);
      if (buf.includes(0)) {
        throw new HomemcpError('INVALID_ARGUMENT', 'Binary file cannot be read as UTF-8 text');
      }
      return { path: resolved, content: buf.toString('utf8'), size_bytes: st.size };
    },
  });

  registry.register({
    name: 'files.mkdir',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.object({ path: z.string(), created: z.boolean() }),
    handler: async ({ path: target }) => {
      const { resolved } = await resolveAgainstAllowedRoots(allFileRoots, target);
      await mkdir(resolved, { recursive: true });
      return { path: resolved, created: true };
    },
  });

  registry.register({
    name: 'files.write',
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(),
    outputSchema: z.object({ path: z.string(), bytes_written: z.number().int() }),
    handler: async ({ path: target, content }) => {
      if (isDeniedPath(target)) {
        throw new HomemcpError('POLICY_DENIED', `Writing to denied file is forbidden: ${target}`);
      }
      const { resolved } = await resolveAgainstAllowedRoots(allStackRoots, target);
      if (isDeniedPath(resolved)) {
        throw new HomemcpError('POLICY_DENIED', `Writing to denied path is forbidden: ${resolved}`);
      }
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf8');
      return { path: resolved, bytes_written: Buffer.byteLength(content, 'utf8') };
    },
  });

  registry.register({
    name: 'files.move',
    inputSchema: z
      .object({
        src: z.string().min(1),
        dst: z.string().min(1),
        overwrite: z.boolean().default(false),
      })
      .strict(),
    outputSchema: z.object({ src: z.string(), dst: z.string(), moved: z.boolean() }),
    handler: async ({ src, dst, overwrite }) => {
      const { resolved: safeSrc } = await resolveAgainstAllowedRoots(allFileRoots, src);
      const { resolved: safeDst } = await resolveAgainstAllowedRoots(allFileRoots, dst);
      if (isDeniedPath(safeSrc) || isDeniedPath(safeDst)) {
        throw new HomemcpError('POLICY_DENIED', 'Cannot move denied paths');
      }
      if (!overwrite) {
        const exists = await stat(safeDst).then(
          () => true,
          () => false,
        );
        if (exists) {
          throw new HomemcpError('CONFLICT', `Destination exists and overwrite=false: ${safeDst}`);
        }
      }
      await mkdir(path.dirname(safeDst), { recursive: true });
      await rename(safeSrc, safeDst);
      return { src: safeSrc, dst: safeDst, moved: true };
    },
  });

  registry.register({
    name: 'files.trash',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.object({ original: z.string(), trash_path: z.string() }),
    handler: async ({ path: target }) => {
      const match = await resolveAgainstAllowedRoots(allFileRoots, target);
      if (match.resolved === match.root) {
        throw new HomemcpError('POLICY_DENIED', 'Cannot trash an entire root directory');
      }
      const trashRoot = path.join(match.root, '.trash');
      await mkdir(trashRoot, { recursive: true });
      const trashDest = path.join(trashRoot, `${path.basename(match.resolved)}-${Date.now()}`);
      await rename(match.resolved, trashDest);
      return { original: match.resolved, trash_path: trashDest };
    },
  });
}
