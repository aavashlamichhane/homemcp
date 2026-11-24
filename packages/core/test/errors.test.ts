import { describe, expect, it } from 'vitest';
import { HomemcpError } from '../src/errors.js';
import { buildToolResult, truncateText } from '../src/output.js';
import { hasRequiredScope, parseToolsetFilter } from '../src/tiers.js';
import { formatUntrustedText, wrapUntrusted } from '../src/untrusted.js';

describe('errors, tiers, untrusted, output', () => {
  it('formats HomemcpError to stable MCP tool error shape', () => {
    const err = new HomemcpError('NOT_FOUND', 'Container missing', {
      hint: 'Check docker_list_services',
    });
    const res = err.toMcpToolResult();
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('NOT_FOUND');
    expect(res.content[0]?.text).toContain('Hint: Check docker_list_services');
  });

  it('enforces scope hierarchy and toolset intersection', () => {
    expect(hasRequiredScope(['homemcp:admin'], 'homemcp:read')).toBe(true);
    expect(hasRequiredScope(['homemcp:read'], 'homemcp:operate')).toBe(false);
    expect(
      parseToolsetFilter(
        'music,naviload,stacks',
        ['core', 'music', 'naviload', 'stacks'],
        ['music', 'naviload'],
      ),
    ).toEqual(['music', 'naviload']);
  });

  it('wraps untrusted text with fencing and truncates oversized outputs', () => {
    expect(wrapUntrusted('docker logs', 'hello')).toEqual({
      untrusted_source: 'docker logs',
      untrusted_data: 'hello',
    });
    expect(formatUntrustedText('journald', 'payload')).toContain('untrusted data from journald');

    const big = 'a'.repeat(70_000);
    const trunc = truncateText(big, 1024);
    expect(trunc.truncated).toBe(true);
    expect(Buffer.byteLength(trunc.text, 'utf8')).toBeLessThanOrEqual(1024);

    const toolRes = buildToolResult('ok', { count: 1 });
    expect(toolRes.structuredContent).toEqual({ count: 1 });
  });
});
