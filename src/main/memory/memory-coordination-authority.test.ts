import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bindResolvedRendererWorkspaceScope, clearRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';

const roots: string[] = [];
const owner = { id: 98231 };
afterEach(() => {
  clearRendererWorkspaceScope(owner);
  disposeWorkspaceMemoryStores();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('first worktree/rootless lookup cannot choose the opt-in vault root', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-authority-'));
  roots.push(tmp);
  const root = path.join(tmp, 'coordination');
  const worktree = path.join(tmp, 'worker');
  fs.mkdirSync(root); fs.mkdirSync(worktree);
  const scope = testProjectScope({ projectId: 'authority-root', rootRealPath: root });
  configureWorkspaceMemory({ baseDir: path.join(tmp, 'memory'), vaultExportEnabled: () => true });
  const early = getWorkspaceMemoryStore({ ...scope, rootRealPath: worktree });
  expect(early.workspaceRoot).toBeUndefined();
  bindResolvedRendererWorkspaceScope(owner, scope);
  const store = getWorkspaceMemoryStore({ projectId: scope.projectId });
  expect(store).toBe(early);
  expect(store.workspaceRoot).toBe(root);
  store.retain({ content: 'Coordination fact', source: 'operator:note' });
  await store.flushProjections();
  expect(fs.existsSync(path.join(root, '.nexus-memory'))).toBe(true);
  expect(fs.existsSync(path.join(worktree, '.nexus-memory'))).toBe(false);
});

it('binding a coordinator after rootless search keeps read-only retention off the checkout', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-authority-ro-')); roots.push(tmp);
  const scope = testProjectScope({ projectId: 'authority-rootless', rootRealPath: tmp });
  configureWorkspaceMemory({ baseDir: path.join(tmp, 'memory'), vaultExportEnabled: () => true });
  const store = getWorkspaceMemoryStore({ projectId: scope.projectId });
  bindResolvedRendererWorkspaceScope(owner, scope);
  getWorkspaceMemoryStore(scope).retainAgentAuthored({ content: 'Read-only finding' },
    { source: `agent-authored:pane:${'a'.repeat(64)}` }, { vault: false, quarantine: 'read-only' });
  await store.flushProjections();
  expect(store.workspaceRoot).toBe(tmp);
  expect(fs.existsSync(path.join(tmp, '.nexus-memory'))).toBe(false);
});
