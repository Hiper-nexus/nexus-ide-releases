import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asyncProcessGitRunner,
  collectGitRepositoryContext,
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
    // O shim git→xcrun do macOS emite "couldn't create cache file … xcrun_db"
    // no stderr (às vezes com linha vazia extra) quando o ambiente nega a
    // escrita do cache do xcrun (sandbox de verificação/CI); o git em si roda
    // normal e a config global continua neutralizada — ruído do shim não é
    // config vazando. Qualquer OUTRA linha de stderr continua falhando o teste.
    const xcrunShimNoise = /^git: error: couldn't create cache file '[^']*' \(errno=[^)]*\)$/;
    const significant = inside.stderr
      .split('\n')
      .filter((line) => line !== '' && !xcrunShimNoise.test(line))
      .join('\n');
    expect(significant).toBe('');
    expect(inside.status).toBe(0);
    expect(inside.stdout.trim()).toBe('true');

    const config = processGitRunner.run(repo, ['config', '--list', '--show-origin']);
    expect(config.status).toBe(0);
    expect(config.stdout).not.toContain('config-global-vazou');
  });

  // H2: grafts fabricam ancestralidade — o git honra .git/info/grafts mesmo
  // com --no-replace-objects, então um repo hostil forja a âncora do
  // `merge-base --is-ancestor`. O env endurecido precisa neutralizar o arquivo.
  it('ignora .git/info/grafts: âncora fabricada não é ancestral', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lineage-grafts-'));
    tempDirs.push(repo);
    const gitIn = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', repo, '-c', 'user.name=Nexus Test', '-c', 'user.email=nexus@example.invalid', ...args],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    gitIn('init', '-q', '-b', 'main');
    gitIn('commit', '-q', '--allow-empty', '-m', 'base');
    gitIn('checkout', '-q', '--orphan', 'fabricated');
    gitIn('commit', '-q', '--allow-empty', '-m', 'orphan');
    const fabricated = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    gitIn('checkout', '-q', 'main');
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // Grafts inventa o commit órfão como pai do HEAD da main.
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'info', 'grafts'), `${head} ${fabricated}\n`);
    const probe = ['merge-base', '--is-ancestor', fabricated, 'HEAD'];
    expect(processGitRunner.run(repo, probe, { allowFailure: true }).status).toBe(1);
    expect((await asyncProcessGitRunner.run(repo, probe, { allowFailure: true })).status).toBe(1);
  });
});

describe('collectGitRepositoryContext', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function gitRepo(): string {
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lineage-root-')),
    );
    tempDirs.push(repo);
    execFileSync('git', ['init', '-q', repo]);
    return repo;
  }

  it('aceita a raiz do worktree escrita com outra caixa', (ctx) => {
    // No Windows o git devolve a grafia do disco; a pasta escolhida podia vir
    // como `c:\users\…` (ou `ADMINI~1`) e a raiz certa virava "manifesto
    // fora da raiz do worktree".
    const repo = gitRepo();
    const respelled = repo.toUpperCase() === repo ? repo.toLowerCase() : repo.toUpperCase();
    if (respelled === repo || !fs.existsSync(respelled)) ctx.skip();

    const context = collectGitRepositoryContext(respelled);
    expect(fs.realpathSync.native(context.topLevelRealPath)).toBe(
      fs.realpathSync.native(repo),
    );
  });

  it('continua recusando manifesto num subdiretório do worktree', () => {
    const repo = gitRepo();
    const nested = path.join(repo, 'pacote');
    fs.mkdirSync(nested);

    expect(() => collectGitRepositoryContext(nested)).toThrow(
      'project manifest must live at the Git worktree root',
    );
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
