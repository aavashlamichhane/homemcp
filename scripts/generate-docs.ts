import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { requiredScopeForTool } from '../packages/core/src/index.js';
import { createGatewayDeps } from '../packages/gateway/src/index.js';

function main(): void {
  const deps = createGatewayDeps({ mock: true });
  try {
    const tools = deps.registry.listTools();
    const resources = deps.registry.listResources();
    const prompts = deps.registry.listPrompts();

    const byToolset = new Map<string, typeof tools>();
    for (const t of tools) {
      const arr = byToolset.get(t.toolset) ?? [];
      arr.push(t);
      byToolset.set(t.toolset, arr);
    }

    const lines: string[] = [
      '# homemcp Reference — Tools, Resources, and Prompts',
      '',
      `> Auto-generated from \`HomemcpRegistry\` via \`pnpm docs:generate\`. Do not edit by hand.`,
      '',
      `**Totals:** ${tools.length} tools across ${byToolset.size} toolsets, ${resources.length} resources, ${prompts.length} prompts.`,
      '',
      '## Toolsets Summary',
      '',
      '| Toolset | Tools | Tiers |',
      '|---|---|---|',
    ];

    for (const [ts, list] of [...byToolset.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const tiers = [...new Set(list.map((t) => t.tier))].sort().join(', ');
      lines.push(`| \`${ts}\` | ${list.length} | ${tiers} |`);
    }

    lines.push('', '## Tools by Toolset', '');
    for (const [ts, list] of [...byToolset.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`### \`${ts}\``, '');
      lines.push('| Tool | Tier | Scope | Hints (R/D/I/O) | Description |');
      lines.push('|---|---|---|---|---|');
      for (const t of list) {
        const reqScope = requiredScopeForTool(t.tier, t.scope);
        const hints = [
          t.annotations.readOnlyHint ? 'R' : '-',
          t.annotations.destructiveHint ? 'D' : '-',
          t.annotations.idempotentHint ? 'I' : '-',
          t.annotations.openWorldHint ? 'O' : '-',
        ].join('/');
        const cleanDesc = t.description.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
        lines.push(`| \`${t.name}\` | ${t.tier} | \`${reqScope}\` | ${hints} | ${cleanDesc} |`);
      }
      lines.push('');
    }

    lines.push(
      '## Resources',
      '',
      '| URI / Template | Scope | Mime | Description |',
      '|---|---|---|---|',
    );
    for (const r of resources) {
      const uriStr = r.uri ?? r.template ?? '';
      lines.push(
        `| \`${uriStr}\` | \`${r.scope ?? 'homemcp:read'}\` | \`${r.mimeType}\` | ${r.description} |`,
      );
    }

    lines.push('', '## Prompts', '', '| Name | Title | Description |', '|---|---|---|');
    for (const p of prompts) {
      lines.push(`| \`${p.name}\` | ${p.title} | ${p.description} |`);
    }
    lines.push('');

    const outPath = path.resolve(process.cwd(), 'docs/tools.md');
    writeFileSync(outPath, lines.join('\n'), 'utf8');
    process.stdout.write(
      `Generated ${outPath} (${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts)\n`,
    );
  } finally {
    deps.db.close();
  }
}

main();
