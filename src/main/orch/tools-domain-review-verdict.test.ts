import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './__tests__/scope-fixture';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from './project-domain-store-registry';
import { buildDomainTools } from './tools-domain';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { getAgentSessionInfo } from '../pty/pty-manager';

vi.mock('../pty/pty-manager', async (importActual) => {
  const actual = await importActual<typeof import('../pty/pty-manager')>();
  return {
    ...actual,
    getAgentSessionInfo: vi.fn(() => undefined),
  };
});

const reviewTool = () => buildDomainTools().find((tool) => tool.name === 'nexus_review_verdict')!;

let dir = '';
let repo = '';
let runtime: ProjectRuntimeManager;
let suite: ProjectDomainStoreSuite;
let missionId = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function ctxFor(role: 'orchestrator' | 'worker'): AgentGateContext {
  const scope = testProjectScope({ rootRealPath: repo });
  return {
    token: 'token-review',
    label: 'pane-1',
    role,
    sessionId: 'session-1',
    missionId,
    providerId: 'claude',
    scope,
    executionScope: scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-review-tool-')));
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
    appVersion: 'review-tool-test',
  });
  configureProjectDomainStoreRegistry(runtime);
  const scope = testProjectScope({ rootRealPath: repo });
  suite = getProjectDomainStores(scope);
  missionId = suite.missions.create({ title: 'Missão do veredito' }).id;
  vi.mocked(getAgentSessionInfo).mockReturnValue(null);
});

