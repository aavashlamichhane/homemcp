import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { ConfigError } from './errors.js';
import type { Redactor } from './redact.js';
import { TOOLSET_NAMES } from './types.js';

const ToolsetEnum = z.enum(TOOLSET_NAMES);

const EnvRefSchema = z.string().min(1);

const ComposeAllowEntrySchema = z
  .object({
    network_mode_host: z.boolean().optional(),
    docker_sock: z.boolean().optional(),
    cap_add: z.array(z.string()).optional(),
    devices: z.array(z.string()).optional(),
  })
  .strict();

export const HomemcpConfigSchema = z
  .object({
    server: z
      .object({
        publicUrl: z.string().url(),
        mcpPath: z.string().default('/mcp'),
        listen: z.string().default('0.0.0.0:8790'),
        allowedHosts: z.array(z.string()).default([]),
        trustProxy: z.boolean().default(true),
        toolsets: z.array(ToolsetEnum).default([...TOOLSET_NAMES]),
        devToken: z.string().optional(),
      })
      .strict(),
    auth: z
      .object({
        mode: z.enum(['builtin', 'oidc', 'dev']).default('builtin'),
        issuer: z.string().url(),
        owner: z
          .object({
            name: z.string().min(1),
          })
          .strict(),
        accessTokenTtl: z.string().default('15m'),
        refreshTokenTtl: z.string().default('30d'),
        clientRegistration: z
          .object({
            cimd: z.boolean().default(true),
            dcr: z.boolean().default(true),
          })
          .strict()
          .default({ cimd: true, dcr: true }),
        stepUpMaxAge: z.string().default('5m'),
        secretKey: EnvRefSchema,
      })
      .strict(),
    agent: z
      .object({
        socket: z.string().default('/run/homemcpd/homemcpd.sock'),
        url: z.string().url().optional(),
        hmacSecret: EnvRefSchema,
      })
      .strict(),
    policy: z
      .object({
        protectedContainers: z.array(z.string()).default([]),
        protectedUnits: z.array(z.string()).default([]),
        allowedUnits: z.array(z.string()).default([]),
        knownNoise: z
          .array(z.string())
          .default(['SystemCMOS', 'AE_NOT_EXIST', "Invalid key 'SYSFS'"]),
        roots: z
          .object({
            stacks: z.string().min(1),
            extraStackRoots: z.array(z.string()).default([]),
            media: z.string().min(1),
            shares: z.array(z.string()).default([]),
          })
          .strict(),
        compose: z
          .object({
            allow: z.record(z.string(), ComposeAllowEntrySchema).default({}),
            defaultLimits: z
              .object({
                mem_limit: z.string().default('512m'),
                pids_limit: z.number().int().positive().default(256),
              })
              .strict()
              .default({ mem_limit: '512m', pids_limit: 256 }),
          })
          .strict()
          .default({ allow: {}, defaultLimits: { mem_limit: '512m', pids_limit: 256 } }),
      })
      .strict(),
    modules: z
      .object({
        docker: z
          .object({
            socketProxy: z.string().url(),
          })
          .strict()
          .optional(),
        network: z
          .object({
            npm: z
              .object({
                url: z.string().url(),
                email: EnvRefSchema,
                password: EnvRefSchema,
              })
              .strict()
              .optional(),
            cloudflare: z
              .object({
                accountId: EnvRefSchema,
                tunnelId: EnvRefSchema,
                apiToken: EnvRefSchema,
                zones: z.array(z.string()).default([]),
                originService: z.string().url().default('http://192.0.2.10'),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        apps: z
          .object({
            checks: z
              .array(
                z
                  .object({
                    name: z.string().min(1),
                    url: z.string().url(),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict()
          .optional(),
        backup: z
          .object({
            statusDir: z.string().default('/var/lib/homemcp/backup'),
            budgetBytes: z.number().int().positive().default(7_000_000_000),
            sets: z
              .record(
                z.string(),
                z
                  .object({
                    rpo: z.string().min(1),
                  })
                  .strict(),
              )
              .default({}),
          })
          .strict()
          .optional(),
        vaultwarden: z
          .object({
            url: z.string().url(),
            container: z.string().default('vaultwarden'),
            publicUrl: z.string().url(),
          })
          .strict()
          .optional(),
        navidrome: z
          .object({
            url: z.string().url(),
            user: EnvRefSchema,
            password: EnvRefSchema,
          })
          .strict()
          .optional(),
        naviload: z
          .object({
            url: z.string().url(),
            token: EnvRefSchema,
          })
          .strict()
          .optional(),
        jellyfin: z
          .object({
            url: z.string().url(),
            apiKey: EnvRefSchema,
          })
          .strict()
          .optional(),
        qbittorrent: z
          .object({
            url: z.string().url(),
            user: EnvRefSchema,
            password: EnvRefSchema,
            categories: z.record(z.string(), z.string()).default({}),
          })
          .strict()
          .optional(),
        alerts: z
          .object({
            ntfy: z
              .object({
                url: EnvRefSchema,
                token: EnvRefSchema.optional(),
              })
              .strict()
              .optional(),
            healthchecks: z
              .object({
                pingUrl: EnvRefSchema.optional(),
              })
              .strict()
              .optional(),
            digestCron: z.string().default('0 8 * * *'),
            timezone: z.string().default('UTC'),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export type HomemcpConfig = z.infer<typeof HomemcpConfigSchema>;

const SECRET_FIELD_NAMES = new Set([
  'secretKey',
  'hmacSecret',
  'password',
  'apiToken',
  'token',
  'apiKey',
  'devToken',
  'url', // for ntfy topic URL which is secret-like
]);

export function resolveEnvRefs(
  raw: unknown,
  env: Record<string, string | undefined>,
  redactor?: Redactor,
): unknown {
  const walk = (node: unknown, keyHint?: string): unknown => {
    if (typeof node === 'string') {
      if (node.startsWith('env:')) {
        const varName = node.slice(4).trim();
        if (!varName) {
          throw new ConfigError('Invalid empty env: reference');
        }
        const val = env[varName];
        if (val === undefined || val === '') {
          throw new ConfigError(`Missing required environment variable: ${varName}`);
        }
        if (
          redactor &&
          keyHint &&
          (SECRET_FIELD_NAMES.has(keyHint) ||
            /(secret|token|password|key|pingUrl)/i.test(keyHint))
        ) {
          redactor.registerSecret(val);
        }
        return val;
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, k);
      }
      return out;
    }
    return node;
  };
  return walk(raw);
}

export function parseConfigObject(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
  redactor?: Redactor,
): HomemcpConfig {
  const parsed = HomemcpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid homemcp configuration: ${issues}`);
  }
  const resolved = resolveEnvRefs(parsed.data, env, redactor);
  return resolved as HomemcpConfig;
}

export async function loadConfig(
  filePath: string,
  env: Record<string, string | undefined> = process.env,
  redactor?: Redactor,
): Promise<HomemcpConfig> {
  let rawText: string;
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `Failed to read config file ${filePath}: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawText);
  } catch (err) {
    throw new ConfigError(
      `Failed to parse YAML config ${filePath}: ${err instanceof Error ? err.message : 'invalid YAML'}`,
    );
  }
  return parseConfigObject(parsedYaml, env, redactor);
}

export function parseDurationMs(expr: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(expr.trim());
  if (!m) {
    throw new ConfigError(`Invalid duration string: ${expr}`);
  }
  const num = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult =
    unit === 's'
      ? 1000
      : unit === 'm'
        ? 60_000
        : unit === 'h'
          ? 3_600_000
          : 86_400_000;
  return num * mult;
}
