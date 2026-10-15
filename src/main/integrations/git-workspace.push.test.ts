/**
 * Integration smoke: default-branch resolution + push-before-PR against a
 * real bare repo standing in for origin. Covers the HIGH audit finding
 * "Criar PR sem push e com targetBranch hardcoded 'main'".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitBranchPushState, gitDefaultBranch, gitPushCurrentBranch, gitUpstreamStatus } from './git-workspace';

function run(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Nexus Push Test',
      GIT_AUTHOR_EMAIL: 'push-test@nexus.local',
      GIT_COMMITTER_NAME: 'Nexus Push Test',
      GIT_COMMITTER_EMAIL: 'push-test@nexus.local',
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

describe('gitDefaultBranch / gitPushCurrentBranch (real git)', () => {
  let origin: string;
  let clone: string;

  beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-origin-'));
    // Bare origin whose default branch is 'trunk' (NOT 'main') — proves we
    // resolve the real default instead of hardcoding.
    run(origin, ['init', '--bare', '-b', 'trunk']);

    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-clone-'));
    run(clone, ['clone', origin, '.']);
    run(clone, ['config', 'user.name', 'Nexus Push Test']);
    run(clone, ['config', 'user.email', 'push-test@nexus.local']);
    fs.writeFileSync(path.join(clone, 'README.md'), '# push\n');
    run(clone, ['add', 'README.md']);
    run(clone, ['commit', '-m', 'init']);
    run(clone, ['push', '-u', 'origin', 'trunk']);
    // Make origin/HEAD point at trunk so symbolic-ref resolution works.
    run(origin, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    run(clone, ['remote', 'set-head', 'origin', '-a']);
  });

  afterEach(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it('resolves the real default branch (trunk, not main)', async () => {
    expect(await gitDefaultBranch(clone)).toBe('trunk');
  });

  it('falls back to main when no remote HEAD is known', async () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-solo-'));
    run(solo, ['init', '-b', 'main']);
    expect(await gitDefaultBranch(solo)).toBe('main');
    fs.rmSync(solo, { recursive: true, force: true });
  });

  it('surfaces a structured git error instead of a cryptic HTTP for a blocked push', async () => {
    // The hardened runner refuses the local `file:` transport by design
    // (GIT_ALLOW_PROTOCOL = https/ssh/git/http). Real origins are https/ssh;
    // what we assert here is the finding's core: the failure comes back as a
    // structured { ok:false, error } the UI can show — not a bare http-422.
    run(clone, ['checkout', '-b', 'feature/x']);
    fs.writeFileSync(path.join(clone, 'f.txt'), 'work\n');
    run(clone, ['add', 'f.txt']);
    run(clone, ['commit', '-m', 'work']);

    const result = await gitPushCurrentBranch(clone, 'feature/x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
    expect(result.error.toLowerCase()).toContain('transport');
  });

  it('rejects an unsafe branch name before invoking git', async () => {
    expect((await gitPushCurrentBranch(clone, '--force')).ok).toBe(false);
    expect((await gitPushCurrentBranch(clone, 'HEAD')).ok).toBe(false);
    expect((await gitPushCurrentBranch(clone, '')).ok).toBe(false);
  });

  it('rejects refspec-injection branch names (: + ~ .. metacharacters)', async () => {
    // Sem esta guarda, 'a:refs/heads/b' viraria um refspec empurrando um ref
    // local para uma branch remota arbitrária; '+a:b' faria force-push.
    expect((await gitPushCurrentBranch(clone, 'main:refs/heads/production')).ok).toBe(false);
    expect((await gitPushCurrentBranch(clone, '+main:refs/heads/x')).ok).toBe(false);
    expect((await gitPushCurrentBranch(clone, 'feature~1')).ok).toBe(false);
    expect((await gitPushCurrentBranch(clone, 'a b')).ok).toBe(false);
    expect((await gitPushCurrentBranch(clone, 'foo/../bar')).ok).toBe(false);
    // Nome válido com barra e ponto passa da validação (falha depois no
    // transporte file: do runner endurecido, não na validação de nome).
    const r = await gitPushCurrentBranch(clone, 'feature/x.1');
    if (!r.ok) expect(r.error.toLowerCase()).not.toContain('inválido');
  });

  it('returns a structured error when there is no origin remote', async () => {
    const noRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-noremote-'));
    run(noRemote, ['init', '-b', 'main']);
    run(noRemote, ['config', 'user.name', 'x']);
    run(noRemote, ['config', 'user.email', 'x@y.z']);
    fs.writeFileSync(path.join(noRemote, 'a.txt'), 'a\n');
    run(noRemote, ['add', 'a.txt']);
    run(noRemote, ['commit', '-m', 'a']);
    const result = await gitPushCurrentBranch(noRemote, 'main');
    expect(result.ok).toBe(false);
    fs.rmSync(noRemote, { recursive: true, force: true });
  });
});

describe('gitBranchPushState (real git)', () => {
  let origin: string;
  let clone: string;

  beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-origin-'));
    run(origin, ['init', '--bare', '-b', 'trunk']);

    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-clone-'));
    run(clone, ['clone', origin, '.']);
    run(clone, ['config', 'user.name', 'Nexus Push Test']);
    run(clone, ['config', 'user.email', 'push-test@nexus.local']);
    fs.writeFileSync(path.join(clone, 'README.md'), '# push\n');
    run(clone, ['add', 'README.md']);
    run(clone, ['commit', '-m', 'init']);
    run(clone, ['push', '-u', 'origin', 'trunk']);
    run(origin, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    run(clone, ['remote', 'set-head', 'origin', '-a']);
  });

  afterEach(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it('reports a never-pushed branch as not on remote', async () => {
    run(clone, ['checkout', '-b', 'feature/new']);
    expect(await gitBranchPushState(clone, 'feature/new')).toEqual({
      isOnRemote: false,
      aheadCount: 0,
    });
  });

  it('reports a pushed branch as on remote with zero ahead', async () => {
    run(clone, ['checkout', '-b', 'feature/x']);
    fs.writeFileSync(path.join(clone, 'f.txt'), 'work\n');
    run(clone, ['add', 'f.txt']);
    run(clone, ['commit', '-m', 'work']);
    // Raw helper push — the hardened runner refuses the local file: transport.
    run(clone, ['push', '-u', 'origin', 'feature/x']);
    expect(await gitBranchPushState(clone, 'feature/x')).toEqual({
      isOnRemote: true,
      aheadCount: 0,
    });
  });

  it('counts ahead commits after the branch is on remote', async () => {
    run(clone, ['checkout', '-b', 'feature/y']);
    run(clone, ['push', '-u', 'origin', 'feature/y']);
    fs.writeFileSync(path.join(clone, 'g.txt'), 'more\n');
    run(clone, ['add', 'g.txt']);
    run(clone, ['commit', '-m', 'more']);
    expect(await gitBranchPushState(clone, 'feature/y')).toEqual({
      isOnRemote: true,
      aheadCount: 1,
    });
  });

  it('treats unsafe branch names as not on remote (push path validates later)', async () => {
    expect(await gitBranchPushState(clone, '--force')).toEqual({
      isOnRemote: false,
      aheadCount: 0,
    });
    expect(await gitBranchPushState(clone, 'a:refs/heads/b')).toEqual({
      isOnRemote: false,
      aheadCount: 0,
    });
  });
});

describe('gitUpstreamStatus (real git)', () => {
  let origin: string;
  let clone: string;

  beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-up-origin-'));
    run(origin, ['init', '--bare', '-b', 'trunk']);
    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-up-clone-'));
    run(clone, ['clone', origin, '.']);
    run(clone, ['config', 'user.name', 'Nexus Push Test']);
    run(clone, ['config', 'user.email', 'push-test@nexus.local']);
    fs.writeFileSync(path.join(clone, 'README.md'), '# push\n');
    run(clone, ['add', 'README.md']);
    run(clone, ['commit', '-m', 'init']);
    run(clone, ['push', '-u', 'origin', 'trunk']);
    run(origin, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    run(clone, ['remote', 'set-head', 'origin', '-a']);
  });

  afterEach(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  });

  it('reports tracking branch with zero divergence', async () => {
    expect(await gitUpstreamStatus(clone, 'trunk')).toEqual({
      hasUpstream: true,
      ahead: 0,
      behind: 0,
    });
  });

  it('counts ahead after a local commit', async () => {
    fs.writeFileSync(path.join(clone, 'n.txt'), 'n\n');
    run(clone, ['add', 'n.txt']);
    run(clone, ['commit', '-m', 'n']);
    expect(await gitUpstreamStatus(clone, 'trunk')).toEqual({
      hasUpstream: true,
      ahead: 1,
      behind: 0,
    });
  });

  it('reports no upstream on a never-pushed branch', async () => {
    run(clone, ['checkout', '-b', 'feature/local']);
    expect(await gitUpstreamStatus(clone, 'feature/local')).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0,
    });
  });
});
