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

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
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
  git('init', '-q');
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
      execFileSync('git', ['clone', '--bare', repo, remoteDir], { stdio: 'ignore' });
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
      const otherDir = path.join(dir, 'other-clone');
      execFileSync('git', ['clone', remoteDir, otherDir, '-q'], { stdio: 'ignore' });
      execFileSync('git', ['-C', otherDir, 'config', 'user.name', 'Other Dev'], { stdio: 'ignore' });
      execFileSync('git', ['-C', otherDir, 'config', 'user.email', 'other@example.invalid'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(otherDir, 'upstream.txt'), 'upstream content');
      execFileSync('git', ['-C', otherDir, 'add', 'upstream.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', otherDir, 'commit', '-qm', 'upstream commit'], { stdio: 'ignore' });
      execFileSync('git', ['-C', otherDir, 'push', 'origin', 'main', '-q'], { stdio: 'ignore' });
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
      const otherDir = path.join(dir, 'other-divergent');
      execFileSync('git', ['clone', remoteDir, otherDir, '-q'], { stdio: 'ignore' });
      execFileSync('git', ['-C', otherDir, 'config', 'user.name', 'Other Dev'], { stdio: 'ignore' });
      execFileSync('git', ['-C', otherDir, 'config', 'user.email', 'other@example.invalid'], { stdio: 'ignore' });
      fs.writeFileSync(path.join(otherDir, 'remote-div.txt'), 'remote div');
      execFileSync('git', ['-C', otherDir, 'add', 'remote-div.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', otherDir, 'commit', '-qm', 'remote div commit'], { stdio: 'ignore' });
      execFileSync('git', ['-C', otherDir, 'push', 'origin', 'main', '-q'], { stdio: 'ignore' });
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
      execFileSync('git', ['clone', '--bare', repo, upstreamDir], { stdio: 'ignore' });
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
