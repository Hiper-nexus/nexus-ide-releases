import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { discoverScopedGoWorkspace } from './go-workspace';

let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-go-work-'))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function moduleAt(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'go.mod'), 'module example.invalid/fixture\ngo 1.23\n');
  return dir;
}

it('discovers both workspace modules when the workspace root has no go.mod', async () => {
  const a = await moduleAt('a'); const b = await moduleAt('b');
  const file = path.join(root, 'go.work');
  await fs.writeFile(file, 'go 1.23\nuse (\n ./a\n ./b\n)\n');
  expect(await discoverScopedGoWorkspace(root, root)).toEqual({ file, moduleRoots: [a, b] });
});

it('reads the nearest workspace and never searches above the authorized root', async () => {
  const a = await moduleAt('outer/a'); const b = await moduleAt('outer/b');
  await fs.mkdir(path.join(a, 'src'));
  const file = path.join(root, 'outer/go.work');
  await fs.writeFile(file, 'use ./a\nuse ./b\n');
  await fs.writeFile(path.join(root, 'go.work'), 'use ../outside\n');
  expect(await discoverScopedGoWorkspace(path.join(a, 'src'), root)).toEqual({ file, moduleRoots: [a, b] });
  expect(await discoverScopedGoWorkspace(a, a)).toBeNull();
});

it('accepts quoted and raw paths, comments, CRLF and local replacements without inventing members', async () => {
  const a = await moduleAt('module a'); const b = await moduleAt('module b'); await moduleAt('replaced');
  const file = path.join(root, 'go.work');
  await fs.writeFile(file, '// use ../ignored\r\ngo 1.23\r\ntoolchain go1.23.4\r\nuse "./module a" // comment\r\nuse (\r\n `./module b`\r\n)\r\nreplace (\r\n example.invalid/old v1.0.0 => ./replaced\r\n example.invalid/net => example.invalid/new v1.2.3\r\n)\r\ngodebug default=go1.23\r\n');
  expect(await discoverScopedGoWorkspace(root, root)).toEqual({ file, moduleRoots: [a, b] });
});

it('decodes Go quoted path escapes and canonicalizes duplicate members', async () => {
  const a = await moduleAt('module a'); const file = path.join(root, 'go.work');
  await fs.writeFile(file, 'use "./module\\x20a"\nuse `./module a`\n');
  expect(await discoverScopedGoWorkspace(root, root)).toEqual({ file, moduleRoots: [a] });
});

it('accepts absolute use and replacement paths that remain inside the authorized root', async () => {
  const a = await moduleAt('absolute a'); const replacement = await moduleAt('replacement');
  const file = path.join(root, 'go.work');
  await fs.writeFile(file, `use ${JSON.stringify(a)}\nreplace example.invalid/old => ${JSON.stringify(replacement)}\n`);
  expect(await discoverScopedGoWorkspace(root, root)).toEqual({ file, moduleRoots: [a] });
});

it.each([
  'use ../outside\n',
  'use ./a\nreplace example.invalid/old => ../outside\n',
  'use ./a\nreplace (\n example.invalid/old v1.2.0 => ../outside\n)\n',
  'use ./a\nreplace example.invalid/old => C:\\outside\n',
])('rejects an external use/replacement without returning partial inventory: %s', async text => {
  await moduleAt('a'); await fs.writeFile(path.join(root, 'go.work'), text);
  await expect(discoverScopedGoWorkspace(root, root)).rejects.toThrow(/go\.work/i);
});

it.each([
  'use (\n./a\n',
  'use ./a ./b\n',
  'use "./a\n',
  'use ./a\nunknown ./b\n',
  'use ./a\nreplace old =>\n',
  'use ./a\n/* unsupported block comment */\n',
])('rejects ambiguous/unsupported syntax instead of selecting a partial set: %s', async text => {
  await moduleAt('a'); await fs.writeFile(path.join(root, 'go.work'), text);
  await expect(discoverScopedGoWorkspace(root, root)).rejects.toThrow(/go\.work/i);
});

it('rejects oversized workspace metadata before parsing it', async () => {
  await fs.writeFile(path.join(root, 'go.work'), '// ' + 'x'.repeat(128 * 1024));
  await expect(discoverScopedGoWorkspace(root, root)).rejects.toThrow(/go\.work/i);
});

it('rejects an excessive module inventory even when entries repeat', async () => {
  await moduleAt('a'); await fs.writeFile(path.join(root, 'go.work'), 'use ./a\n'.repeat(1025));
  await expect(discoverScopedGoWorkspace(root, root)).rejects.toThrow(/go\.work/i);
});

it('rejects module and metadata symlinks escaping the authorized root', async () => {
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-go-outside-')));
  try {
    await fs.writeFile(path.join(outside, 'go.mod'), 'module outside\n');
    await fs.writeFile(path.join(outside, 'go.work'), 'use .\n');
    await fs.symlink(outside, path.join(root, 'escape'), 'junction');
    await fs.writeFile(path.join(root, 'go.work'), 'use ./escape\n');
    await expect(discoverScopedGoWorkspace(root, root)).rejects.toThrow(/go\.work/i);
    await fs.rm(path.join(root, 'go.work')); await fs.symlink(path.join(outside, 'go.work'), path.join(root, 'go.work'));
    await expect(discoverScopedGoWorkspace(root, root)).rejects.toThrow(/go\.work/i);
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});

it('refuses a cwd outside the root even when no workspace exists', async () => {
  await expect(discoverScopedGoWorkspace(path.dirname(root), root)).rejects.toThrow(/go\.work/i);
});
