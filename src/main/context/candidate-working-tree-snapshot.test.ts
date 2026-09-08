import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProcessGitRunner } from '../runtime/git-command';
import { captureWorkingTreeCandidate, readCandidateFile } from './candidate-working-tree-snapshot';

const roots: string[] = [];

function fixture(withGit = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-candidate-snapshot-')));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const value = 1;\n');
  const scope: ProjectExecutionScope = {
    version: 1, installationId: 'test', projectId: 'test', checkoutId: 'test',
    rootRealPath: root, identitySource: 'manifest',
  };
  const git = new ProcessGitRunner();
  const run = (...args: string[]) => git.run(root, args).stdout.trim();
  if (withGit) {
    run('init', '-q');
    run('config', 'user.name', 'Nexus Test');
    run('config', 'user.email', 'test@example.invalid');
    run('add', '--', 'app.ts');
    run('commit', '-qm', 'Fixture');
  }
  return { root, scope, run };
}

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe('working-tree candidate snapshot', () => {
  it('provides stable content fingerprints without Git and detects same-size edits', async () => {
    const { root, scope } = fixture();
    const first = await captureWorkingTreeCandidate({ scope });
    expect(first.source).toBe('filesystem');
    expect(first.complete).toBe(true);
    expect(first.headSha).toBeNull();
    expect((await captureWorkingTreeCandidate({ scope })).fingerprint).toBe(first.fingerprint);
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const value = 2;\n');
    expect((await captureWorkingTreeCandidate({ scope })).fingerprint).not.toBe(first.fingerprint);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('does not follow an untracked symlink or treat it as a complete candidate', async () => {
    const { root, scope } = fixture(true);
    fs.symlinkSync(path.join(root, 'app.ts'), path.join(root, 'alias.ts'));
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.incompleteReasons.some((reason) => reason.includes('alias.ts'))).toBe(true);
    expect(() => readCandidateFile(scope, 'alias.ts', 1024)).toThrow(/symbolic link/);
  });

  it('ignores runtime directories and secret basenames without reading their bodies', async () => {
    const { root, scope } = fixture();
    fs.mkdirSync(path.join(root, '.nexus'));
    fs.writeFileSync(path.join(root, '.nexus/runtime.json'), 'synthetic runtime state');
    fs.writeFileSync(path.join(root, '.env.ts'), 'synthetic private fixture');
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.changedPaths).toEqual(['app.ts']);
    expect(() => readCandidateFile(scope, '.env.ts', 1024)).toThrow('unsafe candidate source');
  });

  it('reports truncation instead of a complete fingerprint for oversized directory files', async () => {
    const { root, scope } = fixture();
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.incompleteReasons).toContain('filesystem candidate index was truncated');
  });

  it('falls back to file inspection instead of executing repository clean filters', async () => {
    const { root, scope, run } = fixture(true);
    run('config', 'filter.unsafe.clean', 'false');
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.ts filter=unsafe\n');
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.source).toBe('filesystem');
    expect(snapshot.complete).toBe(true);
    expect(snapshot.changedPaths).toContain('app.ts');
  });

  it('does not silently truncate a large Git candidate inventory', async () => {
    const { root, scope } = fixture(true);
    for (let index = 0; index < 513; index += 1) {
      fs.writeFileSync(path.join(root, `new-${index}.ts`), 'export const value = 1;\n');
    }
    const snapshot = await captureWorkingTreeCandidate({ scope });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.incompleteReasons).toContain('candidate file limit 512 reached');
    expect(snapshot.changedPaths).toHaveLength(512);
  });
});
