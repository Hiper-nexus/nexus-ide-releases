import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';
import { workspaceMemoryContextBlock } from './workspace-memory-context';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';

let root: string;
afterEach(() => { vi.restoreAllMocks(); disposeWorkspaceMemoryStores(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

it('explicit import preserves native bytes, redacts secrets, dedupes across restart and never trusts a source string', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-native-'));
  const scope = testProjectScope({ rootRealPath: root });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank') });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
  const file = path.join(root, 'quota-native.md');
  const secret = 'ghp_' + 'A'.repeat(36);
  const content = `# Quota\n\nQuota preserves native session. token=${secret}`;
  fs.writeFileSync(file, content);
  const { importNativeMemoryFile } = await import('./native-memory-import');
  const first = await importNativeMemoryFile(scope, file, () => {});
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
  let store = getWorkspaceMemoryStore(scope);
  expect(store.flagsOf([first.id]).get(first.id)).toContain('quarantine');
  expect(store.recall({ query: 'Quota' })[0].content).not.toContain(secret);
  expect(workspaceMemoryContextBlock(scope, 'Quota native session')).toBeNull();
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank') });
  const second = await importNativeMemoryFile(scope, file, () => {});
  expect(second.id).toBe(first.id); expect(second.deduped).toBe(true);
  store = getWorkspaceMemoryStore(scope);
  store.promoteMemory(first.id);
  expect(workspaceMemoryContextBlock(scope, 'Quota native session')).toContain('Quota preserves native session');
  expect(getWorkspaceMemoryStore(testProjectScope({ projectId: 'foreign' })).stats().workspace.active).toBe(0);
});

it('completes real short reads without dropping text across chunks', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-native-short-'));
  const scope = testProjectScope({ rootRealPath: root });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank') });
  const content = 'Short reads preserve português and every final byte.';
  const file = path.join(root, 'short.md'); fs.writeFileSync(file, content);
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    Object.defineProperty(handle, 'read', { value: (buffer: Buffer, offset: number, length: number, position: number) =>
      read(buffer, offset, Math.min(3, length), position) });
    return handle;
  });
  const { importNativeMemoryFile } = await import('./native-memory-import');
  await importNativeMemoryFile(scope, file, () => {});
  expect(getWorkspaceMemoryStore(scope).recall({ query: 'Short reads' })[0].content).toBe(content);
});

it.skipIf(process.platform === 'win32')('FIFO selection is refused without waiting for a writer', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-native-fifo-'));
  const scope = testProjectScope({ rootRealPath: root });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank') });
  const file = path.join(root, 'pipe.md'); execFileSync('mkfifo', [file]);
  const { importNativeMemoryFile } = await import('./native-memory-import');
  // If regression blocks on open, release its physical read so the test cannot hang.
  const release = setTimeout(() => {
    try { const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.closeSync(fd); } catch { /* no reader */ }
  }, 500);
  const started = Date.now();
  try {
    await expect(importNativeMemoryFile(scope, file, () => {})).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(400);
  } finally { clearTimeout(release); }
});

it('bounded import rejects oversized/symlink files and rechecks operator scope after IO before retention', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-native-bound-'));
  const scope = testProjectScope({ rootRealPath: root });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank') });
  const file = path.join(root, 'note.md'); fs.writeFileSync(file, 'Native bytes');
  const { importNativeMemoryFile } = await import('./native-memory-import');
  let checks = 0;
  await expect(importNativeMemoryFile(scope, file, () => { if (++checks > 1) throw new Error('operator scope changed'); })).rejects.toThrow('scope');
  const big = path.join(root, 'big.md'); fs.writeFileSync(big, 'x'.repeat(9_000));
  await expect(importNativeMemoryFile(scope, big, () => {})).rejects.toThrow('size');
  fs.symlinkSync(file, path.join(root, 'alias.md'));
  await expect(importNativeMemoryFile(scope, path.join(root, 'alias.md'), () => {})).rejects.toThrow();
  expect(getWorkspaceMemoryStore(scope).stats().workspace.active).toBe(0);
});
