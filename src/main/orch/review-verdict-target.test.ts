import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReviewVerdictTarget } from './review-verdict-target';

const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Nexus Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Nexus Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

let dir = '';
let repo = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...HERMETIC_GIT_ENV },
  }).trim();
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-verdict-target-')));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Nexus Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('F-1432: veredito não segue tag homônima nem nome de branch em hex', () => {
  it('branch com tag homônima amarra o commit da branch', () => {
    const tagSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'release');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
    git('add', 'b.txt');
    git('commit', '-qm', 'na branch');
    const branchSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    git('tag', 'release', tagSha);
    expect(branchSha).not.toBe(tagSha);
    expect(git('rev-parse', 'release^{commit}')).toBe(tagSha);

    const resolved = resolveReviewVerdictTarget(repo, { branch: 'release' });
    expect(resolved).toEqual({ headSha: branchSha, treeDirty: false });
  });

  it('headSha curto ou igual a um nome de branch em hex não grava o commit da branch', () => {
    const head = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c');
    git('add', 'c.txt');
    git('commit', '-qm', 'segundo');
    const second = git('rev-parse', 'HEAD');
    const hexName = ['cafebabe', 'deadbeef', '0badc0de'].find(
      (name) => !head.startsWith(name) && !second.startsWith(name),
    );
    expect(hexName).toBeTruthy();
    git('branch', hexName!, head);

    expect(() => resolveReviewVerdictTarget(repo, { headSha: 'cafe' })).toThrow(
      /não existe neste repositório/u,
    );
    expect(() => resolveReviewVerdictTarget(repo, { headSha: second.slice(0, 6) })).toThrow(
      /não existe neste repositório/u,
    );
    expect(() => resolveReviewVerdictTarget(repo, { headSha: hexName! })).toThrow(
      /não existe neste repositório/u,
    );
    expect(resolveReviewVerdictTarget(repo, { headSha: second.slice(0, 7) })).toEqual({
      headSha: second,
      treeDirty: false,
    });
    expect(resolveReviewVerdictTarget(repo, { headSha: second })).toEqual({
      headSha: second,
      treeDirty: false,
    });
  });
});
