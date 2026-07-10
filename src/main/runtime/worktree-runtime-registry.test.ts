import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProjectRuntimeManager } from './project-runtime-manager';
import { WorktreeRuntimeRegistry } from './worktree-runtime-registry';

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-git-')));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-registry-runtime-')));
  roots.push(root, runtime);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  fs.writeFileSync(path.join(root, 'owned.txt'), 'base\n');
  git(root, 'add', 'owned.txt');
  git(root, 'commit', '-qm', 'base');
  const scope: ProjectExecutionScope = {
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId: 'checkout-a',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  const manager = new ProjectRuntimeManager({ baseDir: runtime, appVersion: 'test' });
  managers.push(manager);
  return { root, scope, manager };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('project worktree runtime registry', () => {
  it('persists, validates, merges and resolves an exact integrated mission', async () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const baseSha = git(root, 'rev-parse', 'HEAD');
    const record = registry.create({
      scope,
      missionId: 'mission-a',
      taskId: 'task-a',
      workerId: 'worker-a',
      ownership: { files: ['owned.txt'], symbols: [], domains: ['core'] },
    });
    fs.writeFileSync(path.join(record.worktreePath, 'owned.txt'), 'changed\n');
    git(record.worktreePath, 'add', 'owned.txt');
    git(record.worktreePath, 'commit', '-qm', 'task');

    const merged = await registry.enqueue({
      scope,
      missionId: 'mission-a',
      taskId: 'task-a',
      validate: () => ({
        sensorsPassed: true,
        reviewPassed: true,
        evidenceIds: ['evidence-a'],
      }),
    });
    expect(merged.integratedSha).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(registry.resolveIntegratedMission(scope, 'mission-a', baseSha)).toMatchObject({
      baseSha,
      headSha: merged.integratedSha,
    });

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    expect(reopened.get(scope, 'mission-a', 'task-a')?.status).toBe('integrated');
    expect(reopened.forScope(scope).queue.snapshot(scope).events.map(
      (event) => event.type,
    )).toEqual(['integrated']);
    expect(reopened.resolveIntegratedMission(scope, 'mission-a', baseSha)?.diffHash)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it('automatically reconciles an interrupted active merge after reopening', () => {
    const { root, scope, manager } = fixture();
    const registry = new WorktreeRuntimeRegistry(manager);
    const record = registry.create({
      scope,
      missionId: 'mission-restart',
      taskId: 'task-restart',
      workerId: 'worker-restart',
      ownership: { files: ['owned.txt'], symbols: [], domains: ['core'] },
    });
    fs.writeFileSync(path.join(record.worktreePath, 'owned.txt'), 'restart\n');
    git(record.worktreePath, 'add', 'owned.txt');
    git(record.worktreePath, 'commit', '-qm', 'restart task');
    const runtime = registry.forScope(scope);
    const prepared = runtime.worktrees.prepareIntegration(
      scope,
      record.missionId,
      record.taskId,
    );
    runtime.worktrees.markQueued(
      scope,
      record.missionId,
      record.taskId,
      prepared.taskHeadSha,
    );
    const key = runtime.worktrees.scopeKey(scope);
    expect(runtime.mergeState.compareAndSwap(key, 0, {
      activeTaskKey: record.taskKey,
      blocked: null,
      events: [],
      entries: [{
        id: `merge-${record.taskKey}`,
        taskKey: record.taskKey,
        missionId: record.missionId,
        taskId: record.taskId,
        attempt: 1,
        status: 'candidate-validating',
        taskHeadSha: prepared.taskHeadSha,
        integrationBaseSha: git(root, 'rev-parse', 'HEAD'),
        diffHash: prepared.diffHash,
        evidenceIds: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    })).toBe(true);

    manager.close(scope);
    const reopened = new WorktreeRuntimeRegistry(manager);
    const recovered = reopened.forScope(scope);

    expect(recovered.mergeState.read(key)).toMatchObject({
      activeTaskKey: null,
      blocked: { taskKey: record.taskKey },
    });
    expect(recovered.mergeState.read(key).events.at(-1)?.type).toBe(
      'restart-reconciled',
    );
    expect(recovered.worktrees.get(
      scope,
      record.missionId,
      record.taskId,
    )?.status).toBe('failed');
  });
});
