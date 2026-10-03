import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { runPeriodicTask } from '../observability/periodic-task';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry } from '../orch/project-domain-store-registry';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';

let root: string;
afterEach(() => { disposeProjectDomainStoreRegistry(); disposeWorkspaceMemoryStores(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

it('expiry is strictly older than 30 days, never-injected digest only, and bounded', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-maintain-'));
  let now = 0;
  const scope = testProjectScope({ rootRealPath: root });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank'), now: () => now });
  const store = getWorkspaceMemoryStore(scope);
  for (let i = 0; i < 40; i++) store.retain({ content: `digest ${i}`, source: 'trusted:session-digest' });
  const protectedId = store.retain({ content: 'recalled digest', source: 'trusted:session-digest' }).id;
  store.markRecalled([protectedId]);
  store.retain({ content: 'durable decision', kind: 'decision', source: 'trusted:architecture-rule' });
  now = 30 * 24 * 60 * 60_000;
  expect(store.expireUnrecalledSessionDigests(now, 8)).toHaveLength(0);
  now++;
  expect(store.expireUnrecalledSessionDigests(now - 1, 8)).toHaveLength(8);
  expect(store.recall({ query: 'recalled durable' })).toHaveLength(2);
});

it('Main domain registration runs expiry after open without a prompt or new retention', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-production-service-'));
  let now = 0;
  const scope = testProjectScope({ rootRealPath: root });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank'), now: () => now });
  const store = getWorkspaceMemoryStore(scope);
  store.retain({ content: 'old transient digest', source: 'trusted:session-digest' });
  now = 31 * 24 * 60 * 60_000;
  const manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'test' });
  try {
    const registry = configureProjectDomainStoreRegistry(manager);
    registry.forScope(scope);
    await vi.waitFor(() => expect(store.recall({ query: 'transient' })).toHaveLength(0));
  } finally { disposeProjectDomainStoreRegistry(); manager.closeAll(); }
});

it('production maintenance rotates fact pages, marks only missing files and clears restored facts', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-files-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/alive.ts'), 'export {}');
  const scope = testProjectScope({ rootRealPath: fs.realpathSync(root) });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank'), coordinationScopeFor: () => scope });
  const store = getWorkspaceMemoryStore(scope);
  const missing = store.retain({ content: 'missing file src/gone.ts', kind: 'fact', source: 'trusted:resolved-problem' }).id;
  const live = store.retain({ content: 'alive file src/alive.ts', kind: 'fact', source: 'trusted:resolved-problem' }).id;
  const rule = store.retain({ content: 'rule src/gone.ts', kind: 'decision', source: 'trusted:architecture-rule' }).id;
  const { maintainWorkspaceMemory } = await import('./workspace-memory-maintenance');
  await runPeriodicTask('memory-maintenance:test', (ctx) => maintainWorkspaceMemory(scope, ctx));
  expect(store.flagsOf([missing]).get(missing)).toContain('reverify');
  expect(store.flagsOf([live, rule]).size).toBe(0);
  fs.writeFileSync(path.join(root, 'src/gone.ts'), 'export {}');
  await runPeriodicTask('memory-maintenance:test', (ctx) => maintainWorkspaceMemory(scope, ctx));
  await runPeriodicTask('memory-maintenance:test', (ctx) => maintainWorkspaceMemory(scope, ctx));
  expect(store.flagsOf([missing]).has(missing)).toBe(false);
});

it('file verification resumes after restart beyond the first bounded page', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-file-pages-'));
  const scope = testProjectScope({ rootRealPath: fs.realpathSync(root) });
  const options = { baseDir: path.join(root, 'bank'), coordinationScopeFor: () => scope };
  configureWorkspaceMemory(options);
  const store = getWorkspaceMemoryStore(scope);
  const ids = Array.from({ length: 18 }, (_, i) => store.retain({
    content: `Missing file src/missing-${i}.ts`, kind: 'fact', source: 'trusted:resolved-problem',
  }).id);
  const { maintainWorkspaceMemory } = await import('./workspace-memory-maintenance');
  await runPeriodicTask('memory-maintenance:pages-test', (ctx) => maintainWorkspaceMemory(scope, ctx));
  expect(store.flagsOf(ids).size).toBe(16);
  configureWorkspaceMemory(options);
  await runPeriodicTask('memory-maintenance:pages-test', (ctx) => maintainWorkspaceMemory(scope, ctx));
  expect(getWorkspaceMemoryStore(scope).flagsOf(ids).size).toBe(18);
});
