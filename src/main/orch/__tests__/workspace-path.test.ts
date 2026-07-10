import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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
