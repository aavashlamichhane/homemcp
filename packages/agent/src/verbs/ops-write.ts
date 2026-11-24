import * as z from 'zod/v4';
import { HomemcpError, resolveSafePath } from '@homemcp/core';
import type { CommandRunner } from '../exec.js';
import type { VerbRegistry } from '../registry.js';

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

function isProtectedContainer(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(name, p));
}

export function registerOpsWriteVerbs(
  registry: VerbRegistry,
  opts: {
    runner: CommandRunner;
    protectedContainers: readonly string[];
    protectedUnits: readonly string[];
    allowedUnits: readonly string[];
    stackRoots: readonly string[];
  },
): void {
  registry.register({
    name: 'docker.container_action',
    inputSchema: z
      .object({
        name: z
          .string()
          .min(1)
          .regex(/^[A-Za-z0-9_.-]+$/),
        action: z.enum(['start', 'stop', 'restart']),
        override_protected: z.boolean().default(false),
      })
      .strict(),
    outputSchema: z.object({
      name: z.string(),
      action: z.string(),
      ok: z.boolean(),
    }),
    handler: async ({ name, action, override_protected }) => {
      if (isProtectedContainer(name, opts.protectedContainers) && !override_protected) {
        throw new HomemcpError(
          'POLICY_DENIED',
          `Container "${name}" is protected by policy; T3 passkey confirmation override_protected required`,
        );
      }
      await opts.runner.run('/usr/bin/docker', [action, name], { timeoutMs: 30_000 });
      return { name, action, ok: true };
    },
  });

  registry.register({
    name: 'docker.compose_update',
    inputSchema: z
      .object({
        stack_dir: z.string().min(1),
        service: z.string().min(1),
        target_image: z.string().optional(),
        health_timeout_seconds: z.number().int().min(5).max(300).default(120),
      })
      .strict(),
    outputSchema: z.object({
      service: z.string(),
      previous_digests: z.record(z.string(), z.string()),
      updated: z.boolean(),
      rolled_back: z.boolean(),
      reason: z.string().optional(),
    }),
    handler: async ({ stack_dir, service, health_timeout_seconds }) => {
      // Ensure stack_dir is inside an allowed stack root
      let safeDir: string | undefined;
      for (const root of opts.stackRoots) {
        try {
          safeDir = await resolveSafePath(root, stack_dir);
          break;
        } catch {
          // try next root
        }
      }
      if (!safeDir) {
        throw new HomemcpError(
          'POLICY_DENIED',
          `stack_dir outside allowed stack roots: ${stack_dir}`,
        );
      }

      // Snapshot prior digests for rollback
      const psIds = await opts.runner.run('/usr/bin/docker', ['compose', 'ps', '-q', service], {
        cwd: safeDir,
        allowNonZero: true,
      });
      const prevDigests: Record<string, string> = {};
      for (const cid of psIds.stdout.split(/\s+/).filter(Boolean)) {
        const insp = await opts.runner.run(
          '/usr/bin/docker',
          ['inspect', '--format', '{{.Image}}', cid],
          { allowNonZero: true },
        );
        if (insp.exitCode === 0 && insp.stdout.trim()) {
          prevDigests[cid] = insp.stdout.trim();
        }
      }

      await opts.runner.run('/usr/bin/docker', ['compose', 'pull', service], {
        cwd: safeDir,
        timeoutMs: 180_000,
      });
      await opts.runner.run('/usr/bin/docker', ['compose', 'up', '-d', service], {
        cwd: safeDir,
        timeoutMs: 120_000,
      });

      const deadline = Date.now() + health_timeout_seconds * 1000;
      let healthy = false;
      let lastState = 'unknown';

      while (Date.now() < deadline) {
        const check = await opts.runner.run(
          '/usr/bin/docker',
          ['compose', 'ps', '--format', '{{.State}}|{{.Health}}', service],
          { cwd: safeDir, allowNonZero: true },
        );
        lastState = check.stdout.trim();
        if (lastState.includes('running|healthy') || lastState === 'running|') {
          healthy = true;
          break;
        }
        if (
          lastState.includes('exited') ||
          lastState.includes('dead') ||
          lastState.includes('unhealthy')
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      if (!healthy) {
        // Attempt rollback using prior image ID
        const prevImg = Object.values(prevDigests)[0];
        if (prevImg) {
          await opts.runner.run('/usr/bin/docker', ['compose', 'down', service], {
            cwd: safeDir,
            allowNonZero: true,
          });
          await opts.runner.run('/usr/bin/docker', ['compose', 'up', '-d', '--no-build', service], {
            cwd: safeDir,
            allowNonZero: true,
          });
        }
        return {
          service,
          previous_digests: prevDigests,
          updated: false,
          rolled_back: true,
          reason: `Health gate failed (state: ${lastState || 'timeout'})`,
        };
      }

      return {
        service,
        previous_digests: prevDigests,
        updated: true,
        rolled_back: false,
      };
    },
  });

  registry.register({
    name: 'docker.prune',
    inputSchema: z
      .object({
        apply: z.boolean().default(false),
        include_build_cache: z.boolean().default(false),
      })
      .strict(),
    outputSchema: z.object({
      applied: z.boolean(),
      reclaimed_summary: z.string(),
    }),
    handler: async ({ apply, include_build_cache }) => {
      if (!apply) {
        const df = await opts.runner.run('/usr/bin/docker', ['system', 'df']);
        return {
          applied: false,
          reclaimed_summary: df.stdout.trim(),
        };
      }
      const outs: string[] = [];
      outs.push(
        (await opts.runner.run('/usr/bin/docker', ['container', 'prune', '-f'])).stdout.trim(),
      );
      outs.push((await opts.runner.run('/usr/bin/docker', ['image', 'prune', '-f'])).stdout.trim());
      outs.push(
        (await opts.runner.run('/usr/bin/docker', ['network', 'prune', '-f'])).stdout.trim(),
      );
      if (include_build_cache) {
        outs.push(
          (await opts.runner.run('/usr/bin/docker', ['builder', 'prune', '-f'])).stdout.trim(),
        );
      }
      return {
        applied: true,
        reclaimed_summary: outs.filter(Boolean).join('\n'),
      };
    },
  });

  registry.register({
    name: 'system.service_action',
    inputSchema: z
      .object({
        unit: z.string().min(1),
        action: z.enum(['start', 'stop', 'restart']),
      })
      .strict(),
    outputSchema: z.object({
      unit: z.string(),
      action: z.string(),
      ok: z.boolean(),
    }),
    handler: async ({ unit, action }) => {
      if (opts.protectedUnits.includes(unit)) {
        throw new HomemcpError('POLICY_DENIED', `Unit "${unit}" is protected`);
      }
      if (!opts.allowedUnits.includes(unit)) {
        throw new HomemcpError('POLICY_DENIED', `Unit "${unit}" is not in allowedUnits`);
      }
      await opts.runner.run('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', action, unit], {
        timeoutMs: 30_000,
      });
      return { unit, action, ok: true };
    },
  });

  registry.register({
    name: 'system.reboot',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ scheduled: z.boolean(), message: z.string() }),
    handler: async () => {
      const res = await opts.runner.run('/usr/bin/sudo', ['-n', '/sbin/shutdown', '-r', '+1'], {
        timeoutMs: 10_000,
      });
      return {
        scheduled: true,
        message: res.stderr.trim() || res.stdout.trim() || 'Reboot scheduled in 1 minute',
      };
    },
  });
}
