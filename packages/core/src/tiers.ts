import type { Scope, Tier, ToolsetName } from './types.js';
import { TOOLSET_NAMES } from './types.js';

export const TIER_REQUIRED_SCOPE: Record<Tier, Scope> = {
  T0: 'homemcp:read',
  T1: 'homemcp:operate',
  T2: 'homemcp:admin',
  T3: 'homemcp:admin',
};

export function requiredScopeForTool(tier: Tier, explicitScope?: Scope): Scope {
  return explicitScope ?? TIER_REQUIRED_SCOPE[tier];
}

export function hasRequiredScope(grantedScopes: readonly string[], required: Scope): boolean {
  if (grantedScopes.includes(required)) {
    return true;
  }
  // homemcp:admin implies operate & read; homemcp:operate implies read
  if (required === 'homemcp:read') {
    return grantedScopes.includes('homemcp:operate') || grantedScopes.includes('homemcp:admin');
  }
  if (required === 'homemcp:operate') {
    return grantedScopes.includes('homemcp:admin');
  }
  return false;
}

export function isValidToolset(value: string): value is ToolsetName {
  return (TOOLSET_NAMES as readonly string[]).includes(value);
}

export function parseToolsetFilter(
  raw: string | undefined,
  configuredToolsets: readonly ToolsetName[],
  tokenToolsets?: readonly ToolsetName[],
): ToolsetName[] {
  const base = tokenToolsets
    ? configuredToolsets.filter((t) => tokenToolsets.includes(t))
    : [...configuredToolsets];

  if (!raw || raw.trim() === '') {
    return base;
  }

  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const validRequested = new Set<ToolsetName>();
  for (const item of requested) {
    if (isValidToolset(item)) {
      validRequested.add(item);
    }
  }
  return base.filter((t) => validRequested.has(t));
}
