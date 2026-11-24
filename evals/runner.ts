import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../packages/core/src/index.js';
import {
  buildMcpServer,
  createGatewayDeps,
  InMemoryTransport,
  type JSONRPCMessage,
} from '../packages/gateway/src/index.js';

interface EvalTask {
  id: string;
  story: string;
  category: 'functional' | 'security' | 'safety' | 'injection';
  prompt: string;
  toolset_filter?: string;
  tool: string;
  args: Record<string, unknown>;
  expect: {
    ok: boolean;
    error_code?: string;
    has_fields?: string[];
    require_substrings?: string[];
    forbid_substrings?: string[];
  };
}

async function runWithServer(toolsetFilter?: string) {
  const deps = createGatewayDeps({ mock: true });
  const server = buildMcpServer(deps, toolsetFilter ? { toolsetFilter } : undefined);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await ct.start();

  let nextId = 1;
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  ct.onmessage = (msg: JSONRPCMessage) => {
    const rec = msg as unknown as Record<string, unknown>;
    if (typeof rec['id'] === 'number' && pending.has(rec['id'])) {
      const resolve = pending.get(rec['id'])!;
      pending.delete(rec['id']);
      resolve(rec);
    }
  };

  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const p = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    await ct.send({ jsonrpc: '2.0', id, method, params });
    return p;
  };

  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'eval-runner', version: '1.0.0' },
  });
  await ct.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    deps,
    request,
    close: async () => {
      await ct.close();
      await st.close();
      deps.db.close();
    },
  };
}

async function main(): Promise<void> {
  const rawYaml = readFileSync(path.resolve(process.cwd(), 'evals/tasks.yaml'), 'utf8');
  const parsed = parseYaml(rawYaml) as { tasks: EvalTask[] };
  const tasks = parsed.tasks;

  // Measure toolset routing token/schema reduction (/mcp vs /mcp/music,naviload)
  const fullSrv = await runWithServer();
  const fullList = (await fullSrv.request('tools/list')) as { result: { tools: unknown[] } };
  const fullToolsBytes = Buffer.byteLength(JSON.stringify(fullList.result.tools), 'utf8');
  await fullSrv.close();

  const focusedSrv = await runWithServer('music,naviload');
  const focusedList = (await focusedSrv.request('tools/list')) as { result: { tools: unknown[] } };
  const focusedToolsBytes = Buffer.byteLength(JSON.stringify(focusedList.result.tools), 'utf8');
  await focusedSrv.close();

  const results: Array<{
    id: string;
    story: string;
    category: string;
    passed: boolean;
    reason?: string;
    duration_ms: number;
  }> = [];

  for (const task of tasks) {
    const t0 = Date.now();
    const srv = await runWithServer(task.toolset_filter);
    try {
      const resp = await srv.request('tools/call', {
        name: task.tool,
        arguments: task.args ?? {},
      });
      const rpcErr = resp['error'] as { message?: string } | undefined;
      if (rpcErr) {
        results.push({
          id: task.id,
          story: task.story,
          category: task.category,
          passed: false,
          reason: `JSON-RPC error: ${rpcErr.message ?? 'unknown'}`,
          duration_ms: Date.now() - t0,
        });
        continue;
      }
      const res = resp['result'] as {
        isError?: boolean;
        content?: unknown;
        structuredContent?: Record<string, unknown>;
      };
      const serialized = JSON.stringify(res);
      let ok = true;
      let reason: string | undefined;

      if (task.expect.ok && res.isError) {
        ok = false;
        reason = `Expected success, got tool error: ${serialized.slice(0, 200)}`;
      }
      if (!task.expect.ok && !res.isError) {
        ok = false;
        reason = 'Expected tool error, got success';
      }
      if (ok && task.expect.error_code) {
        const errCode = (res.structuredContent?.['error'] as { code?: string } | undefined)?.code;
        if (errCode !== task.expect.error_code) {
          ok = false;
          reason = `Expected error code ${task.expect.error_code}, got ${errCode ?? 'none'}`;
        }
      }
      if (ok && task.expect.has_fields) {
        for (const f of task.expect.has_fields) {
          if (res.structuredContent?.[f] === undefined) {
            ok = false;
            reason = `Missing expected structured field "${f}"`;
            break;
          }
        }
      }
      if (ok && task.expect.require_substrings) {
        for (const sub of task.expect.require_substrings) {
          if (!serialized.includes(sub)) {
            ok = false;
            reason = `Missing required substring "${sub}"`;
            break;
          }
        }
      }
      if (ok && task.expect.forbid_substrings) {
        for (const bad of task.expect.forbid_substrings) {
          if (serialized.includes(bad)) {
            ok = false;
            reason = `Found forbidden substring "${bad}"`;
            break;
          }
        }
      }

      results.push({
        id: task.id,
        story: task.story,
        category: task.category,
        passed: ok,
        ...(reason ? { reason } : {}),
        duration_ms: Date.now() - t0,
      });
    } finally {
      await srv.close();
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const injectionTasks = results.filter((r) => r.category === 'injection');
  const injectionPassed = injectionTasks.filter((r) => r.passed).length;
  const passRate = Math.round((passedCount / results.length) * 1000) / 10;
  const injectionSafetyRate = Math.round((injectionPassed / injectionTasks.length) * 1000) / 10;
  const toolsetReductionPct =
    Math.round(((fullToolsBytes - focusedToolsBytes) / fullToolsBytes) * 1000) / 10;

  const summary = {
    generated_at: new Date().toISOString(),
    total_tasks: results.length,
    passed_tasks: passedCount,
    pass_rate_percent: passRate,
    injection_tasks: injectionTasks.length,
    injection_safety_percent: injectionSafetyRate,
    toolset_routing_overhead: {
      full_tools_count: fullList.result.tools.length,
      full_schema_bytes: fullToolsBytes,
      music_naviload_tools_count: focusedList.result.tools.length,
      music_naviload_schema_bytes: focusedToolsBytes,
      reduction_percent: toolsetReductionPct,
    },
    results,
  };

  mkdirSync(path.resolve(process.cwd(), 'evals/results'), { recursive: true });
  writeFileSync(
    path.resolve(process.cwd(), 'evals/results/latest.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );

  process.stdout.write(
    `Evals: ${passedCount}/${results.length} passed (${passRate}%), Injection safety: ${injectionPassed}/${injectionTasks.length} (${injectionSafetyRate}%), Toolset schema reduction: ${toolsetReductionPct}%\n`,
  );

  if (passRate < 90 || injectionSafetyRate < 100) {
    const failed = results.filter((r) => !r.passed);
    process.stderr.write(`Failed tasks: ${JSON.stringify(failed, null, 2)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Eval runner fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
