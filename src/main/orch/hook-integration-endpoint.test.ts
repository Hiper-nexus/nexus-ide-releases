import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionStore, type ScopedMissionStore } from './mission-store';
import {
  handleHookIntegrationRequest,
  integrationCommandHit,
} from './hook-integration-endpoint';
import type { AgentGateContext } from './gate';
import type { GitRunner } from '../runtime/git-command';

let dir = '';
let repo = '';
let runtime: ProjectRuntimeManager;
let store: ScopedMissionStore;
let missionId = '';
let scope: ReturnType<typeof testProjectScope>;

/**
 * F-816: o fixture não pode depender da máquina. Sem isso, o `git init` criava
 * `master` onde `init.defaultBranch` não está configurado (e o teste assumia
 * `main`), e um `~/.gitconfig` com `url.insteadOf`, assinatura ou autor próprio
 * mudava o resultado. O env abaixo vale para o git do FIXTURE; o runner de
 * produção descarta `GIT_*` (git-command.ts) e lê o config global pelo HOME,
 * por isso o `beforeEach` também aponta HOME/XDG para um diretório vazio.
 */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Nexus Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Nexus Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const ISOLATED_HOME_VARS = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'] as const;
const savedHomeEnv: Partial<Record<(typeof ISOLATED_HOME_VARS)[number], string | undefined>> = {};

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC_GIT_ENV },
  }).trim();
}

function git(...args: string[]): string {
  return runGit(repo, ...args);
}

/** Outro desenvolvedor clona o remoto, commita `file` e publica no `main` dele. */
function pushFromOtherClone(remoteDir: string, name: string, file: string, message: string): void {
  const otherDir = path.join(dir, name);
  runGit(dir, 'clone', '-q', remoteDir, otherDir);
  fs.writeFileSync(path.join(otherDir, file), message);
  runGit(otherDir, 'add', file);
  runGit(otherDir, '-c', 'user.name=Other Dev', '-c', 'user.email=other@example.invalid', 'commit', '-qm', message);
  runGit(otherDir, 'push', '-q', 'origin', 'main');
}

function hookCtx(overrides: Partial<AgentGateContext> = {}) {
  return {
    sessionId: 'session-hook',
    missionId,
    scope,
    executionScope: scope,
    ...overrides,
  };
}

function bash(command: string, cwd?: string) {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

const storesFor = () => ({ missions: store });

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hook-integration-')));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const isolatedHome = path.join(dir, 'home');
  fs.mkdirSync(isolatedHome);
  for (const name of ISOLATED_HOME_VARS) {
    savedHomeEnv[name] = process.env[name];
    process.env[name] = isolatedHome;
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Nexus Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  runtime = new ProjectRuntimeManager({
    baseDir: path.join(dir, 'runtime'),
    appVersion: 'hook-integration-test',
  });
  scope = testProjectScope({ rootRealPath: repo });
  store = createScopedMissionStore(runtime, scope);
  missionId = store.create({ title: 'Missão do hook' }).id;
});

