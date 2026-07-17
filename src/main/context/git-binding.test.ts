import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  blockingEvidencePaths,
  dirtyPathsFromPorcelainV2,
  inspectGitBinding,
} from './git-binding';

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

  it('rejects dirt on the evidence surface (.context / root docs)', () => {
    const { root, scope } = fixture();
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.context', 'docs', 'x.md'), 'draft');
    expect(() => inspectGitBinding(scope)).toThrow(/clean committed/i);
  });

  it('rejects a dirty root document (CLAUDE.md)', () => {
    const { root, scope } = fixture();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'edited');
    expect(() => inspectGitBinding(scope)).toThrow(/CLAUDE\.md/);
  });

  it('tolerates WIP outside the evidence surface (deadlock de campo)', () => {
    // Regressão: WIP alheio em qualquer arquivo travava o freeze → workers
    // esgotavam → missão morta. Sujeira fora da superfície de evidência não
    // polui o corpus (a ingestão só lê .context/** + docs de raiz) e o
    // binding é 100% dado de commit — não pode mais bloquear.
    const { root, scope } = fixture();
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'wip alheio');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a modificado\n');
    const snapshot = inspectGitBinding(scope);
    expect(snapshot.headSha).toBe(git(root, 'rev-parse', 'HEAD').toLowerCase());
  });

  it('parses porcelain v2 -z including renames and untracked', () => {
    const status = [
      '1 .M N... 100644 100644 100644 abc def src/app.ts',
      '2 R. N... 100644 100644 100644 abc def R100 src/new.ts',
      'src/old.ts',
      '? untracked.txt',
      '? .context/docs/x.md',
    ].join('\0') + '\0';
    const dirty = dirtyPathsFromPorcelainV2(status);
    expect(dirty).toEqual([
      'src/app.ts',
      'src/new.ts',
      'src/old.ts',
      'untracked.txt',
      '.context/docs/x.md',
    ]);
    expect(blockingEvidencePaths(dirty)).toEqual(['.context/docs/x.md']);
  });
});
