import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneSnapshot } from '../../shared/orch-types';
import type { AgentGateContext } from './gate';
import type { SpawnToolOptions } from './tool-util';
import type { SessionExitTap } from '../pty/pty-manager';
import { compileIntentContract } from '../../shared/mission-intent';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  panes: [] as PaneSnapshot[],
  exits: new Set<SessionExitTap>(),
  spawn: vi.fn(),
  pending: vi.fn(),
  mission: {} as Record<string, unknown>,
}));
vi.mock('./tool-util', async (original) => ({
  ...(await original<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.panes,
  takePendingPaneSpawnResult: h.pending,
}));
vi.mock('../pty/pty-manager', async (original) => ({
  ...(await original<typeof import('../pty/pty-manager')>()),
  tapSessionExit: (tap: SessionExitTap) => { h.exits.add(tap); return () => h.exits.delete(tap); },
}));
vi.mock('./gate', async (original) => ({
  ...(await original<typeof import('./gate')>()),
  assertCurrentMissionOrchestratorSession: vi.fn(),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: { get: () => h.mission },
    missionPanes: { list: () => h.panes.map((p) => ({ ...p, role: 'worker' })) },
  }),
}));
vi.mock('./task-dispatch-authority', () => ({ isTaskQueueManagedMission: () => false }));
vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({ getMissionWorkflow: () => ({ contract: null }) }),
}));
vi.mock('./squad-store', () => ({
  findAgentInAnySquad: () => null,
  findAgentInSquad: () => ({ agent: { agentName: 'Executor', category: 'executor', cli: 'codex', model: 'gpt-5.4' } }),
  getSquad: () => null,
}));

import { paneSpawnTool } from './tools-panes';