afterEach(() => {
  runtime.closeAll();
  for (const name of ISOLATED_HOME_VARS) {
    if (savedHomeEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedHomeEnv[name];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('integrationCommandHit', () => {
  it('casa comandos integradores e ignora os demais', () => {
    expect(integrationCommandHit('git push origin main')).toBe(true);
    expect(integrationCommandHit('  gh pr create --fill')).toBe(true);
    expect(integrationCommandHit('git merge feature main')).toBe(true);
    expect(integrationCommandHit('cd repo && git push')).toBe(true);
    expect(integrationCommandHit('git status')).toBe(false);
    expect(integrationCommandHit('git push --dry-run')).toBe(false);
    expect(integrationCommandHit('git merge feature hotfix')).toBe(false);
  });

  it('só pergunta a branch ao git quando o comando é um git merge', () => {
    // O hook roda em todo Bash de pane de missão e o git do runner é
    // spawnSync no Main: comando comum não pode pagar um processo git.
    const calls: string[][] = [];
    const spy: GitRunner = {
      run: (_cwd, args) => {
        calls.push([...args]);
        return { status: 0, stdout: 'main\n', stderr: '' };
      },
    };
    expect(integrationCommandHit('ls -la && npx vitest run', { cwd: '/repo', git: spy })).toBe(false);
    expect(integrationCommandHit('git status', { cwd: '/repo', git: spy })).toBe(false);
    expect(calls).toEqual([]);
    expect(integrationCommandHit('git merge feature', { cwd: '/repo', git: spy })).toBe(true);
    expect(calls).toEqual([['symbolic-ref', '--short', '-q', 'HEAD']]);
  });
});

/**
 * F-814: `git merge-base`/`merge-tree`/`merge-file` e o fim de um merge
 * (`--abort`/`--quit`/`--continue`) não integram nada; barrá-los no checkout
 * `main` deixava o agente sem o comando de recuperação no meio de um conflito.
 */
describe('F-814: merge-* de leitura e controle de merge não são integração', () => {
  /** `main` e `feature` editam a mesma linha de a.txt; deixa o merge em conflito. */
  function startConflictedMerge(): void {
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'lado da feature');
    git('commit', '-qam', 'feature edita a.txt');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'lado do main');
    git('commit', '-qam', 'main edita a.txt');
    expect(() => git('merge', 'feature')).toThrow();
    expect(git('status', '--porcelain')).toContain('UU a.txt');
    expect(git('rev-parse', '-q', '--verify', 'MERGE_HEAD')).toMatch(/^[a-f0-9]{40}$/u);
  }

  function createFeatureBranch(): void {
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature code');
    git('add', 'feat.txt');
    git('commit', '-qm', 'feature commit');
    git('checkout', '-q', 'main');
  }

  const READ_ONLY_MERGE_COMMANDS = [
    'git merge-base HEAD feature',
    'git merge-base --is-ancestor HEAD feature',
    'git merge-base --is-ancestor feature main',
    'git merge-base origin/main HEAD',
    'git merge-tree --write-tree HEAD feature',
    'git merge-file a.txt base.txt other.txt',
    'cd . && git merge-base HEAD main',
    'git merge-base HEAD main | head -1',
  ];

  it.each(READ_ONLY_MERGE_COMMANDS)('%s não é bloqueado no main limpo', async (command) => {
    createFeatureBranch();
    await expect(
      handleHookIntegrationRequest(hookCtx(), bash(command), { storesFor }),
    ).resolves.toMatchObject({ payload: {} });
    expect(integrationCommandHit(command, repo)).toBe(false);
  });

  it.each(READ_ONLY_MERGE_COMMANDS)('%s não é bloqueado no meio de um conflito', async (command) => {
    startConflictedMerge();
    await expect(
      handleHookIntegrationRequest(hookCtx(), bash(command), { storesFor }),
    ).resolves.toMatchObject({ payload: {} });
    expect(integrationCommandHit(command, repo)).toBe(false);
  });

  const MERGE_CONTROL_COMMANDS = [
    'git merge --abort',
    'git merge --quit',
    'git merge --continue',
    '  git merge --abort  ',
    'git merge --abort 2>&1',
    'git merge --abort >/dev/null 2>&1 || true',
    'git merge --abort && git status',
    "git merge '--abort'",
  ];

  it.each(MERGE_CONTROL_COMMANDS)('%s passa no main com conflito em andamento', async (command) => {
    startConflictedMerge();
    await expect(
      handleHookIntegrationRequest(hookCtx(), bash(command), { storesFor }),
    ).resolves.toMatchObject({ payload: {} });
    expect(integrationCommandHit(command, repo)).toBe(false);
  });

  it('o --abort liberado de fato desfaz o merge: a recuperação existe de ponta a ponta', async () => {
    startConflictedMerge();
    const result = await handleHookIntegrationRequest(hookCtx(), bash('git merge --abort'), { storesFor });
    expect(result.payload).toEqual({});
    git('merge', '--abort');
    expect(git('status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('lado do main');
  });

  it('merge de verdade no main continua exigindo o veredito', async () => {
    createFeatureBranch();
    for (const command of [
      'git merge feature',
      'git merge --no-ff feature',
      'git merge --squash feature',
      'git merge -m "msg" feature',
      'git merge-base HEAD main && git merge feature',
      'git merge --abort || git merge feature',
    ]) {
      const result = await handleHookIntegrationRequest(hookCtx(), bash(command), { storesFor });
      expect(result.payload, command).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('review_required'),
      });
    }
  });

  it('não dá para esconder um merge real atrás de "--abort" como argumento de outra opção', () => {
    createFeatureBranch();
    expect(integrationCommandHit("git merge -m '--abort' feature", repo)).toBe(true);
    expect(integrationCommandHit('git merge --abort feature', repo)).toBe(true);
    expect(integrationCommandHit('git merge --continue --no-ff feature', repo)).toBe(true);
    expect(integrationCommandHit('git merge --abort; git push origin main', repo)).toBe(true);
  });

  it('merge explícito para main fora do checkout main continua sendo integração; merge-base não', () => {
    expect(integrationCommandHit('git merge feature main')).toBe(true);
    expect(integrationCommandHit('git merge origin/main')).toBe(true);
    expect(integrationCommandHit('git merge-base feature main')).toBe(false);
    expect(integrationCommandHit('git merge-base --is-ancestor feature master')).toBe(false);
    expect(integrationCommandHit('git merge-tree --write-tree main feature')).toBe(false);
    expect(integrationCommandHit('git merge-file main.txt a b')).toBe(false);
  });

  it('merge em andamento recebe mensagem própria, nunca "commite" (push com conflito no main)', async () => {
    startConflictedMerge();
    for (const command of ['git push origin main', 'git merge feature']) {
      const result = await handleHookIntegrationRequest(hookCtx(), bash(command), { storesFor });
      expect(result.payload, command).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('review_required'),
      });
      const reason = String((result.payload as { reason?: unknown }).reason);
      expect(reason, command).toContain('merge em andamento');
      expect(reason, command).toContain('git merge --abort');
      expect(reason, command).not.toMatch(/commit/iu);
      expect(reason, command).not.toContain('árvore suja');
    }
  });

  it('árvore suja sem merge em andamento continua pedindo commit e veredito', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edição solta');
    const result = await handleHookIntegrationRequest(hookCtx(), bash('git push origin main'), { storesFor });
    expect(result.payload).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('árvore suja'),
    });
  });

  describe('varredura linear (16 KB, teto de 50 ms)', () => {
    const SIZE = 16_384;
    // Runner espião: a branch vem sem processo, então o tempo medido é só o da regex.
    const onMain: GitRunner = { run: () => ({ status: 0, stdout: 'main\n', stderr: '' }) };
    const inputs: Array<[string, string, boolean]> = [
      ['git merge e espaços sem fim', `git merge${' '.repeat(SIZE)}`, true],
      ['git merge-base e espaços', `git merge-base${' '.repeat(SIZE)}`, false],
      ['merge --abort e espaços', `git merge --abort${' '.repeat(SIZE)}`, false],
      ['espaços antes do comando', `${' '.repeat(SIZE)}git merge-base HEAD main`, false],
      ['merge com muitos argumentos sem main', `git merge ${'feature '.repeat(SIZE / 8)}`, true],
      ['merge-base com muitos argumentos', `git merge-base ${'ref '.repeat(SIZE / 4)}`, false],
      ['milhares de segmentos merge-base', 'git merge-base a b; '.repeat(SIZE / 20), false],
      ['aspas desbalanceadas', `git merge --abort ${'"'.repeat(SIZE)}`, true],
      ['redirecionamentos em série', `git merge --abort${' 2>&1'.repeat(SIZE / 5)}`, false],
      ['dígitos e espaços', `git merge --abort ${'1 '.repeat(SIZE / 2)}`, true],
      ['linhas em branco', '\n'.repeat(SIZE), false],
    ];

    it.each(inputs)('%s', (_label, text, expected) => {
      // Aquece: a compilação da regex não é o que está sendo medido.
      integrationCommandHit(text, { cwd: '/repo', git: onMain });
      const startedAt = performance.now();
      const hit = integrationCommandHit(text, { cwd: '/repo', git: onMain });
      const elapsedMs = performance.now() - startedAt;
      expect(hit).toBe(expected);
      expect(elapsedMs).toBeLessThan(50);
    });
  });
});

