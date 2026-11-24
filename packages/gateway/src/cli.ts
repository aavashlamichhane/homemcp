#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, Redactor } from '@homemcp/core';
import { buildMcpServer, createGatewayDeps } from './server/factory.js';

export interface CliArgs {
  command: 'serve' | 'doctor';
  transport: 'stdio' | 'http';
  configPath?: string | undefined;
  mock: boolean;
  toolsets?: string | undefined;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const command = argv[0] === 'doctor' ? 'doctor' : 'serve';
  let transport: 'stdio' | 'http' = 'stdio';
  let configPath: string | undefined;
  let mock = false;
  let toolsets: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--transport' && argv[i + 1]) {
      transport = argv[++i] === 'http' ? 'http' : 'stdio';
    } else if (arg === '--config' && argv[i + 1]) {
      configPath = argv[++i];
    } else if (arg === '--mock') {
      mock = true;
    } else if (arg === '--toolsets' && argv[i + 1]) {
      toolsets = argv[++i];
    }
  }
  return { command, transport, configPath, mock, toolsets };
}

async function runDoctor(args: CliArgs): Promise<number> {
  const redactor = new Redactor();
  const config = args.configPath ? await loadConfig(args.configPath, process.env, redactor) : undefined;
  const deps = createGatewayDeps({ config, mock: args.mock || !config, redactor });

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    const h = await deps.agent.healthz();
    checks.push({ name: 'agent', ok: h.ok, detail: `${h.verbs.length} verbs` });
  } catch (err) {
    checks.push({ name: 'agent', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  if (deps.docker) {
    try {
      const c = await deps.docker.listContainers(false);
      checks.push({ name: 'docker-socket-proxy', ok: true, detail: `${c.length} running containers` });
    } catch (err) {
      checks.push({
        name: 'docker-socket-proxy',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deps.npm) {
    try {
      const h = await deps.npm.listProxyHosts();
      checks.push({ name: 'npm', ok: true, detail: `${h.length} proxy hosts` });
    } catch (err) {
      checks.push({ name: 'npm', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  if (deps.cloudflare) {
    try {
      const t = await deps.cloudflare.getTunnelStatus();
      checks.push({ name: 'cloudflare', ok: true, detail: `${t.status} (${t.connections.length} conns)` });
    } catch (err) {
      checks.push({
        name: 'cloudflare',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const c of checks) {
    process.stdout.write(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}\n`);
  }
  deps.db.close();
  return checks.every((c) => c.ok) ? 0 : 1;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === 'doctor') {
    const code = await runDoctor(args);
    process.exit(code);
  }

  const redactor = new Redactor();
  const config = args.configPath ? await loadConfig(args.configPath, process.env, redactor) : undefined;
  const deps = createGatewayDeps({ config, mock: args.mock || !config, redactor });
  const server = buildMcpServer(deps, { toolsetFilter: args.toolsets });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`homemcp stdio server ready (${deps.isMock ? 'mock' : 'live'})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`homemcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
