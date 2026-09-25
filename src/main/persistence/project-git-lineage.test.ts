import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectGitRepositoryProof,
  compareRepositoryLineage,
  processGitRunner,
  projectGitResultFromSpawn,
} from './project-git-lineage';
import type { GitRepositoryLineage } from '../../shared/project-identity-types';
import type {
  GitRepositoryProof,
  ProjectGitRunner,
} from './project-git-lineage';

const ANCHOR = 'a'.repeat(40);
const ROOT = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

function lineage(overrides: Partial<GitRepositoryLineage> = {}): GitRepositoryLineage {
  return {
    vcs: 'git',
    originHashes: ['origin-sha256-antigo'],
    rootCommits: [ROOT],
    anchorCommits: [ANCHOR],
    ...overrides,
  };
}

function proof(overrides: Partial<GitRepositoryProof> = {}): GitRepositoryProof {
  return {
    isShallow: false,
    originHashes: ['origin-sha256-novo'],
    rootCommits: [ROOT],
    headCommit: HEAD,
    ...overrides,
  };
}

describe('compareRepositoryLineage', () => {
  it('rename de repo: origin mudou mas anchor alcançável → mesmo projeto', () => {
    // Caso de campo 20/08: cleofasvolarehost/nexus-ide → Hiper-nexus/nexus-ide
    // brickou TODA abertura de workspace. A história (anchor) é a prova mais
    // forte que a URL — um manifesto copiado pra repo alheio nunca tem o
    // anchor alcançável.
    const result = compareRepositoryLineage(lineage(), proof(), () => true);
    expect(result).toEqual({ ok: true });
  });

  it('manifesto copiado: origin mudou E anchor inalcançável → quarentena', () => {
    const result = compareRepositoryLineage(lineage(), proof(), () => false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('shallow não consegue provar anchor → origin divergente falha fechado', () => {
    const result = compareRepositoryLineage(
      lineage(),
      proof({ isShallow: true }),
      () => true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('origin igual + anchor alcançável → ok', () => {
    const result = compareRepositoryLineage(
      lineage({ originHashes: ['origin-sha256-igual'] }),
      proof({ originHashes: ['origin-sha256-igual'] }),
      () => true,
    );
    expect(result).toEqual({ ok: true });
  });

  it('origin igual mas anchor inalcançável → quarentena (anchor manda)', () => {
    const result = compareRepositoryLineage(
      lineage({ originHashes: ['origin-sha256-igual'] }),
      proof({ originHashes: ['origin-sha256-igual'] }),
      () => false,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('sem anchors no manifesto: origin divergente continua quarentenando', () => {
    const result = compareRepositoryLineage(
      lineage({ anchorCommits: [] }),
      proof(),
      () => true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('anchors presentes mas sem verificador → unverifiable, nunca ok', () => {
    const result = compareRepositoryLineage(lineage(), proof());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unverifiable');
  });
});

describe('projectGitResultFromSpawn', () => {
  it('ETIMEDOUT vira status 1 em vez de throw — optional git não quarentena', () => {
    const timedOut = Object.assign(new Error('spawnSync git ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    expect(projectGitResultFromSpawn({ error: timedOut })).toEqual({
      status: 1,
      stdout: '',
      stderr: 'spawnSync git ETIMEDOUT',
    });
  });
});

describe('processGitRunner', () => {
  const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('roda o git com a config global neutralizada em todas as plataformas', () => {
    // No Windows `os.devNull` é `\\.\nul`, que o Git para Windows 2.55 recusa
    // ("unable to access '\\.\nul': Invalid argument"): toda prova de linhagem
    // falhava e o workspace com manifesto não abria.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lineage-home-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lineage-repo-'));
    tempDirs.push(home, repo);
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      '[nexus]\n\tsentinela = config-global-vazou\n',
    );
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const inside = processGitRunner.run(repo, ['rev-parse', '--is-inside-work-tree']);
    expect(inside.stderr).toBe('');
    expect(inside.status).toBe(0);
    expect(inside.stdout.trim()).toBe('true');

    const config = processGitRunner.run(repo, ['config', '--list', '--show-origin']);
    expect(config.status).toBe(0);
    expect(config.stdout).not.toContain('config-global-vazou');
  });
});

describe('collectGitRepositoryProof', () => {
  it('rev-list lento (status 1) não aborta a prova', () => {
    const runner: ProjectGitRunner = {
      run(_cwd, args) {
        if (args.includes('rev-list')) {
          return { status: 1, stdout: '', stderr: 'spawnSync git ETIMEDOUT' };
        }
        if (args.includes('--is-inside-work-tree')) {
          return { status: 0, stdout: 'true\n', stderr: '' };
        }
        if (args.includes('--is-shallow-repository')) {
          return { status: 0, stdout: 'false\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const collected = collectGitRepositoryProof('/repo', runner);
    expect(collected.isShallow).toBe(false);
    expect(collected.rootCommits).toEqual([]);
  });
});
