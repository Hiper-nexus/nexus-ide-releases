import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { collectFilesModified, collectMtimeChangedFiles } from './worker-files-modified';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it('collects non-Git evidence asynchronously without following a symlink', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-async-evidence-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'delivered.ts'), 'done');
  await fs.symlink(path.join(root, 'delivered.ts'), path.join(root, 'alias.ts'));
  const pending = collectFilesModified(root, Date.now() - 1_000);
  expect(pending).toBeInstanceOf(Promise);
  expect(await pending).toEqual(['delivered.ts']);
});

it('bounds the mtime result and exposes an asynchronous traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-async-mtime-'));
  roots.push(root);
  await Promise.all(['a.ts', 'b.ts', 'c.ts'].map((name) => fs.writeFile(path.join(root, name), 'done')));
  const pending = collectMtimeChangedFiles(root, 0, 2);
  expect(pending).toBeInstanceOf(Promise);
  expect(await pending).toHaveLength(2);
});
