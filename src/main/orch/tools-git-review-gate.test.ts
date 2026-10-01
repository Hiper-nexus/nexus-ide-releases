import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './__tests__/scope-fixture';
import type { AgentGateContext } from './gate';
import { buildGitTools } from './tools-git';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from './project-domain-store-registry';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { ScopedMissionStore } from './mission-store';

let dir = '';
let repo = '';
let runtime: ProjectRuntimeManager;
let store: ScopedMissionStore;
let missionId = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function context(extra: Partial<AgentGateContext> = {}): AgentGateContext {
  const scope = testProjectScope({ rootRealPath: repo });
  return {
    token: 'token-git-push',
    label: 'claude',
    role: 'orchestrator',
    sessionId: 'session-git-push',
    providerId: 'claude',
    missionId,
    scope,
    executionScope: scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...extra,
  };
}

function pushTool() {
  const found = buildGitTools().find((candidate) => candidate.name === 'nexus_git_push');
  if (!found) throw new Error('missing nexus_git_push');
  return found;
}

function recordApprove(headSha: string) {
  store.reviewVerdicts.record({
    missionId,
    headSha,
    treeDirty: false,
    verdict: 'approve',
    reviewerAdapter: 'claude',
    reviewerModel: 'claude-fable-5-1',
    frontier: true,
    summary: 'Aprovado.',
  });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-gate-')));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.name', 'Nexus Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  // Remoto local inalcançável: o portão decide antes da rede; um push que
  // passa pelo portão falha rápido no transporte, sem depender de SSH/GitHub.
  git('remote', 'add', 'origin', 'https://127.0.0.1:9/nexus/test.git');
  runtime = new ProjectRuntimeManager({
    baseDir: path.join(dir, 'runtime'),
    appVersion: 'git-gate-test',
  });
  configureProjectDomainStoreRegistry(runtime);
  store = getProjectDomainStores(testProjectScope({ rootRealPath: repo })).missions;
  missionId = store.create({ title: 'Missão do push' }).id;
});

afterEach(() => {
  disposeProjectDomainStoreRegistry();
  runtime.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('nexus_git_push — portão de veredito de ponta (F-234)', () => {
  it('bloqueia push de missão sem veredito', async () => {
    await expect(
      pushTool().handler({ remote: 'origin', confirmed: true }, context()),
    ).rejects.toThrow(/review_required/);
  });

  it('com approve de ponta do HEAD exato o portão libera (falha vira transporte)', async () => {
    recordApprove(git('rev-parse', 'HEAD'));
    // O portão libera: a falha agora é de transporte (host local inalcançável),
    // nunca `review_required`.
    await expect(
      pushTool().handler({ remote: 'origin', confirmed: true }, context()),
    ).rejects.toThrow(/Git command failed/);
    await expect(
      pushTool().handler({ remote: 'origin', confirmed: true }, context()),
    ).rejects.not.toThrow(/review_required/);
  });

  it('HEAD que andou depois do veredito volta a bloquear', async () => {
    recordApprove(git('rev-parse', 'HEAD'));
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
    git('add', 'b.txt');
    git('commit', '-qm', 'second');
    await expect(
      pushTool().handler({ remote: 'origin', confirmed: true }, context()),
    ).rejects.toThrow(/review_required/);
  });

  it('pane sem missão não tem portão', async () => {
    const ctx = context();
    delete ctx.missionId;
    await expect(
      pushTool().handler({ remote: 'origin', confirmed: true }, ctx),
    ).rejects.not.toThrow(/review_required/);
  });
});