describe('POST /hook/integration', () => {
  it('bloqueia git push de sessão de missão sem veredito', async () => {
    const result = await handleHookIntegrationRequest(
      hookCtx(),
      bash('git push origin main'),
      { storesFor },
    );
    expect(result.payload).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('review_required'),
    });
  });

  it('devolve {} para comandos não integradores e --dry-run', async () => {
    await expect(
      handleHookIntegrationRequest(hookCtx(), bash('git status'), { storesFor }),
    ).resolves.toMatchObject({ payload: {} });
    await expect(
      handleHookIntegrationRequest(hookCtx(), bash('git push --dry-run'), { storesFor }),
    ).resolves.toMatchObject({ payload: {} });
  });

  it('pane sem missão não tem portão', async () => {
    await expect(
      handleHookIntegrationRequest(hookCtx({ missionId: undefined }), bash('git push'), { storesFor }),
    ).resolves.toMatchObject({ payload: {} });
  });

  it('cwd fora do checkout de execução é bloqueio deliberado', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-outside-'));
    const result = await handleHookIntegrationRequest(
      hookCtx(),
      bash('git push', outside),
      { storesFor },
    );
    expect(result.payload).toMatchObject({ decision: 'block' });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('approve de ponta do HEAD exato libera o comando', async () => {
    store.reviewVerdicts.record({
      missionId,
      headSha: git('rev-parse', 'HEAD'),
      treeDirty: false,
      verdict: 'approve',
      reviewerAdapter: 'claude',
      reviewerModel: 'claude-opus-5-6',
      frontier: true,
      summary: 'Aprovado.',
    });
    await expect(
      handleHookIntegrationRequest(hookCtx(), bash('git push origin main'), { storesFor }),
    ).resolves.toMatchObject({ payload: {} });
  });

  describe('sincronização fast-forward e direção do merge (F-778)', () => {
    function setupRemote(remoteName = 'origin') {
      const remoteDir = path.join(dir, `${remoteName}.git`);
      runGit(dir, 'clone', '-q', '--bare', repo, remoteDir);
      git('remote', 'add', remoteName, remoteDir);
      git('fetch', remoteName, '-q');
      git('branch', `--set-upstream-to=${remoteName}/main`, 'main');
      return remoteDir;
    }

    it('igual ao upstream com --ff-only passa sem exigir veredito', async () => {
      setupRemote('origin');
      const result = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only origin/main'),
        { storesFor },
      );
      expect(result.payload).toEqual({});
    });

    it('atrás do upstream com --ff-only passa sem exigir veredito', async () => {
      const remoteDir = setupRemote('origin');
      pushFromOtherClone(remoteDir, 'other-clone', 'upstream.txt', 'upstream commit');
      git('fetch', 'origin', '-q');

      const result = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only origin/main'),
        { storesFor },
      );
      expect(result.payload).toEqual({});
    });

    it('à frente ou divergente exige gate', async () => {
      const remoteDir = setupRemote('origin');
      // Local commit à frente
      fs.writeFileSync(path.join(repo, 'local.txt'), 'local commit');
      git('add', 'local.txt');
      git('commit', '-qm', 'local commit ahead');

      const resultAhead = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only origin/main'),
        { storesFor },
      );
      expect(resultAhead.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('review_required'),
      });

      // Divergente: commit no remote também
      pushFromOtherClone(remoteDir, 'other-divergent', 'remote-div.txt', 'remote div commit');
      git('fetch', 'origin', '-q');

      const resultDiv = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only origin/main'),
        { storesFor },
      );
      expect(resultDiv.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('review_required'),
      });
    });

    it('branch feature com --ff-only exige gate', async () => {
      setupRemote('origin');
      git('checkout', '-b', 'feature');

      const result = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only origin/main'),
        { storesFor },
      );
      expect(result.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('review_required'),
      });
    });

    it('alvo diferente do upstream exige gate', async () => {
      setupRemote('origin');
      const upstreamDir = path.join(dir, 'upstream.git');
      runGit(dir, 'clone', '-q', '--bare', repo, upstreamDir);
      git('remote', 'add', 'upstream', upstreamDir);
      git('fetch', 'upstream', '-q');

      const result = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only upstream/main'),
        { storesFor },
      );
      expect(result.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('review_required'),
      });
    });

    it('mistura com push no mesmo comando exige gate', async () => {
      setupRemote('origin');
      const result = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only origin/main && git push origin main'),
        { storesFor },
      );
      expect(result.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('review_required'),
      });
    });

    it('git merge feature estando no main exige gate (destino implícito)', async () => {
      git('checkout', '-b', 'feature');
      fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature code');
      git('add', 'feat.txt');
      git('commit', '-qm', 'feature commit');
      git('checkout', 'main');

      // Sem veredito, merge de feature no main deve ser bloqueado
      const result = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge feature'),
        { storesFor },
      );
      expect(result.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('review_required'),
      });
    });

    it('detecta direção no integrationCommandHit pelo branch atual do cwd', () => {
      git('checkout', '-b', 'feature');
      fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature code');
      git('add', 'feat.txt');
      git('commit', '-qm', 'feature commit');
      git('checkout', 'main');

      // No main, merge de feature é integração
      expect(integrationCommandHit('git merge feature', repo)).toBe(true);
      expect(integrationCommandHit('git merge feature', { cwd: repo })).toBe(true);

      // No feature, merge de outro branch qualquer (não main/master) não é integração no main
      git('checkout', 'feature');
      expect(integrationCommandHit('git merge other', repo)).toBe(false);
    });
  });
});
