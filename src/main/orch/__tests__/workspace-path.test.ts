import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WorkspaceRootMissingError,
  isMissingPathError,
  resolvePathForScope,
  resolveCwdForScope,
  resolveWorkspaceCwd,
  resolveWorkspacePath,
} from '../workspace-path';
import type { ProjectExecutionScope } from '../../../shared/types';

const workspace = vi.hoisted(() => ({ current: '' }));

vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-workspace-path');
const wsDir = path.join(testDir, 'workspace');
const outsideDir = path.join(testDir, 'outside');

function scopeFor(rootRealPath: string): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'installation-test',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath,
    identitySource: 'manifest',
  };
}

describe('workspace-path', () => {
  beforeAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside-secret', 'utf-8');
    fs.symlinkSync(outsideDir, path.join(wsDir, 'outside-link'), 'dir');
    workspace.current = wsDir;
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects a symlinked file that resolves outside the workspace', () => {
    expect(() => resolveWorkspacePath('outside-link/secret.txt')).toThrow(
      /escapes workspace/,
    );
  });

  it('rejects creating a file through a symlinked parent outside the workspace', () => {
    expect(() => resolveWorkspacePath('outside-link/new.txt')).toThrow(
      /escapes workspace/,
    );
  });

  it('rejects a symlinked cwd that resolves outside the workspace', () => {
    expect(() => resolveWorkspaceCwd('outside-link')).toThrow(/escapes workspace/);
  });

  it('raiz do projeto apagada (worktree removido) tem nome próprio e diz a saída', () => {
    const goneDir = path.join(testDir, 'worktree-gone');
    fs.mkdirSync(goneDir, { recursive: true });
    const scope = scopeFor(fs.realpathSync(goneDir));
    fs.rmSync(goneDir, { recursive: true, force: true });

    let caught: unknown;
    try {
      resolveCwdForScope(scope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceRootMissingError);
    const error = caught as WorkspaceRootMissingError;
    expect(error.code).toBe('workspace-root-missing');
    expect(error.rootPath).toBe(scope.rootRealPath);
    expect(error.message).toContain('não existe mais no disco');
    expect(error.message).toContain(scope.rootRealPath);
    expect(error.message).toContain('Abrir pasta');
    // O workspace ativo (sem scope explícito) cai na mesma classe.
    const previous = workspace.current;
    workspace.current = scope.rootRealPath;
    try {
      expect(() => resolveWorkspacePath('a.txt')).toThrow(WorkspaceRootMissingError);
    } finally {
      workspace.current = previous;
    }
  });

  it('só ENOENT/ENOTDIR contam como pasta sumida; um arquivo no lugar da raiz segue erro comum', () => {
    expect(isMissingPathError({ code: 'ENOENT' })).toBe(true);
    expect(isMissingPathError({ code: 'ENOTDIR' })).toBe(true);
    expect(isMissingPathError({ code: 'EACCES' })).toBe(false);
    expect(isMissingPathError(new Error('x'))).toBe(false);
    expect(isMissingPathError(null)).toBe(false);

    const fileRoot = path.join(testDir, 'not-a-dir');
    fs.writeFileSync(fileRoot, '');
    expect(() => resolveCwdForScope(scopeFor(fs.realpathSync(fileRoot)))).toThrow(
      /not a directory/,
    );
  });

  it('keeps an explicit scope bound after the active workspace changes', () => {
    const file = path.join(wsDir, 'bound.txt');
    fs.writeFileSync(file, 'project-a');
    const scope = scopeFor(fs.realpathSync(wsDir));
    workspace.current = outsideDir;

    expect(resolvePathForScope(scope, 'bound.txt')).toBe(fs.realpathSync(file));
    expect(resolveCwdForScope(scope)).toBe(fs.realpathSync(wsDir));
    expect(() => resolvePathForScope(scope, path.join(outsideDir, 'secret.txt'))).toThrow(
      /escapes workspace/,
    );
  });
});