afterEach(() => {
  vi.mocked(getAgentSessionInfo).mockReset();
  disposeProjectDomainStoreRegistry();
  runtime.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('nexus_review_verdict', () => {
  it('approve de juiz de ponta em árvore limpa satisfaz o portão', async () => {
    vi.mocked(getAgentSessionInfo).mockReturnValue({
      model: 'claude-fable-5-1',
    } as never);
    const result = await reviewTool().handler(
      { verdict: 'approve', summary: 'Diff limpo.' },
      ctxFor('orchestrator'),
    );
    expect(result).toMatchObject({
      recorded: true,
      headSha: git('rev-parse', 'HEAD'),
      treeDirty: false,
      frontier: true,
      satisfiesGate: true,
    });
    const stored = suite.missions.reviewVerdicts.latestFor(missionId, git('rev-parse', 'HEAD'));
    expect(stored).toMatchObject({ verdict: 'approve', reviewerAdapter: 'claude' });
  });

  it('approve de adapter barato (glm) é registrado mas não satisfaz o portão', async () => {
    const result = await reviewTool().handler(
      { verdict: 'approve', summary: 'Opinião barata.' },
      { ...ctxFor('worker'), providerId: 'glm' },
    );
    expect(result).toMatchObject({
      recorded: true,
      frontier: false,
      satisfiesGate: false,
      hint: expect.stringContaining('modelo de ponta'),
    });
  });

  it('árvore suja aparece na resposta e no hint', async () => {
    vi.mocked(getAgentSessionInfo).mockReturnValue({
      model: 'claude-opus-5-6',
    } as never);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty');
    const result = await reviewTool().handler(
      { verdict: 'approve', summary: 'Ainda sujo.' },
      ctxFor('orchestrator'),
    );
    expect(result).toMatchObject({
      treeDirty: true,
      satisfiesGate: false,
      hint: expect.stringContaining('árvore suja'),
    });
  });

  it('exige pane de missão', async () => {
    const ctx = ctxFor('orchestrator');
    await expect(
      reviewTool().handler({ verdict: 'approve', summary: 'x' }, { ...ctx, missionId: undefined }),
    ).rejects.toThrow(/mission pane/i);
  });
});

/**
 * F-1423: o pane mora no checkout principal, mas a revisão foi da worktree
 * ligada. Sem alvo explícito o veredito continua no HEAD do pane; com
 * worktree, branch ou headSha ele amarra o commit revisado. headSha que o
 * repositório não tem é recusado e nada é gravado.
 */
describe('F-1423: veredito amarra o alvo revisado, não o cwd do pane', () => {
  function addWorktree(name: string): { wt: string; sha: string; branch: string } {
    const branch = `integ/${name}`;
    const wt = path.join(repo, '.harvest', name);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git('branch', branch);
    git('worktree', 'add', '-q', wt, branch);
    fs.writeFileSync(path.join(wt, 'note.txt'), name);
    execFileSync('git', ['-C', wt, 'add', 'note.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', wt, 'commit', '-qm', name], { stdio: 'ignore' });
    const sha = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return { wt, sha, branch };
  }

  function frontier(): void {
    vi.mocked(getAgentSessionInfo).mockReturnValue({ model: 'claude-fable-5-1' } as never);
  }

  it('sem alvo continua no HEAD do pane, mesmo com worktree irmã', async () => {
    frontier();
    const { sha } = addWorktree('s241-integ');
    const result = await reviewTool().handler(
      { verdict: 'approve', summary: 'Olhei o checkout do pane.' },
      ctxFor('orchestrator'),
    );
    expect(result).toMatchObject({ headSha: git('rev-parse', 'HEAD'), satisfiesGate: true });
    expect(sha).not.toBe(git('rev-parse', 'HEAD'));
    expect(suite.missions.reviewVerdicts.latestFor(missionId, sha)).toBeNull();
  });

  it('worktree, branch e headSha amarram o commit da worktree revisada', async () => {
    frontier();
    const { wt, sha, branch } = addWorktree('s241-integ');
    const paneHead = git('rev-parse', 'HEAD');
    for (const args of [
      { worktree: wt },
      { worktree: path.relative(repo, wt) },
      { branch },
      { headSha: sha },
      { headSha: sha.slice(0, 12) },
      { worktree: wt, branch, headSha: sha },
    ]) {
      const result = await reviewTool().handler(
        { verdict: 'approve', summary: 'Revisão da worktree de integração.', ...args },
        ctxFor('orchestrator'),
      );
      expect(result, JSON.stringify(args)).toMatchObject({
        recorded: true,
        headSha: sha,
        treeDirty: false,
        satisfiesGate: true,
      });
      expect(result).not.toMatchObject({ headSha: paneHead });
    }
    expect(suite.missions.reviewVerdicts.latestFor(missionId, sha)).toMatchObject({
      verdict: 'approve',
      frontier: true,
    });
    expect(suite.missions.reviewVerdicts.latestFor(missionId, paneHead)).toBeNull();
  });

  it('headSha ausente no repositório é recusado e não grava veredito', async () => {
    frontier();
    const missing = 'deadbeef'.repeat(5);
    await expect(
      reviewTool().handler(
        { verdict: 'approve', summary: 'SHA inventado.', headSha: missing },
        ctxFor('orchestrator'),
      ),
    ).rejects.toThrow(/não existe neste repositório/u);
    expect(suite.missions.reviewVerdicts.latestFor(missionId, git('rev-parse', 'HEAD'))).toBeNull();
    expect(suite.missions.reviewVerdicts.latestFor(missionId, missing)).toBeNull();
  });

  it('worktree e headSha que não fecham são recusados', async () => {
    frontier();
    const { wt } = addWorktree('s241-integ');
    await expect(
      reviewTool().handler(
        {
          verdict: 'approve',
          summary: 'Alvos divergentes.',
          worktree: wt,
          headSha: git('rev-parse', 'HEAD'),
        },
        ctxFor('orchestrator'),
      ),
    ).rejects.toThrow(/não fecha/u);
    expect(suite.missions.reviewVerdicts.latestFor(missionId, git('rev-parse', 'HEAD'))).toBeNull();
  });

  it('worktree suja fica treeDirty no commit dela, não no do pane', async () => {
    frontier();
    const { wt, sha } = addWorktree('s241-integ');
    fs.writeFileSync(path.join(wt, 'note.txt'), 'sujo');
    const result = await reviewTool().handler(
      { verdict: 'approve', summary: 'Ainda suja.', worktree: wt },
      ctxFor('orchestrator'),
    );
    expect(result).toMatchObject({
      headSha: sha,
      treeDirty: true,
      satisfiesGate: false,
      hint: expect.stringContaining('árvore suja'),
    });
  });

  it('worktree de outro repositório é recusada', async () => {
    frontier();
    const other = path.join(dir, 'outro');
    fs.mkdirSync(other);
    execFileSync('git', ['-C', other, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', other, 'config', 'user.name', 'Nexus Fixture'], { stdio: 'ignore' });
    execFileSync('git', ['-C', other, 'config', 'user.email', 'fixture@example.invalid'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(other, 'a.txt'), 'a');
    execFileSync('git', ['-C', other, 'add', 'a.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', other, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    await expect(
      reviewTool().handler(
        { verdict: 'approve', summary: 'Repo alheio.', worktree: other },
        ctxFor('orchestrator'),
      ),
    ).rejects.toThrow(/não é deste repositório/u);
  });
});
