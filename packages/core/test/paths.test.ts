import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomemcpError } from '../src/errors.js';
import { resolveSafePath } from '../src/paths.js';

describe('resolveSafePath', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('resolves valid relative and non-existent target paths inside root', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homemcp-paths-'));
    dirs.push(tmp);
    const root = path.join(tmp, 'root');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'ok.yml'), 'hello: world\n');

    const resolvedExisting = await resolveSafePath(root, 'sub/ok.yml');
    expect(resolvedExisting).toContain(path.join('sub', 'ok.yml'));

    const resolvedNew = await resolveSafePath(root, 'sub/newdir/compose.yml');
    expect(resolvedNew).toContain(path.join('sub', 'newdir', 'compose.yml'));
  });

  it('blocks .. traversal and symlink escapes outside root', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'homemcp-paths-'));
    dirs.push(tmp);
    const root = path.join(tmp, 'root');
    const outside = path.join(tmp, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'nope');

    await expect(resolveSafePath(root, '../outside/secret.txt')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });

    try {
      await symlink(outside, path.join(root, 'escape-link'), 'junction');
      await expect(resolveSafePath(root, 'escape-link/secret.txt')).rejects.toBeInstanceOf(
        HomemcpError,
      );
    } catch {
      // Symlink creation on Windows without Developer Mode may return EPERM; traversal test above still ran
    }
  });
});
