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
  parents: {} as Record<string, string>,
}));
vi.mock('./tool-util', async (original) => ({
  ...(await original<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.panes,
  takePendingPaneSpawnResult: h.pending,
  getPaneRuntimeAuthorityBySession: (sessionId: string) =>
    h.parents[sessionId] ? { operatorParentSessionId: h.parents[sessionId] } : null,
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
import { OPERATOR_HAND_WORKTREE_KEY } from './isolated-writer-worktree';

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
  h.parents = {};
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
      missionId: options.missionId, scope: options.scope, executionScope: options.executionScope ?? options.scope,
      readOnly: options.readOnly });
    const parent = (options as { operatorParentSessionId?: string }).operatorParentSessionId;
    if (parent) h.parents[sessionId] = parent;
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
  it('uses the target mission root even when its caller is currently in another tab worktree', async () => {
    ctx.executionScope = { ...ctx.scope, rootRealPath: path.join(temp, 'another-tab') };
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ cwd: ctx.scope.rootRealPath, executionScope: ctx.scope });
  });

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
      expect(options.prompt).toContain('nexus_handoff_submit');
    }
    expect(fs.readFileSync(path.join(ctx.scope.rootRealPath, 'base.txt'), 'utf8')).toBe('operator WIP\n');
  });

  it('auto-isola o segundo writer comum da missão em vez de recusar (paridade com a mão do operador)', async () => {
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(0);
    const receipt = await paneSpawnTool.handler({ agentName: 'Executor' }, ctx) as Record<string, any>;
    expect(h.spawn.mock.calls[0][0].cwd).toBe(ctx.scope.rootRealPath);
    const [record] = registry.listMission(ctx.scope, ctx.missionId!);
    expect(h.spawn.mock.calls[1][0]).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true });
    expect(receipt.isolatedWorktree.reason).toMatch(/auto-isolado: same-checkout delegation is serialized; worker pane-0/);
  });

  it('writer comum em aba de pasta compartilhada continua serializado', async () => {
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    await expect(paneSpawnTool.handler({ agentName: 'Executor' }, { ...ctx, sharedTabWorktree: true }))
      .rejects.toThrow('same-checkout delegation is serialized');
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

describe('mão do operador sem missão: writers paralelos isolados', () => {
  let op: AgentGateContext;
  beforeEach(() => {
    op = { ...ctx, token: 'op', label: 'operador', role: 'user', sessionId: 'op-session', missionId: undefined };
  });
  const records = () => registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY);

  it('dois writers com isolatedWriter coexistem, cada um na sua worktree/branch', async () => {
    const receipts = await Promise.all([1, 2].map(() =>
      paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true, prompt: 'edite X' }, op))) as Array<Record<string, any>>;
    expect(records()).toHaveLength(2);
    for (const [options] of h.spawn.mock.calls as [SpawnToolOptions][]) {
      expect(options).toMatchObject({ executionMode: 'isolated_worktree', isolatedWriter: true });
      expect(options.cwd).not.toBe(op.scope.rootRealPath);
      expect(options.executionScope?.rootRealPath).toBe(options.cwd);
      expect(options.prompt).toContain('isolated_worktree');
    }
    for (const receipt of receipts) {
      expect(receipt.executionMode).toBe('isolated_worktree');
      expect(git(op.scope.rootRealPath, 'rev-parse', '--verify', receipt.isolatedWorktree.branch)).toMatch(/^[a-f0-9]{40}$/);
      expect(records().map((r) => r.worktreePath)).toContain(receipt.isolatedWorktree.worktreePath);
    }
    // Um terceiro writer comum também passa: os isolados não ocupam o checkout.
    await paneSpawnTool.handler({ adapterId: 'codex', prompt: 'edite Y' }, op);
    expect(h.spawn.mock.calls[2][0].cwd).toBeUndefined();
    expect(records()).toHaveLength(2);
  });

  it('writer comum com outro ativo no checkout é auto-isolado e o recibo diz o motivo', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', prompt: 'edite X' }, op);
    expect(records()).toHaveLength(0);
    const receipt = await paneSpawnTool.handler({ adapterId: 'codex', prompt: 'edite Y' }, op) as Record<string, any>;
    expect(receipt.executionMode).toBe('isolated_worktree');
    expect(receipt.isolatedWorktree.reason).toMatch(/auto-isolado: writer pane-0 ainda ativo/);
    expect(records()).toHaveLength(1);
    expect(h.spawn.mock.calls[1][0].cwd).toBe(records()[0].worktreePath);
  });

  it('readOnly segue no checkout, sem worktree, mesmo com writer ativo', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', prompt: 'edite X' }, op);
    const receipt = await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true, readOnly: true }, op) as Record<string, any>;
    expect(receipt.executionMode).toBeUndefined();
    expect(h.spawn.mock.calls[1][0]).toMatchObject({ readOnly: true });
    expect(h.spawn.mock.calls[1][0].isolatedWriter).toBeUndefined();
    expect(records()).toHaveLength(0);
  });

  it('retém worktree e branch para integração quando o pane fecha', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    const [record] = records();
    for (const tap of [...h.exits]) tap(h.panes[0].sessionId!, {
      sessionId: h.panes[0].sessionId!, adapterId: 'codex', cwd: record.worktreePath,
      scope: h.panes[0].executionScope!, source: 'pending', role: 'user',
      readOnly: false, allowedTools: [], allowedSkills: null,
    });
    expect(records()[0].status).toBe('failed');
    expect(fs.existsSync(record.worktreePath)).toBe(true);
    expect(git(op.scope.rootRealPath, 'rev-parse', '--verify', record.branchRef)).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe('revisão cruzada 0.76.110: corrida, retomada, WIP e GC', () => {
  let op: AgentGateContext;
  beforeEach(() => {
    op = { ...ctx, token: 'op', label: 'operador', role: 'user', sessionId: 'op-session', missionId: undefined };
  });
  const opRecords = () => registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY);
  // Spawn real é assíncrono: o pane só aparece nos snapshots depois de awaits.
  const slowSpawn = () => {
    const fast = h.spawn.getMockImplementation()!;
    h.spawn.mockImplementation(async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fast(...args);
    });
  };
  const closePane = (pane: PaneSnapshot) => {
    pane.state = 'exited';
    for (const tap of [...h.exits]) tap(pane.sessionId!, {
      sessionId: pane.sessionId!, adapterId: 'codex', cwd: pane.executionScope!.rootRealPath,
      scope: pane.executionScope!, source: 'pending', role: 'user',
      readOnly: false, allowedTools: [], allowedSkills: null,
    });
  };

  it('dois spawns comuns concorrentes da mão do operador: um no checkout, o outro auto-isolado', async () => {
    slowSpawn();
    const receipts = await Promise.all([1, 2].map(() =>
      paneSpawnTool.handler({ adapterId: 'codex', prompt: 'edite' }, op))) as Array<Record<string, any>>;
    expect(receipts.filter((r) => r.executionMode === 'isolated_worktree')).toHaveLength(1);
    expect(receipts.find((r) => r.isolatedWorktree)?.isolatedWorktree.reason).toMatch(/writer em spawn/);
    expect(opRecords()).toHaveLength(1);
    const cwds = (h.spawn.mock.calls as [SpawnToolOptions][]).map(([o]) => o.cwd);
    expect(cwds).toContain(opRecords()[0].worktreePath);
    expect(cwds).toContain(undefined);
  });

  it('dois writers comuns concorrentes na missão: um no checkout, o outro auto-isolado', async () => {
    slowSpawn();
    await Promise.all([1, 2].map(() => paneSpawnTool.handler({ agentName: 'Executor' }, ctx)));
    const [record] = registry.listMission(ctx.scope, ctx.missionId!);
    expect(record).toBeDefined();
    expect((h.spawn.mock.calls as [SpawnToolOptions][]).map(([o]) => o.cwd).sort())
      .toEqual([ctx.scope.rootRealPath, record.worktreePath].sort());
  });

  it('spawn que falha solta o claim do checkout', async () => {
    h.spawn.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(paneSpawnTool.handler({ adapterId: 'codex' }, op)).rejects.toThrow('spawn failed');
    await paneSpawnTool.handler({ adapterId: 'codex' }, op);
    expect(h.spawn.mock.calls[1][0].cwd).toBeUndefined();
    expect(opRecords()).toHaveLength(0);
  });

  it('resume de writer isolado volta à worktree/branch original, com commits e WIP', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    const [record] = opRecords();
    fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'writer\n');
    git(record.worktreePath, 'commit', '-qam', 'writer output');
    fs.writeFileSync(path.join(record.worktreePath, 'wip.txt'), 'wip');
    closePane(h.panes[0]);
    expect(opRecords()[0].status).toBe('failed');
    for (const extra of [{}, { isolatedWriter: true }]) {
      const receipt = await paneSpawnTool.handler({ adapterId: 'codex', resume: h.panes.at(-1)!.paneId, ...extra }, op) as Record<string, any>;
      const options = h.spawn.mock.calls.at(-1)![0] as SpawnToolOptions;
      expect(options).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true });
      expect(options.executionScope?.rootRealPath).toBe(record.worktreePath);
      expect(receipt.isolatedWorktree.branch).toBe(record.branchRef.slice('refs/heads/'.length));
      expect(opRecords()).toHaveLength(1);
      expect(opRecords()[0].status).toBe('ready');
      closePane(h.panes.at(-1)!);
    }
    expect(fs.readFileSync(path.join(record.worktreePath, 'wip.txt'), 'utf8')).toBe('wip');
  });

  it('resume de writer isolado cuja worktree sumiu dá erro claro e não cai no checkout', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    const [record] = opRecords();
    fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'writer\n');
    git(record.worktreePath, 'commit', '-qam', 'writer output');
    closePane(h.panes[0]);
    git(op.scope.rootRealPath, 'worktree', 'remove', '--force', record.worktreePath);
    await expect(paneSpawnTool.handler({ adapterId: 'codex', resume: 'pane-0' }, op))
      .rejects.toThrow(/worktree original do writer isolado pane-0 .*não está disponível/);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(opRecords()).toHaveLength(1);
  });

  it('resume de writer isolado da missão reusa a worktree original', async () => {
    await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx);
    const [record] = registry.listMission(ctx.scope, ctx.missionId!);
    h.panes[0].state = 'exited';
    exitPane(h.panes[0]);
    await paneSpawnTool.handler({ agentName: 'Executor', resume: 'pane-0' }, ctx);
    expect(h.spawn.mock.calls[1][0]).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true });
    expect(registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(1);
  });

  it('recibo e contrato dizem o SHA base e que o WIP do checkout não está na worktree', async () => {
    fs.writeFileSync(path.join(op.scope.rootRealPath, 'base.txt'), 'operator WIP\n');
    await paneSpawnTool.handler({ adapterId: 'codex', prompt: 'edite X' }, op);
    const receipt = await paneSpawnTool.handler({ adapterId: 'codex', prompt: 'edite Y' }, op) as Record<string, any>;
    const [record] = opRecords();
    expect(receipt.isolatedWorktree).toMatchObject({
      baseSha: record.baseSha, note: 'não contém alterações não commitadas do checkout principal',
    });
    const prompt = h.spawn.mock.calls[1][0].prompt as string;
    expect(prompt).toContain(record.baseSha);
    expect(prompt).toContain('não contém alterações não commitadas do checkout principal');
  });

  it('GC ao alocar: apaga só worktree operator-hand já mesclada e limpa; preserva trabalho não integrado', async () => {
    await Promise.all([1, 2, 3].map(() => paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op)));
    const byPane = h.panes.map((pane) => opRecords().find((r) => r.worktreePath === pane.executionScope!.rootRealPath)!);
    const [merged, unmerged, dirty] = byPane;
    for (const [record, file] of [[merged, 'a.txt'], [unmerged, 'b.txt'], [dirty, 'c.txt']] as const) {
      fs.writeFileSync(path.join(record.worktreePath, file), file);
      git(record.worktreePath, 'add', file);
      git(record.worktreePath, 'commit', '-qm', file);
    }
    git(op.scope.rootRealPath, 'merge', '-q', '--no-edit', merged.branchRef.slice('refs/heads/'.length));
    git(op.scope.rootRealPath, 'merge', '-q', '--no-edit', dirty.branchRef.slice('refs/heads/'.length));
    fs.writeFileSync(path.join(dirty.worktreePath, 'scratch.txt'), 'só existe aqui');
    for (const pane of [...h.panes]) closePane(pane);
    h.panes = [];
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    const kept = opRecords().map((r) => r.taskId);
    expect(kept).not.toContain(merged.taskId);
    expect(fs.existsSync(merged.worktreePath)).toBe(false);
    expect(() => git(op.scope.rootRealPath, 'rev-parse', '--verify', '--quiet', merged.branchRef)).toThrow();
    expect(kept).toEqual(expect.arrayContaining([unmerged.taskId, dirty.taskId]));
    expect(fs.existsSync(unmerged.worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(dirty.worktreePath, 'scratch.txt'), 'utf8')).toBe('só existe aqui');
    expect(opRecords()).toHaveLength(3);
  });
});
