import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { preparePaneSpaceWorktree, isSharedPaneSpaceWorktree, tabGitProofStats, clearTabGitProofCache } from './pane-space-worktree';

let temp: string;
let manager: ProjectRuntimeManager;
let scope: ReturnType<typeof testProjectScope>;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
// O Git para Windows marca o `.git` da worktree como oculto, e o Windows recusa
// sobrescrever arquivo oculto com a flag 'w' (EPERM). 'r+' + truncar funciona
// nas duas plataformas.
function rewriteGitPointer(worktree: string, content: string): void {
  const fd = fs.openSync(path.join(worktree, '.git'), 'r+');
  try { fs.ftruncateSync(fd); fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
}

beforeEach(() => {
  temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tab-worktree-')));
  const root = path.join(temp, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  fs.writeFileSync(path.join(root, 'file.txt'), 'base');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '-qm', 'base');
  scope = testProjectScope({ rootRealPath: root });
  manager = new ProjectRuntimeManager({ baseDir: path.join(temp, 'runtime'), appVersion: 'test' });
  configureWorktreeRuntimeRegistry(manager);
});
afterEach(() => {
  disposeWorktreeRuntimeRegistry();
  manager?.closeAll();
  clearTabGitProofCache();
  fs.rmSync(temp, { recursive: true, force: true });
});

it('shares one durable worktree within a tab and isolates simultaneous tabs from main and WIP', async () => {
  fs.writeFileSync(path.join(scope.rootRealPath, 'file.txt'), 'main WIP');
  const [a, sameA, b] = await Promise.all([
    preparePaneSpaceWorktree(scope, 'space-a'),
    preparePaneSpaceWorktree(scope, 'space-a'),
    preparePaneSpaceWorktree(scope, 'space-b'),
  ]);
  expect(sameA.cwd).toBe(a.cwd);
  expect(isSharedPaneSpaceWorktree(scope, a.scope)).toBe(true);
  expect(isSharedPaneSpaceWorktree(scope, scope)).toBe(false);
  expect(a.cwd).not.toBe(b.cwd);
  expect(a.cwd).not.toBe(scope.rootRealPath);
  expect(fs.readFileSync(path.join(a.cwd, 'file.txt'), 'utf8')).toBe('base');
  fs.writeFileSync(path.join(a.cwd, 'file.txt'), 'tab A');
  expect(fs.readFileSync(path.join(b.cwd, 'file.txt'), 'utf8')).toBe('base');
  expect(fs.readFileSync(path.join(scope.rootRealPath, 'file.txt'), 'utf8')).toBe('main WIP');
  expect(git(a.cwd, 'branch', '--show-current')).not.toBe(git(b.cwd, 'branch', '--show-current'));
  disposeWorktreeRuntimeRegistry();
  configureWorktreeRuntimeRegistry(manager);
  git(scope.rootRealPath, 'switch', '-qc', 'another-main-branch');
  const resumed = await preparePaneSpaceWorktree(scope, 'space-a', a.cwd);
  expect(resumed.cwd).toBe(a.cwd);
  expect(isSharedPaneSpaceWorktree(scope, resumed.scope)).toBe(true);
  expect(fs.readFileSync(path.join(resumed.cwd, 'file.txt'), 'utf8')).toBe('tab A');
});

it.each(['main', 'sibling'])('rejects a .git pointer replaced with %s HEAD/index', async (target) => {
  const a = await preparePaneSpaceWorktree(scope, 'space-a');
  const b = await preparePaneSpaceWorktree(scope, 'space-b');
  const admin = git(target === 'main' ? scope.rootRealPath : b.cwd, 'rev-parse', '--absolute-git-dir');
  rewriteGitPointer(a.cwd, `gitdir: ${admin}\n`);
  await expect(preparePaneSpaceWorktree(scope, 'space-a')).rejects.toThrow();
  expect(() => isSharedPaneSpaceWorktree(scope, a.scope)).toThrow();
});

it('explains recovery for a missing tab without replacing its recorded branch or trapping the user in a raw Git error', async () => {
  const a = await preparePaneSpaceWorktree(scope, 'space-a');
  fs.rmSync(a.cwd, { recursive: true });
  await expect(preparePaneSpaceWorktree(scope, 'space-a')).rejects.toThrow('Abra uma nova aba');
  const next = await preparePaneSpaceWorktree(scope, 'space-new-attempt');
  expect(next.cwd).not.toBe(a.cwd);
  expect(fs.existsSync(path.join(next.cwd, 'file.txt'))).toBe(true);
});

it('rejects an invalid tab, escaped cwd and a deleted or substituted worktree without falling back to main', async () => {
  await expect(preparePaneSpaceWorktree(scope, '../escape')).rejects.toThrow();
  const a = await preparePaneSpaceWorktree(scope, 'space-a');
  await expect(preparePaneSpaceWorktree(scope, 'space-a', temp)).rejects.toThrow();
  fs.rmSync(a.cwd, { recursive: true });
  fs.symlinkSync(scope.rootRealPath, a.cwd, 'dir');
  await expect(preparePaneSpaceWorktree(scope, 'space-a')).rejects.toThrow();
  expect(fs.readFileSync(path.join(scope.rootRealPath, 'file.txt'), 'utf8')).toBe('base');
});

// F-980: a verificação de identidade da aba custava 4 spawns síncronos de git
// em cada "+pane"/resume. A prova agora é cacheada por fingerprint das duas
// pontas da cadeia de ponteiros (.git da worktree ↔ gitdir do admin), com as
// checagens puras de fs refeitas a cada chamada. Fail-closed: ponteiro trocado
// por fora invalida e o assert continua recusando.
it('reuses the cached tab git proof on the second verification (zero git spawns)', async () => {
  const a = await preparePaneSpaceWorktree(scope, 'space-cache');
  const before = tabGitProofStats();
  expect(before.gitRuns).toBeGreaterThan(0);
  const again = await preparePaneSpaceWorktree(scope, 'space-cache');
  expect(again.cwd).toBe(a.cwd);
  const after = tabGitProofStats();
  expect(after.gitRuns).toBe(before.gitRuns);
  expect(after.hits).toBe(before.hits + 1);
});

it('a tampered .git pointer invalidates the cache and still fails closed', async () => {
  const a = await preparePaneSpaceWorktree(scope, 'space-cache-tamper');
  const before = tabGitProofStats();
  const admin = git(scope.rootRealPath, 'rev-parse', '--absolute-git-dir');
  rewriteGitPointer(a.cwd, `gitdir: ${admin}\n`);
  await expect(
    preparePaneSpaceWorktree(scope, 'space-cache-tamper'),
  ).rejects.toThrow('A pasta isolada da aba mudou no disco');
  const after = tabGitProofStats();
  expect(after.gitRuns).toBeGreaterThan(before.gitRuns);
  expect(after.hits).toBe(before.hits);
});
