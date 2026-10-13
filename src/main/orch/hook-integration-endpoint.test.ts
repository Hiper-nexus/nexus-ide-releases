import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionStore, type ScopedMissionStore } from './mission-store';
import {
  boundedHookGitRunner,
  handleHookIntegrationRequest,
  HOOK_GIT_CALL_TIMEOUT_MS,
  HOOK_GIT_TOTAL_BUDGET_MS,
  integrationCommandHit,
} from './hook-integration-endpoint';
import type { AgentGateContext } from './gate';
import {
  AsyncProcessGitRunner,
  GitCommandError,
  type AsyncGitRunner,
  type GitRunOptions,
} from '../runtime/git-command';

/**
 * F-815: conta as chamadas SÍNCRONAS de processo (`spawnSync`, `execFileSync`,
 * `execSync`) que o hook faz enquanto `tracking` está ligado. O fixture do
 * teste usa `execFileSync` de verdade, por isso só se conta dentro do handler.
 */
const syncProcessSpy = vi.hoisted(() => ({ tracking: false, calls: [] as string[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const watch = <F extends (...args: never[]) => unknown>(name: string, fn: F): F =>
    ((...args: unknown[]) => {
      if (syncProcessSpy.tracking) syncProcessSpy.calls.push(name);
      return Reflect.apply(fn, undefined, args);
    }) as unknown as F;
  const patched = {
    ...actual,
    spawnSync: watch('spawnSync', actual.spawnSync),
    execFileSync: watch('execFileSync', actual.execFileSync),
    execSync: watch('execSync', actual.execSync),
  };
  return { ...patched, default: patched };
});

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

/** Remoto bare clonado do repo, com `main` rastreando `<remoto>/main`. */
function setupRemote(remoteName = 'origin'): string {
  const remoteDir = path.join(dir, `${remoteName}.git`);
  runGit(dir, 'clone', '-q', '--bare', repo, remoteDir);
  git('remote', 'add', remoteName, remoteDir);
  git('fetch', remoteName, '-q');
  git('branch', `--set-upstream-to=${remoteName}/main`, 'main');
  return remoteDir;
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
  it('casa comandos integradores e ignora os demais', async () => {
    expect(await integrationCommandHit('git push origin main')).toBe(true);
    expect(await integrationCommandHit('  gh pr create --fill')).toBe(true);
    expect(await integrationCommandHit('git merge feature main')).toBe(true);
    expect(await integrationCommandHit('cd repo && git push')).toBe(true);
    expect(await integrationCommandHit('git status')).toBe(false);
    expect(await integrationCommandHit('git push --dry-run')).toBe(false);
    expect(await integrationCommandHit('git merge feature hotfix')).toBe(false);
  });

  it('só pergunta a branch ao git quando o comando é um git merge', async () => {
    // O hook roda em todo Bash de pane de missão: comando comum não pode
    // pagar um processo git.
    const calls: string[][] = [];
    const spy: AsyncGitRunner = {
      run: async (_cwd, args) => {
        calls.push([...args]);
        return { status: 0, stdout: 'main\n', stderr: '' };
      },
    };
    expect(await integrationCommandHit('ls -la && npx vitest run', { cwd: '/repo', git: spy })).toBe(false);
    expect(await integrationCommandHit('git status', { cwd: '/repo', git: spy })).toBe(false);
    expect(calls).toEqual([]);
    expect(await integrationCommandHit('git merge feature', { cwd: '/repo', git: spy })).toBe(true);
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
    expect(await integrationCommandHit(command, repo)).toBe(false);
  });

  it.each(READ_ONLY_MERGE_COMMANDS)('%s não é bloqueado no meio de um conflito', async (command) => {
    startConflictedMerge();
    await expect(
      handleHookIntegrationRequest(hookCtx(), bash(command), { storesFor }),
    ).resolves.toMatchObject({ payload: {} });
    expect(await integrationCommandHit(command, repo)).toBe(false);
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
    expect(await integrationCommandHit(command, repo)).toBe(false);
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

  it('não dá para esconder um merge real atrás de "--abort" como argumento de outra opção', async () => {
    createFeatureBranch();
    expect(await integrationCommandHit("git merge -m '--abort' feature", repo)).toBe(true);
    expect(await integrationCommandHit('git merge --abort feature', repo)).toBe(true);
    expect(await integrationCommandHit('git merge --continue --no-ff feature', repo)).toBe(true);
    expect(await integrationCommandHit('git merge --abort; git push origin main', repo)).toBe(true);
  });

  it('merge explícito para main fora do checkout main continua sendo integração; merge-base não', async () => {
    expect(await integrationCommandHit('git merge feature main')).toBe(true);
    expect(await integrationCommandHit('git merge origin/main')).toBe(true);
    expect(await integrationCommandHit('git merge-base feature main')).toBe(false);
    expect(await integrationCommandHit('git merge-base --is-ancestor feature master')).toBe(false);
    expect(await integrationCommandHit('git merge-tree --write-tree main feature')).toBe(false);
    expect(await integrationCommandHit('git merge-file main.txt a b')).toBe(false);
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
    const onMain: AsyncGitRunner = { run: async () => ({ status: 0, stdout: 'main\n', stderr: '' }) };
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

    it.each(inputs)('%s', async (_label, text, expected) => {
      // Aquece: a compilação da regex não é o que está sendo medido.
      await integrationCommandHit(text, { cwd: '/repo', git: onMain });
      const startedAt = performance.now();
      const hit = await integrationCommandHit(text, { cwd: '/repo', git: onMain });
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

  describe('F-1423: o portão mede o HEAD da worktree onde o merge acontece', () => {
    function approve(head: string): void {
      store.reviewVerdicts.record({
        missionId,
        headSha: head,
        treeDirty: false,
        verdict: 'approve',
        reviewerAdapter: 'claude',
        reviewerModel: 'claude-opus-5-6',
        frontier: true,
        summary: 'Aprovado na worktree.',
      });
    }

    function addWorktree(name: string, outside: boolean): { wt: string; sha: string } {
      const branch = `integ/${name}`;
      const wt = outside ? path.join(dir, name) : path.join(repo, '.harvest', name);
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      git('branch', branch);
      git('worktree', 'add', '-q', wt, branch);
      fs.writeFileSync(path.join(wt, 'note.txt'), name);
      runGit(wt, 'add', 'note.txt');
      runGit(wt, 'commit', '-qm', name);
      return { wt, sha: runGit(wt, 'rev-parse', 'HEAD') };
    }

    it('cd e git -C usam o HEAD da worktree, não o do pane', async () => {
      const { wt, sha } = addWorktree('s241-integ', false);
      const paneHead = git('rev-parse', 'HEAD');
      expect(sha).not.toBe(paneHead);
      approve(paneHead);
      for (const command of [`cd ${wt} && git push origin main`, `git -C ${wt} push origin main`]) {
        const blocked = await handleHookIntegrationRequest(hookCtx(), bash(command, repo), { storesFor });
        expect(blocked.payload, command).toMatchObject({
          decision: 'block',
          reason: expect.stringContaining(sha.slice(0, 7)),
        });
        expect(String((blocked.payload as { reason?: unknown }).reason)).not.toContain(paneHead.slice(0, 7));
      }
      approve(sha);
      for (const command of [
        `cd ${path.relative(repo, wt)} && git push origin main`,
        `git -C ${wt} push origin main`,
      ]) {
        const allowed = await handleHookIntegrationRequest(hookCtx(), bash(command, repo), { storesFor });
        expect(allowed.payload, command).toEqual({});
      }
    });

    it('worktree ligada fora do checkout de execução entra no portão pelo HEAD dela', async () => {
      const { wt, sha } = addWorktree('s241-fora', true);
      const missing = await handleHookIntegrationRequest(
        hookCtx(),
        bash(`git -C ${wt} push origin main`, repo),
        { storesFor },
      );
      expect(missing.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining(sha.slice(0, 7)),
      });
      approve(sha);
      const allowed = await handleHookIntegrationRequest(
        hookCtx(),
        bash(`cd ${wt} && git merge main`, repo),
        { storesFor },
      );
      expect(allowed.payload).toEqual({});
    });

    it('git -C para outro repositório continua bloqueado', async () => {
      const other = path.join(dir, 'outro');
      fs.mkdirSync(other);
      runGit(dir, 'init', '-q', '-b', 'main', other);
      runGit(other, 'config', 'user.name', 'Nexus Fixture');
      runGit(other, 'config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(path.join(other, 'a.txt'), 'a');
      runGit(other, 'add', 'a.txt');
      runGit(other, 'commit', '-qm', 'init');
      const result = await handleHookIntegrationRequest(
        hookCtx(),
        bash(`git -C ${other} push origin main`, repo),
        { storesFor },
      );
      expect(result.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('cwd fora do checkout'),
      });
    });

    it('cd para a worktree que existe mede o HEAD dela, não o do pane', async () => {
      const { wt, sha } = addWorktree('s243-existe', false);
      const rel = path.relative(repo, wt);
      expect(rel.startsWith(path.join('.harvest', ''))).toBe(true);
      const paneHead = git('rev-parse', 'HEAD');
      approve(paneHead);
      const blocked = await handleHookIntegrationRequest(
        hookCtx(),
        bash(`cd ${rel} && git push`, repo),
        { storesFor },
      );
      expect(blocked.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining(sha.slice(0, 7)),
      });
      expect(String((blocked.payload as { reason?: unknown }).reason)).not.toContain(paneHead.slice(0, 7));
      approve(sha);
      const allowed = await handleHookIntegrationRequest(
        hookCtx(),
        bash(`cd ${rel} && git push`, repo),
        { storesFor },
      );
      expect(allowed.payload).toEqual({});
    });

    it('expansão de shell no cd ou no git -C bloqueia mesmo com o pane aprovado', async () => {
      approve(git('rev-parse', 'HEAD'));
      const reason = 'checkout do merge/push não resolvível; rode no próprio cwd ou use caminho absoluto';
      for (const command of [
        'cd ~/nexus-ide && git push',
        'cd "$WT" && git push',
        'cd $(git rev-parse --show-toplevel) && git push',
        'git -C "$WT" push',
      ]) {
        const result = await handleHookIntegrationRequest(
          hookCtx(),
          bash(command, repo),
          { storesFor },
        );
        expect(result.payload, command).toMatchObject({
          decision: 'block',
          reason: expect.stringContaining(reason),
        });
      }
    });

    it('caminho léxico dentro da raiz que não existe bloqueia, com o pane aprovado', async () => {
      approve(git('rev-parse', 'HEAD'));
      for (const command of [
        'cd .harvest/nao-existe && git push',
        'git -C .harvest/nao-existe push',
      ]) {
        const result = await handleHookIntegrationRequest(
          hookCtx(),
          bash(command, repo),
          { storesFor },
        );
        expect(result.payload, command).toMatchObject({
          decision: 'block',
          reason: expect.stringContaining('cwd fora do checkout'),
        });
      }
    });
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

    it('detecta direção no integrationCommandHit pelo branch atual do cwd', async () => {
      git('checkout', '-b', 'feature');
      fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature code');
      git('add', 'feat.txt');
      git('commit', '-qm', 'feature commit');
      git('checkout', 'main');

      // No main, merge de feature é integração
      expect(await integrationCommandHit('git merge feature', repo)).toBe(true);
      expect(await integrationCommandHit('git merge feature', { cwd: repo })).toBe(true);

      // No feature, merge de outro branch qualquer (não main/master) não é integração no main
      git('checkout', 'feature');
      expect(await integrationCommandHit('git merge other', repo)).toBe(false);
    });
  });

  /**
   * F-815: o hook roda a cada comando Bash de todo pane, dentro do Main. A
   * isenção do F-778 fazia até 9 `spawnSync` git por comando de merge.
   */
  describe('git assíncrono, com timeout, no caminho do hook (F-815)', () => {
    /** Roda o handler contando processos síncronos e passagens pelo runner assíncrono real. */
    async function runTracked(command: string, cwd?: string) {
      const asyncRun = vi.spyOn(AsyncProcessGitRunner.prototype, 'run');
      syncProcessSpy.calls.length = 0;
      syncProcessSpy.tracking = true;
      try {
        const result = await handleHookIntegrationRequest(hookCtx(), bash(command, cwd), { storesFor });
        return {
          result,
          syncCalls: [...syncProcessSpy.calls],
          asyncGitCalls: asyncRun.mock.calls.map((call) => [...call[1]]),
        };
      } finally {
        syncProcessSpy.tracking = false;
        asyncRun.mockRestore();
      }
    }

    function createFeatureBranch(): void {
      git('checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature code');
      git('add', 'feat.txt');
      git('commit', '-qm', 'feature commit');
      git('checkout', '-q', 'main');
    }

    it('a isenção do --ff-only prova o upstream com ~9 chamadas git e nenhuma síncrona', async () => {
      setupRemote('origin');
      const { result, syncCalls, asyncGitCalls } = await runTracked('git merge --ff-only origin/main');
      expect(result.payload).toEqual({});
      expect(syncCalls).toEqual([]);
      // config segura + branch + upstream + alvo + 3 SHAs + merge-base + rev-list.
      expect(asyncGitCalls.length).toBeGreaterThanOrEqual(9);
      expect(asyncGitCalls[0]).toEqual(expect.arrayContaining(['config', '--local', '--get-regexp']));
      expect(asyncGitCalls.some((args) => args[0] === 'merge-base')).toBe(true);
    });

    it('o portão que recusa (merge no main sem veredito) também não usa processo síncrono', async () => {
      createFeatureBranch();
      const { result, syncCalls, asyncGitCalls } = await runTracked('git merge feature');
      expect(result.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringMatching(/review_required:.*HEAD [a-f0-9]{7}/su),
      });
      expect(syncCalls).toEqual([]);
      // branch (direção) + config segura + HEAD + status.
      expect(asyncGitCalls.map((args) => args[0])).toEqual(['symbolic-ref', 'config', 'rev-parse', 'status']);
    });

    it('merge em andamento e push com veredito aprovado: sem processo síncrono', async () => {
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
      const approved = await runTracked('git push origin main');
      expect(approved.result.payload).toEqual({});
      expect(approved.syncCalls).toEqual([]);
      expect(approved.asyncGitCalls.length).toBeGreaterThan(0);

      git('checkout', '-q', '-b', 'feature');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'lado da feature');
      git('commit', '-qam', 'feature edita a.txt');
      git('checkout', '-q', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'lado do main');
      git('commit', '-qam', 'main edita a.txt');
      expect(() => git('merge', 'feature')).toThrow();
      const conflicted = await runTracked('git push origin main');
      expect(conflicted.result.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('merge em andamento'),
      });
      expect(conflicted.syncCalls).toEqual([]);
    });

    it('comando comum não dispara git nenhum, síncrono ou assíncrono', async () => {
      for (const command of ['ls -la', 'git status', 'npm test && git diff', 'git merge-base HEAD main']) {
        const { result, syncCalls, asyncGitCalls } = await runTracked(command);
        expect(result.payload, command).toEqual({});
        expect(syncCalls, command).toEqual([]);
        expect(asyncGitCalls, command).toEqual([]);
      }
    });

    it('toda chamada ao git leva timeout curto, e o runner do handler respeita o orçamento', async () => {
      setupRemote('origin');
      const real = new AsyncProcessGitRunner();
      const timeouts: Array<number | undefined> = [];
      const recording: AsyncGitRunner = {
        run: (cwd, args, options) => {
          timeouts.push(options?.timeoutMs);
          return real.run(cwd, args, options);
        },
      };
      const result = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only origin/main'),
        { storesFor, git: recording },
      );
      expect(result.payload).toEqual({});
      expect(timeouts.length).toBeGreaterThanOrEqual(9);
      for (const timeoutMs of timeouts) {
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(HOOK_GIT_CALL_TIMEOUT_MS);
      }
      // O orçamento total cabe no transporte do hook (curl --max-time 10).
      expect(HOOK_GIT_CALL_TIMEOUT_MS).toBeLessThanOrEqual(HOOK_GIT_TOTAL_BUDGET_MS);
      expect(HOOK_GIT_TOTAL_BUDGET_MS).toBeLessThan(10_000);
    });

    it('boundedHookGitRunner: timeout vira o que resta do orçamento e esgotado não dispara processo', async () => {
      let nowMs = 1_000;
      const seen: Array<GitRunOptions | undefined> = [];
      const inner: AsyncGitRunner = {
        run: async (_cwd, _args, options) => {
          seen.push(options);
          return { status: 0, stdout: '', stderr: '' };
        },
      };
      const bounded = boundedHookGitRunner(inner, 8_000, () => nowMs);
      await bounded.run('/repo', ['status']);
      nowMs += 6_500; // restam 1_500 ms
      await bounded.run('/repo', ['status'], { allowFailure: true });
      expect(seen.map((o) => o?.timeoutMs)).toEqual([HOOK_GIT_CALL_TIMEOUT_MS, 1_500]);
      expect(seen[1]).toMatchObject({ allowFailure: true });
      nowMs += 1_500; // orçamento esgotado
      await expect(bounded.run('/repo', ['status'])).rejects.toThrow('hook_git_budget_exhausted');
      expect(seen).toHaveLength(2);
    });

    it('timeout do git em comando já integrador bloqueia a medida e não abre o push', async () => {
      const timedOut: AsyncGitRunner = {
        run: (_cwd, args) =>
          Promise.reject(new GitCommandError('Git process could not complete', args)),
      };
      for (const command of ['git push origin main', 'git merge --ff-only origin/main']) {
        const result = await handleHookIntegrationRequest(
          hookCtx(),
          bash(command),
          { storesFor, git: timedOut },
        );
        expect(result.payload, command).toMatchObject({
          decision: 'block',
          reason: expect.stringContaining('não consegui medir o checkout'),
        });
      }
      // `git merge feature` só integra se a branch atual for main/master. A sonda
      // da branch engole o erro do git, o hit não se confirma e o hook segue {}.
      await expect(
        handleHookIntegrationRequest(hookCtx(), bash('git merge feature'), { storesFor, git: timedOut }),
      ).resolves.toMatchObject({ payload: {} });
      await expect(
        handleHookIntegrationRequest(hookCtx(), bash('git status'), { storesFor, git: timedOut }),
      ).resolves.toMatchObject({ payload: {} });
    });

    it('config local executável: a isenção não roda nenhum git além da inspeção de config', async () => {
      setupRemote('origin');
      const marker = path.join(dir, 'fsmonitor-ran');
      const script = path.join(dir, 'fsmonitor.sh');
      fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      git('config', 'core.fsmonitor', script);
      const real = new AsyncProcessGitRunner();
      const argv: string[][] = [];
      const recording: AsyncGitRunner = {
        run: (cwd, args, options) => {
          argv.push([...args]);
          return real.run(cwd, args, options);
        },
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await handleHookIntegrationRequest(hookCtx(), bash('git merge --ff-only origin/main'), {
          storesFor,
          git: recording,
        });
      } finally {
        warn.mockRestore();
      }
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.every((args) => args[0] === 'config')).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('limite da heurística: remote-tracking forjado libera o merge LOCAL, mas o push segue barrado', async () => {
      setupRemote('origin');
      createFeatureBranch();
      // Sem fetch nenhum: o ref remote-tracking é gravado localmente.
      git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'feature'));
      const merge = await handleHookIntegrationRequest(
        hookCtx(),
        bash('git merge --ff-only origin/main'),
        { storesFor },
      );
      expect(merge.payload).toEqual({});
      git('merge', '--ff-only', 'origin/main');
      expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'feature'));
      // O veredito é por HEAD exato: o HEAD forjado não tem veredito, então o push é recusado.
      const push = await handleHookIntegrationRequest(hookCtx(), bash('git push origin main'), { storesFor });
      expect(push.payload).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('veredito'),
      });
    });
  });
});
