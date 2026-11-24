import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HomemcpError } from './errors.js';

function isWithinRoot(realRoot: string, realTarget: string): boolean {
  const normRoot = path.resolve(realRoot);
  const normTarget = path.resolve(realTarget);
  if (normTarget === normRoot) return true;
  const withSep = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`;
  return normTarget.startsWith(withSep);
}

/**
 * Resolves `relPath` inside `allowedRoot`, preventing `..` traversal and symlink escapes.
 * If the target does not exist yet (e.g., for file creation), resolves the nearest existing
 * ancestor via `realpath` and verifies it stays within `allowedRoot`.
 */
export async function resolveSafePath(allowedRoot: string, relPath: string): Promise<string> {
  if (relPath.includes('\0')) {
    throw new HomemcpError('INVALID_ARGUMENT', 'Path contains null byte');
  }

  let realRoot: string;
  try {
    realRoot = await realpath(allowedRoot);
  } catch {
    throw new HomemcpError('NOT_FOUND', `Allowed root does not exist: ${allowedRoot}`);
  }

  const candidate = path.isAbsolute(relPath)
    ? path.resolve(relPath)
    : path.resolve(realRoot, relPath);

  if (!isWithinRoot(realRoot, candidate)) {
    throw new HomemcpError('POLICY_DENIED', `Path escapes allowed root: ${relPath}`);
  }

  try {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) {
      const targetReal = await realpath(candidate);
      if (!isWithinRoot(realRoot, targetReal)) {
        throw new HomemcpError(
          'POLICY_DENIED',
          `Symlink target escapes allowed root: ${relPath}`,
        );
      }
      return targetReal;
    }
    const realCandidate = await realpath(candidate);
    if (!isWithinRoot(realRoot, realCandidate)) {
      throw new HomemcpError('POLICY_DENIED', `Resolved path escapes allowed root: ${relPath}`);
    }
    return realCandidate;
  } catch (err) {
    if (err instanceof HomemcpError) throw err;
    // Target does not exist yet: walk up to nearest existing ancestor
    const missingParts: string[] = [];
    let current = candidate;
    while (!isWithinRoot(realRoot, current) === false) {
      try {
        const realAncestor = await realpath(current);
        if (!isWithinRoot(realRoot, realAncestor)) {
          throw new HomemcpError('POLICY_DENIED', `Ancestor escapes allowed root: ${relPath}`);
        }
        return path.join(realAncestor, ...missingParts.reverse());
      } catch (innerErr) {
        if (innerErr instanceof HomemcpError) throw innerErr;
        if (current === realRoot) {
          throw new HomemcpError('NOT_FOUND', `Allowed root unreachable: ${allowedRoot}`);
        }
        missingParts.push(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current) {
          throw new HomemcpError('POLICY_DENIED', `Path resolution failed: ${relPath}`);
        }
        current = parent;
      }
    }
    throw new HomemcpError('POLICY_DENIED', `Path escapes allowed root: ${relPath}`);
  }
}

export async function resolveAgainstAllowedRoots(
  allowedRoots: readonly string[],
  targetPath: string,
): Promise<{ root: string; resolved: string }> {
  for (const root of allowedRoots) {
    try {
      const realRoot = await realpath(root);
      const absTarget = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(realRoot, targetPath);
      if (isWithinRoot(realRoot, absTarget)) {
        const resolved = await resolveSafePath(realRoot, absTarget);
        return { root: realRoot, resolved };
      }
    } catch (err) {
      if (err instanceof HomemcpError && err.code === 'POLICY_DENIED') {
        throw err;
      }
    }
  }
  throw new HomemcpError(
    'POLICY_DENIED',
    `Path is outside all allowed roots: ${targetPath}`,
  );
}
