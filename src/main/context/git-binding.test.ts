import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { inspectGitBinding } from './git-binding';

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function fixture(): { root: string; scope: ProjectExecutionScope } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-binding-')));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'base');
  return {
    root,
    scope: {
      version: 1, installationId: 'install-a', projectId: 'project-a',
      checkoutId: 'checkout-a', rootRealPath: root, identitySource: 'manifest',
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Git workflow binding', () => {
  it('binds exact base, head and binary diff', () => {
    const { root, scope } = fixture();
    const base = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'a.txt'), 'b\n');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-qm', 'change');

    const snapshot = inspectGitBinding(scope, base);
    expect(snapshot.baseSha).toBe(base);
    expect(snapshot.headSha).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(snapshot.diffHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects uncommitted and untracked changes', () => {
    const { root, scope } = fixture();
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'unsafe');
    expect(() => inspectGitBinding(scope)).toThrow(/clean committed/i);
  });
});
