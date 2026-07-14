import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  assertPathInsideRoot,
  requireScopedRoot,
  resolveScopedPath,
  resolveScopedPathCandidate,
  resolveSubdirUnderRoot,
} from './scoped-workspace-fs';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeProject(): { project: string; sibling: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-scoped-fs-'));
  dirs.push(base);
  const project = path.join(base, 'proj');
  const sibling = path.join(base, 'proj2');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(project, 'safe.txt'), 'ok');
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'secret');
  return { project: fs.realpathSync(project), sibling: fs.realpathSync(sibling) };
}

function scopeFor(rootRealPath: string): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'inst',
    projectId: 'p',
    checkoutId: 'c',
    rootRealPath,
    identitySource: 'manifest',
  };
}

describe('scoped-workspace-fs (single containment contract)', () => {
  it('table: sibling-prefix, absolute escape, and .. segments', () => {
    const { project, sibling } = makeProject();

    // startsWith trap: /tmp/proj vs /tmp/proj2
    expect(() =>
      assertPathInsideRoot(project, path.join(sibling, 'secret.txt')),
    ).toThrow(/escapes/);
    expect(() =>
      assertPathInsideRoot(project, path.resolve(project, '../proj2/secret.txt')),
    ).toThrow(/escapes/);

    expect(() => resolveSubdirUnderRoot(project, '../proj2')).toThrow();
    expect(() => resolveSubdirUnderRoot(project, '/etc')).toThrow(/relative/);
    expect(() => resolveSubdirUnderRoot(project, '..')).toThrow();
    expect(() => resolveSubdirUnderRoot(project, 'a/../../proj2')).toThrow();

    expect(resolveSubdirUnderRoot(project, '.nexus-memory')).toBe(
      path.join(project, '.nexus-memory'),
    );
    expect(assertPathInsideRoot(project, path.join(project, 'safe.txt'))).toBe(
      path.join(project, 'safe.txt'),
    );
  });

  it('requireScopedRoot + resolveScopedPath bind WebContents to workspace', async () => {
    const { project, sibling } = makeProject();
    const scope = scopeFor(project);

    vi.doMock('../persistence/renderer-workspace-scope', () => ({
      requireRendererWorkspaceScope: () => scope,
    }));
    // Re-import after mock — use dynamic path through already-loaded module
    // by stubbing requireRendererWorkspaceScope via the same module graph.
    const scopeMod = await import('../persistence/renderer-workspace-scope');
    vi.spyOn(scopeMod, 'requireRendererWorkspaceScope').mockReturnValue(scope);

    const sender = { id: 99 } as Electron.WebContents;
    const bound = requireScopedRoot(sender);
    expect(bound.root).toBe(project);

    expect(resolveScopedPathCandidate(sender, 'safe.txt')).toBe(
      path.join(project, 'safe.txt'),
    );
    expect(() =>
      resolveScopedPathCandidate(sender, path.join(sibling, 'secret.txt')),
    ).toThrow(/escapes/);
    expect(() =>
      resolveScopedPathCandidate(sender, '../proj2/secret.txt'),
    ).toThrow(/escapes/);
    expect(() => resolveScopedPath(sender, path.join(sibling, 'secret.txt'))).toThrow(
      /escapes/,
    );
  });
});
