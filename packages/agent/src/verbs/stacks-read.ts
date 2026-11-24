import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { validateComposePolicy, type ComposePolicyAllowEntry } from '@homemcp/core';
import type { VerbRegistry } from '../registry.js';

export interface StacksReadConfig {
  stackRoots: readonly string[];
  mediaRoot: string;
  composeAllow: Record<string, ComposePolicyAllowEntry>;
}

const COMPOSE_FILE_RE = /^(?:docker-compose(?:\.override)?|.*compose.*)\.ya?ml$/i;

export function registerStacksReadVerbs(registry: VerbRegistry, cfg: StacksReadConfig): void {
  registry.register({
    name: 'stacks.scan',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      stacks: z.array(
        z.object({
          name: z.string(),
          root: z.string(),
          dir: z.string(),
          compose_files: z.array(z.string()),
          compose_yaml_redacted_source: z.string().optional(),
          services: z.array(
            z.object({
              name: z.string(),
              image: z.string().optional(),
              ports: z.array(z.string()),
              volumes: z.array(z.string()),
            }),
          ),
          env_files: z.array(
            z.object({
              name: z.string(),
              mode: z.string(),
              uid: z.number().int(),
              gid: z.number().int(),
              size_bytes: z.number().int(),
            }),
          ),
          policy_allowed: z.boolean(),
          policy_violations: z.array(z.object({ service: z.string(), rule: z.string(), message: z.string() })),
          policy_warnings: z.array(z.object({ service: z.string(), rule: z.string(), message: z.string() })),
        }),
      ),
    }),
    handler: async () => {
      const stacks: Array<{
        name: string;
        root: string;
        dir: string;
        compose_files: string[];
        compose_yaml_redacted_source?: string | undefined;
        services: Array<{ name: string; image?: string | undefined; ports: string[]; volumes: string[] }>;
        env_files: Array<{ name: string; mode: string; uid: number; gid: number; size_bytes: number }>;
        policy_allowed: boolean;
        policy_violations: Array<{ service: string; rule: string; message: string }>;
        policy_warnings: Array<{ service: string; rule: string; message: string }>;
      }> = [];

      for (const root of cfg.stackRoots) {
        let entries;
        try {
          entries = await readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const stackDir = path.join(root, entry.name);
          let files;
          try {
            files = await readdir(stackDir, { withFileTypes: true });
          } catch {
            continue;
          }

          const composeFiles = files
            .filter((f) => f.isFile() && COMPOSE_FILE_RE.test(f.name) && !f.name.includes('.bak-'))
            .map((f) => f.name)
            .sort();

          if (composeFiles.length === 0) continue;

          // Stat .env* files ONLY — NEVER read their contents
          const envFiles: Array<{
            name: string;
            mode: string;
            uid: number;
            gid: number;
            size_bytes: number;
          }> = [];
          for (const f of files) {
            if (f.isFile() && f.name.startsWith('.env') && !f.name.endsWith('.example')) {
              try {
                const st = await stat(path.join(stackDir, f.name));
                envFiles.push({
                  name: f.name,
                  mode: (st.mode & 0o777).toString(8).padStart(4, '0'),
                  uid: st.uid,
                  gid: st.gid,
                  size_bytes: st.size,
                });
              } catch {
                // ignore
              }
            }
          }

          const primary =
            composeFiles.find((f) => f === 'docker-compose.yml' || f === 'docker-compose.yaml') ??
            composeFiles[0]!;
          let rawCompose = '';
          try {
            rawCompose = await readFile(path.join(stackDir, primary), 'utf8');
          } catch {
            rawCompose = '';
          }

          const servicesList: Array<{
            name: string;
            image?: string | undefined;
            ports: string[];
            volumes: string[];
          }> = [];
          if (rawCompose) {
            try {
              const doc = parseYaml(rawCompose) as { services?: Record<string, Record<string, unknown>> };
              for (const [svcName, svc] of Object.entries(doc?.services ?? {})) {
                const ports = Array.isArray(svc['ports'])
                  ? svc['ports'].map((p) => (typeof p === 'string' || typeof p === 'number' ? String(p) : JSON.stringify(p)))
                  : [];
                const volumes = Array.isArray(svc['volumes'])
                  ? svc['volumes'].map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
                  : [];
                servicesList.push({
                  name: svcName,
                  ...(typeof svc['image'] === 'string' ? { image: svc['image'] } : {}),
                  ports,
                  volumes,
                });
              }
            } catch {
              // ignore yaml parse error; policy check will flag it
            }
          }

          const policy = validateComposePolicy(rawCompose, {
            stackName: entry.name,
            stackDir,
            allowedBindRoots: [stackDir, cfg.mediaRoot],
            allow: cfg.composeAllow,
          });

          stacks.push({
            name: entry.name,
            root,
            dir: stackDir,
            compose_files: composeFiles,
            ...(rawCompose ? { compose_yaml_redacted_source: rawCompose } : {}),
            services: servicesList,
            env_files: envFiles,
            policy_allowed: policy.allowed,
            policy_violations: policy.violations,
            policy_warnings: policy.warnings,
          });
        }
      }

      return { stacks };
    },
  });
}
