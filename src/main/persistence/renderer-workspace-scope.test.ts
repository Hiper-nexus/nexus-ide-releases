import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindRendererWorkspaceScope,
  clearRendererWorkspaceScope,
  getRendererWorkspaceScope,
  onRendererWorkspaceScopeChange,
  requireLiveRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from './renderer-workspace-scope';

const roots: string[] = [];
const installationId = '018f6f5e-c2e8-7a59-8d75-3f7e5ab87c92';

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-renderer-scope-'));
  roots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  clearRendererWorkspaceScope({ id: 1 });
  clearRendererWorkspaceScope({ id: 2 });
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('renderer workspace scope', () => {
  it('binds each renderer to its own immutable project authority', () => {
    const rootA = workspace();
    const rootB = workspace();

    const scopeA = bindRendererWorkspaceScope({ id: 1 }, rootA, {
      installationId,
      checkoutRegistryFile: path.join(rootA, 'checkouts.json'),
    });
    const scopeB = bindRendererWorkspaceScope({ id: 2 }, rootB, {
      installationId,
      checkoutRegistryFile: path.join(rootB, 'checkouts.json'),
    });

    expect(requireRendererWorkspaceScope({ id: 1 })).toEqual(scopeA);
    expect(requireRendererWorkspaceScope({ id: 2 })).toEqual(scopeB);
    expect(scopeA.rootRealPath).toBe(rootA);
    expect(scopeB.rootRealPath).toBe(rootB);
    expect(Object.isFrozen(scopeA)).toBe(true);
  });

  it('rebinds only the renderer that explicitly switched projects', () => {
    const rootA = workspace();
    const rootB = workspace();
    const optionsA = {
      installationId,
      checkoutRegistryFile: path.join(rootA, 'checkouts.json'),
    };
    const optionsB = {
      installationId,
      checkoutRegistryFile: path.join(rootB, 'checkouts.json'),
    };
    bindRendererWorkspaceScope({ id: 1 }, rootA, optionsA);
    bindRendererWorkspaceScope({ id: 2 }, rootA, optionsA);

    bindRendererWorkspaceScope({ id: 1 }, rootB, optionsB);

    expect(requireRendererWorkspaceScope({ id: 1 }).rootRealPath).toBe(rootB);
    expect(requireRendererWorkspaceScope({ id: 2 }).rootRealPath).toBe(rootA);
  });

  it('fails closed when a renderer has no bound workspace', () => {
    expect(getRendererWorkspaceScope({ id: 1 })).toBeNull();
    expect(() => requireRendererWorkspaceScope({ id: 1 })).toThrow(
      /renderer has no authorized workspace/i,
    );
  });

  it('requires a live renderer for effect authority', () => {
    const root = workspace();
    bindRendererWorkspaceScope({ id: 1 }, root, {
      installationId,
      checkoutRegistryFile: path.join(root, 'checkouts.json'),
    });
    const destroyed = {
      id: 1,
      isDestroyed: () => true,
      isCrashed: () => false,
    };
    const crashed = {
      id: 1,
      isDestroyed: () => false,
      isCrashed: () => true,
    };

    expect(() => requireLiveRendererWorkspaceScope(destroyed)).toThrow(
      /renderer is unavailable/i,
    );
    expect(() => requireLiveRendererWorkspaceScope(crashed)).toThrow(
      /renderer is unavailable/i,
    );
  });

  it('rejects stale effect authority after the renderer switches projects', () => {
    const rootA = workspace();
    const rootB = workspace();
    const owner = {
      id: 1,
      isDestroyed: () => false,
      isCrashed: () => false,
    };
    const scopeA = bindRendererWorkspaceScope(owner, rootA, {
      installationId,
      checkoutRegistryFile: path.join(rootA, 'checkouts.json'),
    });
    bindRendererWorkspaceScope(owner, rootB, {
      installationId,
      checkoutRegistryFile: path.join(rootB, 'checkouts.json'),
    });

    expect(() => requireLiveRendererWorkspaceScope(owner, scopeA)).toThrow(
      /renderer workspace authority changed/i,
    );
  });

  it('notifies main-owned resources when a renderer changes or clears scope', () => {
    const rootA = workspace();
    const rootB = workspace();
    const changes: Array<{ previous: string | null; next: string | null }> = [];
    const unsubscribe = onRendererWorkspaceScopeChange(
      (_owner, previous, next) => {
        changes.push({
          previous: previous?.rootRealPath ?? null,
          next: next?.rootRealPath ?? null,
        });
      },
    );
    bindRendererWorkspaceScope({ id: 1 }, rootA, {
      installationId,
      checkoutRegistryFile: path.join(rootA, 'checkouts.json'),
    });
    bindRendererWorkspaceScope({ id: 1 }, rootB, {
      installationId,
      checkoutRegistryFile: path.join(rootB, 'checkouts.json'),
    });
    clearRendererWorkspaceScope({ id: 1 });
    unsubscribe();

    expect(changes).toEqual([
      { previous: null, next: rootA },
      { previous: rootA, next: rootB },
      { previous: rootB, next: null },
    ]);
  });
});