let temp: string;
let manager: ProjectRuntimeManager;
let registry: ReturnType<typeof configureWorktreeRuntimeRegistry>;
let ctx: AgentGateContext;
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
function exitPane(pane: PaneSnapshot) {
  for (const tap of [...h.exits]) tap(pane.sessionId!, {
    sessionId: pane.sessionId!, adapterId: 'codex', cwd: pane.executionScope!.rootRealPath,
    scope: pane.executionScope!, source: 'pending', role: 'worker', missionId: ctx.missionId,
    readOnly: false, allowedTools: [], allowedSkills: null,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.pending.mockReturnValue(null);
  h.panes = [];
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pane-writer-')));
  const root = path.join(temp, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  fs.writeFileSync(path.join(root, 'base.txt'), 'committed\n');
  git(root, 'add', 'base.txt');
  git(root, 'commit', '-qm', 'base');
  ctx = {
    token: 'orch', label: 'Maestro', role: 'orchestrator', sessionId: 'orch-session',
    missionId: 'mission-a', scope: testProjectScope({ rootRealPath: root }),
    allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
  };
  h.mission = { id: ctx.missionId, title: 'Implement feature', description: '', status: 'running', squadId: 'squad',
    intentContract: { ...compileIntentContract({ goal: 'Implement feature', intentVersion: 1 }), maxWorkers: 8 } };
  manager = new ProjectRuntimeManager({ baseDir: path.join(temp, 'runtime'), appVersion: 'test' });
  registry = configureWorktreeRuntimeRegistry(manager);
  manager.open(ctx.scope).db.prepare("INSERT INTO missions (id, title, status, created_at, updated_at) VALUES (?, 'Feature', 'running', 1, 1)").run(ctx.missionId);
  h.spawn.mockImplementation(async (options: SpawnToolOptions, hooks: { onPaneCreated?: (pane: string, session: string) => void }) => {
    const paneId = `pane-${h.panes.length}`;
    const sessionId = `session-${paneId}`;
    h.panes.push({ paneId, sessionId, kind: 'cli-agent', title: 'worker', state: 'busy', role: 'worker',
      missionId: options.missionId, executionScope: options.executionScope, readOnly: options.readOnly });
    hooks.onPaneCreated?.(paneId, sessionId);
    return { paneId, sessionId };
  });
});
afterEach(() => {
  for (const pane of h.panes) exitPane(pane);
  disposeWorktreeRuntimeRegistry();
  manager.closeAll();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('Via Rápida isolated writers', () => {
  it('fans out concurrently with distinct registered worktrees/branches at HEAD, preserving WIP', async () => {
    fs.writeFileSync(path.join(ctx.scope.rootRealPath, 'base.txt'), 'operator WIP\n');
    await Promise.all([1, 2].map(() => paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true, prompt: 'Implement feature' }, ctx)));
    const records = registry.listMission(ctx.scope, ctx.missionId!);
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.worktreePath)).size).toBe(2);
    expect(new Set(records.map((r) => r.branchRef)).size).toBe(2);
    for (const [options] of h.spawn.mock.calls as [SpawnToolOptions][]) {
      const record = records.find((r) => r.worktreePath === options.cwd)!;
      expect(record.status).toBe('ready');
      expect(record.ownerKind).toBe('pane');
      expect(options).toMatchObject({ executionMode: 'isolated_worktree', isolatedWriter: true, scope: ctx.scope });
      expect(options.executionScope?.rootRealPath).toBe(record.worktreePath);
      expect(record.worktreePath).not.toBe(ctx.scope.rootRealPath);
      expect(record.branchRef).toMatch(/^refs\/heads\/nexus\/[a-f0-9]{16}\/[a-f0-9]{24}$/);
      expect(git(record.worktreePath, 'symbolic-ref', 'HEAD')).toBe(record.branchRef);
      expect(git(record.worktreePath, 'rev-parse', 'HEAD')).toBe(record.baseSha);
      expect(fs.readFileSync(path.join(record.worktreePath, 'base.txt'), 'utf8')).toBe('committed\n');
      expect(options.prompt).toContain(record.worktreePath);
      expect(options.prompt).toContain(record.branchRef.slice('refs/heads/'.length));
      expect(options.prompt).toContain('branch, sha e arquivos tocados');
    }
    expect(fs.readFileSync(path.join(ctx.scope.rootRealPath, 'base.txt'), 'utf8')).toBe('operator WIP\n');
  });

  it('keeps same_checkout writers serialized without the opt-in', async () => {
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    await expect(paneSpawnTool.handler({ agentName: 'Executor' }, ctx)).rejects.toThrow('same-checkout delegation is serialized');
    expect(h.spawn.mock.calls[0][0].cwd).toBe(ctx.scope.rootRealPath);
    expect(registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(0);
  });

  it.each([false, true])('read-only wins over isolation (inherited=%s)', async (inherited) => {
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    await Promise.all([1, 2].map(() => paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true, readOnly: !inherited }, { ...ctx, readOnly: inherited })));
    expect(h.spawn.mock.calls.slice(1).every(([o]) => o.readOnly && !o.isolatedWriter && o.cwd === ctx.scope.rootRealPath)).toBe(true);
    expect(registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(0);
  });

  it('releases only the closed worker after physical exit, preserving unmerged commits and dirty files', async () => {
    await Promise.all([1, 2].map(() => paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx)));
    const record = registry.listMission(ctx.scope, ctx.missionId!).find((r) => r.worktreePath === h.panes[0].executionScope!.rootRealPath)!;
    fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'worker change\n');
    git(record.worktreePath, 'commit', '-qam', 'worker output');
    const sha = git(record.worktreePath, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(record.worktreePath, 'untracked.txt'), 'keep');
    exitPane(h.panes[0]);
    exitPane(h.panes[0]);
    expect(registry.get(ctx.scope, ctx.missionId!, record.taskId)?.status).toBe('failed');
    expect(registry.listMission(ctx.scope, ctx.missionId!).filter((r) => r.status === 'ready')).toHaveLength(1);
    expect(git(ctx.scope.rootRealPath, 'rev-parse', record.branchRef)).toBe(sha);
    expect(fs.readFileSync(path.join(record.worktreePath, 'untracked.txt'), 'utf8')).toBe('keep');
  });

  it('releases an allocation when spawning fails', async () => {
    h.spawn.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx)).rejects.toThrow('spawn failed');
    expect(registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('failed');
  });

  it('retains the worktree for a pending spawn and releases it on subsequent physical exit', async () => {
    h.spawn.mockImplementationOnce(async (options: SpawnToolOptions) => {
      h.panes.push({ paneId: 'pending-pane', sessionId: 'pending-session', kind: 'cli-agent',
        title: 'pending', state: 'spawning', role: 'worker', missionId: options.missionId,
        executionScope: options.executionScope });
      throw new Error('pane spawn pending');
    });
    h.pending.mockReturnValueOnce({ ok: true, paneId: 'pending-pane', sessionId: null, pending: true });
    expect(await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx))
      .toMatchObject({ pending: true, executionMode: 'isolated_worktree' });
    expect(registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('ready');
    exitPane(h.panes[0]);
    expect(registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('failed');
  });

  it('releases the worktree if invocation authority is revoked during preparation', async () => {
    await expect(paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx, {
      assertCurrentAuthority: () => {
        if (registry.listMission(ctx.scope, ctx.missionId!).length) throw new Error('authority revoked');
      },
    })).rejects.toThrow('authority revoked');
    expect(h.spawn).not.toHaveBeenCalled();
    expect(registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('failed');
  });
});
