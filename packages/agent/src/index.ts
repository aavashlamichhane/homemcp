import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Redactor, type ComposePolicyAllowEntry } from '@homemcp/core';
import { AGENT_ALLOWED_BINARIES, ExecaCommandRunner } from './exec.js';
import { VerbRegistry } from './registry.js';
import { startAgentServer } from './server.js';
import { registerBackupActionVerbs } from './verbs/backup-actions.js';
import { registerBackupReadVerbs } from './verbs/backup-read.js';
import { registerOpsWriteVerbs } from './verbs/ops-write.js';
import { registerStacksReadVerbs } from './verbs/stacks-read.js';
import { registerSystemReadVerbs } from './verbs/system-read.js';

export * from './auth.js';
export * from './exec.js';
export * from './registry.js';
export * from './server.js';
export * from './verbs/system-read.js';
export * from './verbs/stacks-read.js';
export * from './verbs/backup-read.js';
export * from './verbs/backup-actions.js';
export * from './verbs/ops-write.js';

interface AgentFileConfig {
  protectedContainers?: string[];
  protectedUnits?: string[];
  allowedUnits?: string[];
  knownNoise?: string[];
  stackRoots?: string[];
  mediaRoot?: string;
  backupStatusDir?: string;
  composeAllow?: Record<string, ComposePolicyAllowEntry>;
}

async function main(): Promise<void> {
  const socketPath = process.env['AGENT_SOCKET'] ?? '/run/homemcpd/homemcpd.sock';
  const hmacFile = process.env['AGENT_HMAC_SECRET_FILE'] ?? '/etc/homemcp/agent-hmac.secret';
  const configFile = process.env['AGENT_CONFIG_FILE'];

  const hmacSecret = (process.env['AGENT_HMAC_SECRET'] ?? (await readFile(hmacFile, 'utf8'))).trim();
  if (!hmacSecret) {
    throw new Error('AGENT_HMAC_SECRET is empty');
  }

  let fileCfg: AgentFileConfig = {};
  if (configFile) {
    fileCfg = (parseYaml(await readFile(configFile, 'utf8')) as AgentFileConfig | null) ?? {};
  }

  const registry = new VerbRegistry();
  const runner = new ExecaCommandRunner(AGENT_ALLOWED_BINARIES);
  const redactor = new Redactor();
  redactor.registerSecret(hmacSecret);

  registerSystemReadVerbs(registry, {
    runner,
    allowedUnits: fileCfg.allowedUnits ?? [],
    knownNoise: fileCfg.knownNoise ?? ['SystemCMOS', 'AE_NOT_EXIST', "Invalid key 'SYSFS'"],
  });
  registerStacksReadVerbs(registry, {
    stackRoots: fileCfg.stackRoots ?? [],
    mediaRoot: fileCfg.mediaRoot ?? '/mnt/storage/media',
    composeAllow: fileCfg.composeAllow ?? {},
  });
  registerBackupReadVerbs(registry, fileCfg.backupStatusDir ?? '/var/lib/homemcp/backup');
  registerBackupActionVerbs(registry, runner);
  registerOpsWriteVerbs(registry, {
    runner,
    protectedContainers: fileCfg.protectedContainers ?? ['cloudflared-*', 'nginx-pm-app-1', 'homemcp', 'vaultwarden'],
    protectedUnits: fileCfg.protectedUnits ?? ['ssh.service', 'tailscaled.service', 'homemcpd.service'],
    allowedUnits: fileCfg.allowedUnits ?? [],
    stackRoots: fileCfg.stackRoots ?? [],
  });

  const handle = await startAgentServer({ socketPath, hmacSecret, registry, redactor });
  process.stderr.write(`homemcpd listening on ${handle.address}\n`);

  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`homemcpd fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
