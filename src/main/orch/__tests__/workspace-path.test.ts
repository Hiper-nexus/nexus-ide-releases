import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWorkspaceCwd,
  resolveWorkspacePath,
} from '../workspace-path';

const workspace = vi.hoisted(() => ({ current: '' }));

vi.mock('../../persistence/workspace-store', () => ({
  activeWorkspaceOrNull: () => workspace.current,
}));

const testDir = path.join(os.tmpdir(), 'nexus-fase4-test-workspace-path');
const wsDir = path.join(testDir, 'workspace');
const outsideDir = path.join(testDir, 'outside');

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
});
