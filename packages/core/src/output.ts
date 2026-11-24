export const MAX_TEXT_OUTPUT_BYTES = 65_536;

export function truncateText(
  text: string,
  maxBytes: number = MAX_TEXT_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  const suffix = '\n... [truncated]';
  const target = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let sliced = buf.subarray(0, target).toString('utf8');
  // Drop any trailing replacement character caused by slicing mid-codepoint
  if (sliced.endsWith('\uFFFD')) {
    sliced = sliced.slice(0, -1);
  }
  return { text: `${sliced}${suffix}`, truncated: true };
}

export function buildToolResult<T extends Record<string, unknown>>(
  summary: string,
  structured: T,
): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: T;
} {
  const { text, truncated } = truncateText(summary);
  const outStructured = truncated ? { ...structured, truncated: true } : structured;
  return {
    content: [{ type: 'text', text }],
    structuredContent: outStructured,
  };
}
