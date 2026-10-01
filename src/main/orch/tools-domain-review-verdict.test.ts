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
