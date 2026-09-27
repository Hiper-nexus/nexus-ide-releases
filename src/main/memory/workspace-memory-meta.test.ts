import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
} from './workspace-memory';

const dirs: string[] = [];
let scope: ProjectExecutionScope;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-meta-root-'));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-meta-db-'));
  dirs.push(root, baseDir);
  scope = {
    version: 1,
    installationId: 'installation-meta',
    projectId: 'project-meta',
    checkoutId: 'checkout-meta',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  configureWorkspaceMemory({ baseDir });
});

afterEach(() => {
  disposeWorkspaceMemoryStores();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('activeWorkspaceMetas (índice de provenance para a UI)', () => {
  it('expõe source e datas das linhas ativas do workspace', () => {
    const store = getWorkspaceMemoryStore(scope);
    const retained = store.retain({
      content: '# Fato\n\nSempre use pnpm neste projeto.',
      kind: 'preference',
      scope: 'workspace',
      source: 'trusted:operator-preference',
    });

    const metas = store.activeWorkspaceMetas();
    const meta = metas.get(retained.id);
    expect(meta).toBeDefined();
    expect(meta?.source).toBe('trusted:operator-preference');
    expect(meta?.createdAt).toBeGreaterThan(0);
    expect(meta?.updatedAt).toBeGreaterThanOrEqual(meta!.createdAt);

    // nota esquecida sai do índice
    store.forget(retained.id);
    expect(store.activeWorkspaceMetas().has(retained.id)).toBe(false);
  });
});
