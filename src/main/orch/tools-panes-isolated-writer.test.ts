import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { resetLicensedAccessMock } from '../__tests__/licensed-access';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import type { PaneSnapshot } from '../../shared/orch-types';
import type { AgentGateContext } from './gate';
import type { PendingMissionPaneRecord, SpawnToolOptions } from './tool-util';
import type { WebContents } from 'electron';
import {
  abandonPendingOrchSpawn,
  claimPendingSpawnMeta,
  registerOrchRenderer,
  reportPendingSpawnStartFailure,
  requestPaneSpawn,
  resolvePaneSpawn,
  unregisterOrchRenderer,
  PENDING_SPAWN_RESULT,
} from './pane-registry';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
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
  handoffs: {} as Record<string, { sessionId?: string }>,
  resumeRecords: new Map<string, Record<string, unknown>>(),
  // F-1388: panes cuja CLI nunca gravou conversa retomável (kimi/devin/agy/…).
  providerlessPanes: new Set<string>(),
  pendingPanes: new Set<string>(),
  // F-1259: panes cuja gravação em missionPanes falhou (sem linha durável).
  unrecorded: new Set<string>(),
}));
vi.mock('./tool-util', async (original) => ({
  ...(await original<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: h.spawn,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.panes,
  takePendingPaneSpawnResult: h.pending,
  isPaneSpawnPending: (paneId: string) => h.pendingPanes.has(paneId),
  getPaneRuntimeAuthorityBySession: (sessionId: string) =>
    h.parents[sessionId] ? { operatorParentSessionId: h.parents[sessionId] } : null,
}));
vi.mock('../pty/pty-manager', async (original) => ({
  ...(await original<typeof import('../pty/pty-manager')>()),
  tapSessionExit: (tap: SessionExitTap) => { h.exits.add(tap); return () => h.exits.delete(tap); },
}));
// F-908: o app configura as portas do sweep de PTY no boot; aqui não há
// sessão PTY real e o padrão sem portas (fail-closed) seria "em uso" sempre.
// Sessão viva = pane não encerrado com o cwd dentro da worktree.
vi.mock('../runtime/worktree-pty-sweep', async (original) => ({
  ...(await original<typeof import('../runtime/worktree-pty-sweep')>()),
  worktreeHasLiveSession: (worktreePath: string) => h.panes.some((pane) =>
    pane.state !== 'exited' && pane.executionScope?.rootRealPath === worktreePath),
}));
vi.mock('./gate', async (original) => ({
  ...(await original<typeof import('./gate')>()),
  assertCurrentMissionOrchestratorSession: vi.fn(),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: { get: () => h.mission },
    handoffs: { get: (id: string) => h.handoffs[id] ?? null },
    missionPanes: { list: () => h.panes.filter((p) => !h.unrecorded.has(p.paneId)).map((p) => ({ ...p, role: 'worker' })), findByPaneId: (id: string) => h.resumeRecords.get(id) ?? null },
  }),
}));
vi.mock('../persistence/provider-session-store', async original => ({
  ...(await original<typeof import('../persistence/provider-session-store')>()),
  getProviderPaneSession: (_scope: unknown, id: string) =>
    h.resumeRecords.has(id) && !h.providerlessPanes.has(id)
      ? { key: 'session_id', id: `conversation-${id}` }
      : null,
}));
vi.mock('./task-dispatch-authority', () => ({ isTaskQueueManagedMission: () => false }));
const traceHarness = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../observability/main-trace', () => ({
  trace: (event: Record<string, unknown>) => {
    traceHarness.events.push(event);
  },
}));
vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: () => ({ getMissionWorkflow: () => ({ contract: null }) }),
}));
vi.mock('./squad-store', () => ({
  findAgentInAnySquad: () => null,
  findAgentInSquad: () => ({ agent: { agentName: 'Executor', category: 'executor', cli: 'codex', model: 'gpt-5.4' } }),
  getSquad: () => null,
}));

import { ISOLATED_TAB_WORKTREE_NOTE, paneSpawnTool } from './tools-panes';
import { OPERATOR_HAND_WORKTREE_KEY, operatorHandGcIdle } from './isolated-writer-worktree';
import { newMissionWorkspaceBinding, prepareMissionExecutionScope } from './mission-execution-scope';
import { resetWriterClaimsForTests } from './delegated-writer-gate';
import { worktreeSalvageIdle } from './isolated-writer-salvage';

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
  resetLicensedAccessMock();
  traceHarness.events.length = 0;
  h.pending.mockReturnValue(null);
  h.panes = [];
  h.parents = {};
  h.handoffs = {};
  h.resumeRecords.clear();
  h.providerlessPanes.clear();
  h.pendingPanes.clear();
  h.unrecorded.clear();
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
    h.resumeRecords.set(paneId, { id: `composition-${paneId}`, paneId, missionId: options.missionId,
      adapterId: options.adapterId, model: options.model, accountId: options.accountId, effort: options.effort,
      cwd: options.cwd, scope: options.scope, executionScope: options.executionScope ?? options.scope,
      readOnly: options.readOnly, allowedTools: options.allowedTools ?? null, allowedSkills: options.allowedSkills ?? null });
    h.panes.push({ paneId, sessionId, kind: 'cli-agent', title: 'worker', state: 'busy', role: 'worker',
      missionId: options.missionId, scope: options.scope, executionScope: options.executionScope ?? options.scope,
      readOnly: options.readOnly });
    const parent = (options as { operatorParentSessionId?: string }).operatorParentSessionId;
    if (parent) h.parents[sessionId] = parent;
    hooks.onPaneCreated?.(paneId, sessionId);
    return { paneId, sessionId };
  });
});
afterEach(async () => {
  for (const pane of h.panes) exitPane(pane);
  await operatorHandGcIdle();
  await worktreeSalvageIdle();
  disposeWorktreeRuntimeRegistry();
  manager.closeAll();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('Via Rápida isolated writers', () => {
  it.each([false, true])('F-764: revoked creation cannot reserve or spawn an isolated writer (operator=%s)', async (operator) => {
    const caller = new AbortController();
    const current = operator
      ? { ...ctx, role: 'user' as const, missionId: undefined, sessionId: 'op-session' }
      : ctx;
    const create = registry.create.bind(registry);
    const spy = vi.spyOn(registry, 'create').mockImplementation(async (input) => {
      await new Promise(resolve => setImmediate(resolve));
      caller.abort(new Error('session_authority_revoked'));
      return create(input);
    });
    try {
      await expect(paneSpawnTool.handler({ adapterId: 'codex', ...(operator ? {} : { agentName: 'Executor' }), isolatedWriter: true }, current,
        { signal: caller.signal })).rejects.toThrow('session_authority_revoked');
      expect(h.spawn).not.toHaveBeenCalled();
      expect(registry.listMission(ctx.scope, operator ? OPERATOR_HAND_WORKTREE_KEY : ctx.missionId!)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the target mission root even when its caller is currently in another tab worktree', async () => {
    ctx.executionScope = { ...ctx.scope, rootRealPath: path.join(temp, 'another-tab') };
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ cwd: ctx.scope.rootRealPath, executionScope: ctx.scope });
  });

  it('emite pane-spawn-timing com gitWorktreeMs e cowMs do materialize (F-215)', async () => {
    await paneSpawnTool.handler(
      { agentName: 'Executor', isolatedWriter: true, prompt: 'Implement feature' },
      ctx,
    );
    const events = traceHarness.events.filter(
      (e) => e.kind === 'pane-spawn-timing',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      gitWorktreeMs: expect.any(Number),
      cowMs: expect.any(Number),
    });
    expect(events[0].phases).toHaveProperty('writer-isolation');
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
      expect(options).toMatchObject({ executionMode: 'isolated_worktree', isolatedWriter: true, scope: ctx.scope, memoryQuery: 'Implement feature' });
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

  describe('F-1320: o writer escolhe a base (baseRef)', () => {
    let oldSha: string;
    beforeEach(() => {
      const root = ctx.scope.rootRealPath;
      oldSha = git(root, 'rev-parse', 'HEAD');
      git(root, 'tag', 'v-old');
      fs.writeFileSync(path.join(root, 'newer.txt'), 'newer\n');
      git(root, 'add', 'newer.txt');
      git(root, 'commit', '-qm', 'newer');
    });

    it.each(['v-old', 'sha'])('a worktree nasce na ref pedida (%s) e o recibo traz o baseSha dela', async (kind) => {
      const baseRef = kind === 'sha' ? oldSha : kind;
      const receipt = await paneSpawnTool.handler(
        { agentName: 'Executor', isolatedWriter: true, prompt: 'Implement feature', baseRef }, ctx,
      ) as Record<string, any>;
      expect(receipt.isolatedWorktree.baseSha).toBe(oldSha);
      const [record] = registry.listMission(ctx.scope, ctx.missionId!);
      expect(record.baseSha).toBe(oldSha);
      expect(git(record.worktreePath, 'rev-parse', 'HEAD')).toBe(oldSha);
      expect(fs.existsSync(path.join(record.worktreePath, 'newer.txt'))).toBe(false);
      expect(git(ctx.scope.rootRealPath, 'rev-parse', 'HEAD')).not.toBe(oldSha);
    });

    it('sem baseRef continua nascendo do HEAD atual', async () => {
      const receipt = await paneSpawnTool.handler(
        { agentName: 'Executor', isolatedWriter: true, prompt: 'Implement feature' }, ctx,
      ) as Record<string, any>;
      expect(receipt.isolatedWorktree.baseSha).toBe(git(ctx.scope.rootRealPath, 'rev-parse', 'HEAD'));
    });

    it.each(['nao-existe', '--output=/tmp/x', 'HEAD^{tree}'])('ref inválida (%s) é erro claro, sem spawn nem worktree', async (baseRef) => {
      await expect(paneSpawnTool.handler(
        { agentName: 'Executor', isolatedWriter: true, prompt: 'Implement feature', baseRef }, ctx,
      )).rejects.toThrow(/baseRef/);
      expect(h.spawn).not.toHaveBeenCalled();
      expect(registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(0);
    });

    it('baseRef sem isolatedWriter é recusado em vez de ignorado', async () => {
      await expect(paneSpawnTool.handler({ agentName: 'Executor', prompt: 'x', baseRef: 'v-old' }, ctx))
        .rejects.toThrow(/baseRef .*isolatedWriter/);
      expect(h.spawn).not.toHaveBeenCalled();
    });
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

  // F-1318: isolatedWriter explícito vence readOnly — o "leitor" que escreve
  // ganha worktree própria (antes: read-only vencia e o pane caía no checkout).
  it.each([false, true])('F-1318: isolatedWriter wins over read-only (inherited=%s)', async (inherited) => {
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    await Promise.all([1, 2].map(() => paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true, readOnly: !inherited }, { ...ctx, readOnly: inherited })));
    const fresh = h.spawn.mock.calls.slice(1).map(([o]) => o) as SpawnToolOptions[];
    expect(fresh).toHaveLength(2);
    for (const options of fresh) {
      expect(options).toMatchObject({ executionMode: 'isolated_worktree', isolatedWriter: true });
      expect(options.cwd).not.toBe(ctx.scope.rootRealPath);
    }
    expect(registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(2);
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

  it('F-794: pane do writer sai com trabalho sem commit e o Nexus guarda um commit de salvaguarda', async () => {
    await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx);
    const [record] = registry.listMission(ctx.scope, ctx.missionId!);
    fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'worker change\n');
    fs.writeFileSync(path.join(record.worktreePath, 'F-999.md'), '# qa\n');
    const head = git(record.worktreePath, 'rev-parse', 'HEAD');
    exitPane(h.panes[0]);
    await worktreeSalvageIdle();
    const refs = git(ctx.scope.rootRealPath, 'for-each-ref', '--format=%(refname)', 'refs/nexus-salvage')
      .split('\n').filter(Boolean);
    expect(refs).toHaveLength(1);
    expect(refs[0].startsWith(`refs/nexus-salvage/${record.branchRef.slice('refs/heads/'.length)}/`)).toBe(true);
    expect(git(ctx.scope.rootRealPath, 'show', `${refs[0]}:base.txt`)).toBe('worker change');
    expect(git(ctx.scope.rootRealPath, 'show', `${refs[0]}:F-999.md`)).toBe('# qa');
    expect(git(ctx.scope.rootRealPath, 'rev-parse', `${refs[0]}^`)).toBe(head);
    // A branch e os arquivos do writer continuam exatamente como ele deixou.
    expect(git(record.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(record.worktreePath, 'status', '--porcelain')).toContain('base.txt');
    expect(traceHarness.events).toContainEqual(expect.objectContaining({
      kind: 'worktree-salvage', outcome: 'saved', reason: 'pane-exit', missionId: ctx.missionId,
      sessionId: h.panes[0].sessionId, fileCount: 2,
    }));
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

  it('F-1258: pending sem sessão + recusa antes do nascimento libera o registro e preserva branch/arquivos', async () => {
    const owner = { id: 1258, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() } as unknown as WebContents;
    bindResolvedRendererWorkspaceScope(owner, ctx.scope);
    registerOrchRenderer(owner);
    try {
      // Grant real do renderer para o writer isolado (isolatedWriter:true no meta;
      // sem missão/role para não exigir selo de autoridade — o caminho de
      // liquidação sem filho é o mesmo).
      const grantPromise = requestPaneSpawn({
        adapterId: 'codex',
        scope: ctx.scope,
        isolatedWriter: true,
        [PENDING_SPAWN_RESULT]: true,
      });
      const request = (owner as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls[0]?.[1] as
        { requestId: string; paneId: string };
      expect(request?.requestId).toMatch(/^orchspawn-/);
      // O renderer reivindica o grant e responde pending sem sessão.
      expect(claimPendingSpawnMeta(request.requestId, owner)).not.toBeNull();
      h.spawn.mockImplementationOnce(async (options: SpawnToolOptions) => {
        h.panes.push({ paneId: request.paneId, sessionId: 'session-never-born', kind: 'cli-agent',
          title: 'worker', state: 'spawning', role: 'worker', missionId: options.missionId,
          scope: options.scope, executionScope: options.executionScope ?? options.scope,
          readOnly: options.readOnly });
        throw new Error('pane spawn pending');
      });
      h.pending.mockReturnValueOnce({ ok: true, paneId: request.paneId, sessionId: null, pending: true });
      await expect(paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx))
        .resolves.toMatchObject({ pending: true });
      const [record] = registry.listMission(ctx.scope, ctx.missionId!);
      expect(record.status).toBe('ready');
      expect(record.worktreePath).not.toBe(ctx.scope.rootRealPath);
      expect(resolvePaneSpawn(
        { requestId: request.requestId, ok: true, paneId: request.paneId, sessionId: null, pending: true },
        owner,
      )).toBe(true);
      await expect(grantPromise).resolves.toMatchObject({ pending: true });
      // O preparo da CLI recusa ANTES de criar sessão: sem filho, sem tap de saída.
      expect(reportPendingSpawnStartFailure(request.requestId, owner, 'cli_missing: provider binary unavailable')).toBe(true);
      // O registro falso ("ready" durável) tem que cair para failed...
      expect(registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('failed');
      // ...sem apagar a branch nem os arquivos do writer para integração manual.
      expect(git(ctx.scope.rootRealPath, 'rev-parse', '--verify', record.branchRef)).toMatch(/^[a-f0-9]{40}$/);
      expect(fs.existsSync(record.worktreePath)).toBe(true);
      expect(fs.readFileSync(path.join(record.worktreePath, 'base.txt'), 'utf8')).toBe('committed\n');
      // E uma nova alocação de writer isolado funciona.
      h.panes[0].state = 'exited';
      await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx);
      expect(registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(2);
    } finally {
      unregisterOrchRenderer(owner);
      clearRendererWorkspaceScope(owner);
    }
  });

  it('F-1259: onPaneCreated + erro em record recusa enquanto o filho vive e aceita após a saída física', async () => {
    // Sem linha durável o filho não conta no teto, mas a vaga retida sim.
    h.mission = { ...h.mission, intentContract: { ...(h.mission as { intentContract: object }).intentContract,
      budgets: { ...((h.mission as { intentContract: { budgets: object } }).intentContract.budgets), maxWorkers: 1 } } };
    h.unrecorded.add('pane-0');
    const first = await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(first).toMatchObject({ paneId: 'pane-0' });
    // O filho vive (sem composição durável): a vaga retida recusa o próximo.
    await expect(paneSpawnTool.handler({ agentName: 'Executor' }, ctx)).rejects.toThrow('budget_exhausted');
    expect(h.spawn).toHaveBeenCalledTimes(1);
    // Prova física de saída sem composição durável libera a vaga.
    h.panes[0].state = 'exited';
    exitPane(h.panes[0]);
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it('F-1259: linha durável que chega tarde + saída física também libera a vaga', async () => {
    h.mission = { ...h.mission, intentContract: { ...(h.mission as { intentContract: object }).intentContract,
      budgets: { ...((h.mission as { intentContract: { budgets: object } }).intentContract.budgets), maxWorkers: 1 } } };
    h.unrecorded.add('pane-0');
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    // A composição durável aparece depois do braço (gravação atrasada).
    h.unrecorded.delete('pane-0');
    h.panes[0].state = 'exited';
    exitPane(h.panes[0]);
    await expect(paneSpawnTool.handler({ agentName: 'Executor' }, ctx)).resolves.toMatchObject({ paneId: expect.any(String) });
  });

  it('F-1259: pending + continuação unrecorded recusa enquanto o filho vive e aceita após a saída física', async () => {
    h.mission = { ...h.mission, intentContract: { ...(h.mission as { intentContract: object }).intentContract,
      budgets: { ...((h.mission as { intentContract: { budgets: object } }).intentContract.budgets), maxWorkers: 1 } } };
    h.unrecorded.add('pane-0');
    h.spawn.mockImplementationOnce(async (
      options: SpawnToolOptions,
      hooks: { onPendingMissionPane?: (recorded: Promise<PendingMissionPaneRecord>) => void },
    ) => {
      // O filho nasce (ACK pendente) mas a linha durável nunca é gravada.
      h.panes.push({ paneId: 'pane-0', sessionId: 'session-pane-0', kind: 'cli-agent',
        title: 'worker', state: 'busy', role: 'worker', missionId: options.missionId,
        scope: options.scope, executionScope: options.executionScope ?? options.scope,
        readOnly: options.readOnly });
      hooks.onPendingMissionPane?.(Promise.resolve('unrecorded'));
      throw new Error('pane spawn pending');
    });
    h.pending.mockReturnValueOnce({ ok: true, paneId: 'pane-0', sessionId: null, pending: true });
    await expect(paneSpawnTool.handler({ agentName: 'Executor' }, ctx))
      .resolves.toMatchObject({ pending: true });
    await expect(paneSpawnTool.handler({ agentName: 'Executor' }, ctx)).rejects.toThrow('budget_exhausted');
    h.panes[0].state = 'exited';
    exitPane(h.panes[0]);
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it('F-1258: o watchdog de início também libera o writer isolado sem filho', async () => {
    const owner = { id: 1259, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() } as unknown as WebContents;
    bindResolvedRendererWorkspaceScope(owner, ctx.scope);
    registerOrchRenderer(owner);
    try {
      const grantPromise = requestPaneSpawn({
        adapterId: 'codex',
        scope: ctx.scope,
        isolatedWriter: true,
        [PENDING_SPAWN_RESULT]: true,
      });
      const request = (owner as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls[0]?.[1] as
        { requestId: string; paneId: string };
      expect(request?.requestId).toMatch(/^orchspawn-/);
      h.spawn.mockImplementationOnce(async (options: SpawnToolOptions) => {
        h.panes.push({ paneId: request.paneId, sessionId: 'session-never-born', kind: 'cli-agent',
          title: 'worker', state: 'spawning', role: 'worker', missionId: options.missionId,
          scope: options.scope, executionScope: options.executionScope ?? options.scope,
          readOnly: options.readOnly });
        throw new Error('pane spawn pending');
      });
      h.pending.mockReturnValueOnce({ ok: true, paneId: request.paneId, sessionId: null, pending: true });
      await expect(paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx))
        .resolves.toMatchObject({ pending: true });
      expect(registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('ready');
      expect(resolvePaneSpawn(
        { requestId: request.requestId, ok: true, paneId: request.paneId, sessionId: null, pending: true },
        owner,
      )).toBe(true);
      await expect(grantPromise).resolves.toMatchObject({ pending: true });
      expect(abandonPendingOrchSpawn(request.requestId, 'pane did not start')).toBe(true);
      expect(registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('failed');
    } finally {
      unregisterOrchRenderer(owner);
      clearRendererWorkspaceScope(owner);
    }
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

  it('P1-4: dois resumes simultâneos do mesmo writer — um reabre, o outro recebe erro claro', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    const [record] = opRecords();
    fs.writeFileSync(path.join(opRecords()[0].worktreePath, 'base.txt'), 'writer\n');
    git(opRecords()[0].worktreePath, 'commit', '-qam', 'writer output');
    closePane(h.panes[0]);
    slowSpawn();
    const results = await Promise.allSettled([1, 2].map(() =>
      paneSpawnTool.handler({ adapterId: 'codex', resume: 'pane-0' }, op)));
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(String(rejected.reason)).toMatch(/outra retomada dela já está em andamento/);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.spawn.mock.calls[1][0]).toMatchObject({ cwd: record.worktreePath });
    expect(opRecords()).toHaveLength(1);
    // O pane nascido segura a worktree; fechado, a retomada volta a valer.
    await expect(paneSpawnTool.handler({ adapterId: 'codex', resume: 'pane-0' }, op))
      .rejects.toThrow(/ainda há um pane ativo nela/);
    closePane(h.panes.at(-1)!);
    await paneSpawnTool.handler({ adapterId: 'codex', resume: 'pane-0' }, op);
    expect(h.spawn).toHaveBeenCalledTimes(3);
  });

  it('Fable P2-8: mão do operador retoma o writer isolado de missão encerrada; de missão viva, não', async () => {
    await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx);
    const [record] = registry.listMission(ctx.scope, ctx.missionId!);
    fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'writer\n');
    git(record.worktreePath, 'commit', '-qam', 'writer output');
    h.panes[0].state = 'exited';
    exitPane(h.panes[0]);
    await expect(paneSpawnTool.handler({ adapterId: 'codex', resume: 'pane-0' }, op))
      .rejects.toThrow(/pertence a outro escopo/);
    h.mission = { ...h.mission, status: 'done' };
    const receipt = await paneSpawnTool.handler({ adapterId: 'codex', resume: 'pane-0' }, op) as Record<string, any>;
    expect(h.spawn.mock.calls.at(-1)![0]).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true });
    expect(receipt.isolatedWorktree.branch).toBe(record.branchRef.slice('refs/heads/'.length));
    expect(registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('ready');
    expect(opRecords()).toHaveLength(0);
  });

  it('P1-4: resume cujo spawn falha solta a reserva', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    fs.writeFileSync(path.join(opRecords()[0].worktreePath, 'base.txt'), 'writer\n');
    git(opRecords()[0].worktreePath, 'commit', '-qam', 'writer output');
    closePane(h.panes[0]);
    h.spawn.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(paneSpawnTool.handler({ adapterId: 'codex', resume: 'pane-0' }, op)).rejects.toThrow('spawn failed');
    await paneSpawnTool.handler({ adapterId: 'codex', resume: 'pane-0' }, op);
    expect(h.spawn).toHaveBeenCalledTimes(3);
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

  it('F-908: fim do pane de missão coleta o writer já mesclado; sem commit ou não mesclado fica', async () => {
    await Promise.all([1, 2, 3].map(() => paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx)));
    const [merged, unmerged, idle] = h.panes.map((pane) => registry.listMission(ctx.scope, ctx.missionId!)
      .find((r) => r.worktreePath === pane.executionScope!.rootRealPath)!);
    for (const [record, file] of [[merged, 'm.txt'], [unmerged, 'u.txt']] as const) {
      fs.writeFileSync(path.join(record.worktreePath, file), file);
      git(record.worktreePath, 'add', file);
      git(record.worktreePath, 'commit', '-qm', file);
    }
    git(ctx.scope.rootRealPath, 'merge', '-q', '--no-edit', merged.branchRef.slice('refs/heads/'.length));
    for (const pane of h.panes) {
      pane.state = 'exited';
      exitPane(pane);
    }
    await operatorHandGcIdle();
    await worktreeSalvageIdle();
    const kept = registry.listMission(ctx.scope, ctx.missionId!).map((r) => r.taskId);
    expect(fs.existsSync(merged.worktreePath)).toBe(false);
    expect(kept).not.toContain(merged.taskId);
    expect(() => git(ctx.scope.rootRealPath, 'rev-parse', '--verify', '--quiet', merged.branchRef)).toThrow();
    // Não mesclado e sem commit (retomável) continuam inteiros.
    expect(kept).toEqual(expect.arrayContaining([unmerged.taskId, idle.taskId]));
    expect(fs.existsSync(unmerged.worktreePath)).toBe(true);
    expect(fs.existsSync(idle.worktreePath)).toBe(true);
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

  describe('F-1388: resume de writer sem conversa retomável cai fresco na mesma worktree', () => {
    it('writer isolado sem provider session: pane novo na worktree com nota + commits, recibo fresh-in-worktree', async () => {
      await paneSpawnTool.handler({ adapterId: 'kimi', isolatedWriter: true, prompt: 'brief original' }, op);
      const [record] = opRecords();
      fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'writer\n');
      git(record.worktreePath, 'commit', '-qam', 'worker output');
      h.providerlessPanes.add('pane-0');
      closePane(h.panes[0]);
      const receipt = await paneSpawnTool.handler(
        { adapterId: 'kimi', resume: 'pane-0', prompt: 'ajuste: falta teste do caso vazio' }, op,
      ) as Record<string, any>;
      expect(receipt.resume).toMatchObject({ mode: 'fresh-in-worktree' });
      const options = h.spawn.mock.calls.at(-1)![0] as SpawnToolOptions;
      expect(options.cwd).toBe(record.worktreePath);
      expect(options.executionScope?.rootRealPath).toBe(record.worktreePath);
      // Sem conversa para retomar: nada de resume/resumeFromPaneId no spawn.
      expect(options.resumeFromPaneId).toBeUndefined();
      expect(options.resume).toBeUndefined();
      expect(options.prompt).toContain('ajuste: falta teste do caso vazio');
      expect(options.prompt).toContain('worker output');
    });

    it('writer de missão sem provider session segue o mesmo caminho', async () => {
      await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx);
      const [record] = registry.listMission(ctx.scope, ctx.missionId!);
      fs.writeFileSync(path.join(record.worktreePath, 'f.txt'), 'x');
      git(record.worktreePath, 'add', 'f.txt');
      git(record.worktreePath, 'commit', '-qm', 'partial work');
      h.providerlessPanes.add('pane-0');
      h.panes[0].state = 'exited';
      exitPane(h.panes[0]);
      const receipt = await paneSpawnTool.handler(
        { agentName: 'Executor', resume: 'pane-0', prompt: 'melhore a entrega' }, ctx,
      ) as Record<string, any>;
      expect(receipt.resume).toMatchObject({ mode: 'fresh-in-worktree' });
      const options = h.spawn.mock.calls.at(-1)![0] as SpawnToolOptions;
      expect(options).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true });
      expect(options.prompt).toContain('melhore a entrega');
      expect(options.prompt).toContain('partial work');
    });

    it('writer COM conversa retomável mantém o resume exato (sem fallback)', async () => {
      await paneSpawnTool.handler({ adapterId: 'kimi', isolatedWriter: true }, op);
      const [record] = opRecords();
      closePane(h.panes[0]);
      const receipt = await paneSpawnTool.handler({ adapterId: 'kimi', resume: 'pane-0' }, op) as Record<string, any>;
      expect(receipt.resume).toBeUndefined();
      const options = h.spawn.mock.calls.at(-1)![0] as SpawnToolOptions;
      expect(options).toMatchObject({ cwd: record.worktreePath, resume: true, resumeFromPaneId: 'pane-0' });
    });
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
    await operatorHandGcIdle();
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

describe('GC de worktrees fora do caminho do spawn/fechamento (Fable P2-9)', () => {
  it('spawn e fechamento não esperam o GC; nunca dois GCs no mesmo repo, pedidos no meio viram uma rodada extra', async () => {
    const op: AgentGateContext = { ...ctx, token: 'op', label: 'operador', role: 'user', sessionId: 'op-session', missionId: undefined };
    let finish!: () => void;
    const collect = vi.spyOn(registry, 'collectIntegratedPaneWorktrees')
      .mockImplementation(() => new Promise((resolve) => { finish = () => resolve([]); }));
    const spawning = paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    expect(collect).not.toHaveBeenCalled();
    // F-764: Git agora cede o event loop. O GC pode começar DURANTE o spawn;
    // seu promise continua pendurado, sem impedir a criação de terminar.
    await spawning;
    await new Promise((resolve) => setImmediate(resolve));
    expect(collect).toHaveBeenCalledTimes(1);
    // Com a coleta pendurada, spawn e fechamento seguem livres e não empilham GCs.
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    for (const pane of h.panes) {
      pane.state = 'exited';
      for (const tap of [...h.exits]) tap(pane.sessionId!, {
        sessionId: pane.sessionId!, adapterId: 'codex', cwd: pane.executionScope!.rootRealPath,
        scope: pane.executionScope!, source: 'pending', role: 'user',
        readOnly: false, allowedTools: [], allowedSkills: null,
      });
    }
    h.panes = [];
    await new Promise((resolve) => setImmediate(resolve));
    expect(collect).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(collect).toHaveBeenCalledTimes(2);
    finish();
    await operatorHandGcIdle();
    expect(collect).toHaveBeenCalledTimes(2);
  });
});

describe('1d: vínculo pane→worktree sobrevive ao reinício do app', () => {
  let op: AgentGateContext;
  beforeEach(() => {
    op = { ...ctx, token: 'op', label: 'operador', role: 'user', sessionId: 'op-session', missionId: undefined };
  });
  const closePane = (pane: PaneSnapshot) => {
    pane.state = 'exited';
    for (const tap of [...h.exits]) tap(pane.sessionId!, {
      sessionId: pane.sessionId!, adapterId: 'codex', cwd: pane.executionScope!.rootRealPath,
      scope: pane.executionScope!, source: 'pending', role: 'user',
      readOnly: false, allowedTools: [], allowedSkills: null,
    });
  };
  /**
   * Reinício: módulos novos (nada de estado em memória do processo anterior),
   * registry novo sobre o MESMO banco reaberto do disco.
   */
  const restartApp = async () => {
    h.exits.clear();
    disposeWorktreeRuntimeRegistry();
    manager.closeAll();
    vi.resetModules();
    const runtime = await import('../runtime/project-runtime-manager');
    const worktreeRegistry = await import('../runtime/worktree-runtime-registry');
    manager = new runtime.ProjectRuntimeManager({ baseDir: path.join(temp, 'runtime'), appVersion: 'test' });
    const reopened = worktreeRegistry.configureWorktreeRuntimeRegistry(manager);
    onTestFinished(() => worktreeRegistry.disposeWorktreeRuntimeRegistry());
    const { paneSpawnTool: tool } = await import('./tools-panes');
    return { tool, registry: reopened };
  };

  it('resume por paneId depois de reiniciar volta à worktree/branch original', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    const [record] = registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY);
    expect(record).toMatchObject({ paneIds: ['pane-0'], sessionIds: ['session-pane-0'] });
    fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'writer\n');
    git(record.worktreePath, 'commit', '-qam', 'writer output');
    closePane(h.panes[0]);
    const after = await restartApp();
    const receipt = await after.tool.handler({ adapterId: 'codex', resume: 'pane-0' }, op) as Record<string, any>;
    const options = h.spawn.mock.calls.at(-1)![0] as SpawnToolOptions;
    expect(options).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true, resumeFromPaneId: 'pane-0' });
    expect(receipt.isolatedWorktree.branch).toBe(record.branchRef.slice('refs/heads/'.length));
    const records = after.registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'ready', paneIds: ['pane-0', 'pane-1'] });
  });

  it('resume por id de task (h-N) depois de o app morrer com o writer rodando (ACK pendente)', async () => {
    h.spawn.mockImplementationOnce(async (options: SpawnToolOptions) => {
      h.panes.push({ paneId: 'pending-pane', sessionId: 'pending-session', kind: 'cli-agent',
        title: 'pending', state: 'spawning', executionScope: options.executionScope });
      throw new Error('pane spawn pending');
    });
    h.pending.mockReturnValueOnce({ ok: true, paneId: 'pending-pane', sessionId: null, pending: true });
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    const [record] = registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY);
    fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'writer\n');
    git(record.worktreePath, 'commit', '-qam', 'writer output');
    // A sessão nasce depois do ACK; o writer entrega o handoff e sai.
    closePane(h.panes[0]);
    h.handoffs['h-7'] = { sessionId: 'pending-session' };
    expect(registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY)[0])
      .toMatchObject({ paneIds: ['pending-pane'], sessionIds: ['pending-session'] });
    const after = await restartApp();
    const receipt = await after.tool.handler({ adapterId: 'codex', resume: 'h-7' }, op) as Record<string, any>;
    const resumed = h.spawn.mock.calls.at(-1)![0] as SpawnToolOptions;
    // F-1388: o spawn pendente morreu com o app — nunca gravou provider
    // session. O pane nasce fresco na mesma worktree, sem resume de provider.
    expect(resumed).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true });
    expect(resumed.resume).toBeUndefined();
    expect(resumed.resumeFromPaneId).toBeUndefined();
    expect(receipt.resume).toMatchObject({ mode: 'fresh-in-worktree' });
    expect(after.registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY)).toHaveLength(1);
  });

  it('writer rodando quando o app caiu: o reinício o marca interrompido e o resume reabre a mesma worktree', async () => {
    await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx);
    const [record] = registry.listMission(ctx.scope, ctx.missionId!);
    h.panes[0].state = 'exited';
    const after = await restartApp();
    expect(after.registry.listMission(ctx.scope, ctx.missionId!)[0].status).toBe('failed');
    await after.tool.handler({ agentName: 'Executor', resume: 'pane-0' }, ctx);
    expect(h.spawn.mock.calls.at(-1)![0]).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true });
    expect(after.registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(1);
  });

  it('depois de reiniciar, worktree sumida dá erro claro e não cai no checkout nem aloca outra', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', isolatedWriter: true }, op);
    const [record] = registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY);
    fs.writeFileSync(path.join(record.worktreePath, 'base.txt'), 'writer\n');
    git(record.worktreePath, 'commit', '-qam', 'writer output');
    closePane(h.panes[0]);
    git(op.scope.rootRealPath, 'worktree', 'remove', '--force', record.worktreePath);
    const after = await restartApp();
    await expect(after.tool.handler({ adapterId: 'codex', resume: 'pane-0' }, op))
      .rejects.toThrow(/worktree original do writer isolado pane-0 .*não está disponível/);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(after.registry.listMission(op.scope, OPERATOR_HAND_WORKTREE_KEY)).toHaveLength(1);
  });

  it('resume de writer isolado de outra missão é recusado mesmo depois de reiniciar', async () => {
    await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true }, ctx);
    closePane(h.panes[0]);
    const after = await restartApp();
    await expect(after.tool.handler({ adapterId: 'codex', resume: 'pane-0' }, op))
      .rejects.toThrow(/pertence a outro escopo/);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('F-980/F-981: writers paralelos da aba isolada e cwd em outra worktree', () => {
  beforeEach(() => resetWriterClaimsForTests());
  const tabMission = async () => {
    h.mission = { ...h.mission, intentContract: { ...(h.mission.intentContract as object), workspaceBinding: newMissionWorkspaceBinding() } };
    const tab = await prepareMissionExecutionScope(ctx.scope, h.mission as never);
    fs.writeFileSync(path.join(tab.rootRealPath, 'tab.txt'), 'commit da aba\n');
    git(tab.rootRealPath, 'add', 'tab.txt');
    git(tab.rootRealPath, 'commit', '-qm', 'tab work');
    fs.writeFileSync(path.join(tab.rootRealPath, 'base.txt'), 'WIP da aba\n');
    return { tab, head: git(tab.rootRealPath, 'rev-parse', 'HEAD') };
  };

  it('F-980: isolatedWriter na missão da aba nasce do HEAD da aba, numa branch própria registrada', async () => {
    const { tab, head } = await tabMission();
    expect(head).not.toBe(git(ctx.scope.rootRealPath, 'rev-parse', 'HEAD'));
    const receipt = await paneSpawnTool.handler({ agentName: 'Executor', isolatedWriter: true, prompt: 'Implement feature' }, ctx) as Record<string, any>;
    const [record] = registry.listMission(ctx.scope, ctx.missionId!);
    expect(record).toMatchObject({ ownerKind: 'pane', status: 'ready', baseSha: head, rootRealPath: ctx.scope.rootRealPath });
    expect(git(record.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(record.worktreePath, 'symbolic-ref', 'HEAD')).toBe(record.branchRef);
    expect(fs.readFileSync(path.join(record.worktreePath, 'tab.txt'), 'utf8')).toBe('commit da aba\n');
    expect(fs.readFileSync(path.join(record.worktreePath, 'base.txt'), 'utf8')).toBe('committed\n');
    const [options] = h.spawn.mock.calls[0] as [SpawnToolOptions];
    expect(options).toMatchObject({ cwd: record.worktreePath, executionMode: 'isolated_worktree', isolatedWriter: true, scope: ctx.scope });
    expect(options.executionScope?.rootRealPath).toBe(record.worktreePath);
    expect(options.prompt).toContain(tab.rootRealPath);
    expect(receipt.isolatedWorktree).toMatchObject({ baseSha: head, worktreePath: record.worktreePath, note: ISOLATED_TAB_WORKTREE_NOTE });
    expect(fs.readFileSync(path.join(tab.rootRealPath, 'base.txt'), 'utf8')).toBe('WIP da aba\n');
  });

  it('F-980: o segundo writer comum da aba é auto-isolado do HEAD da aba em vez de recusado', async () => {
    const { tab, head } = await tabMission();
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ cwd: tab.rootRealPath });
    const receipt = await paneSpawnTool.handler({ agentName: 'Executor' }, ctx) as Record<string, any>;
    const [record] = registry.listMission(ctx.scope, ctx.missionId!);
    expect(record.baseSha).toBe(head);
    expect(h.spawn.mock.calls[1][0]).toMatchObject({ cwd: record.worktreePath, isolatedWriter: true });
    expect(receipt.isolatedWorktree.reason).toMatch(/auto-isolado/);
  });

  it('F-981: cwd na raiz de outra worktree git roda lá e não serializa contra o writer do checkout', async () => {
    const root = ctx.scope.rootRealPath;
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    const nested = path.join(root, '.harvest', 'w1');
    git(root, 'worktree', 'add', '-q', '-b', 'harvest/w1', nested);
    const receipt = await paneSpawnTool.handler({ agentName: 'Executor', cwd: nested }, ctx) as Record<string, any>;
    expect(receipt.executionMode).toBe('same_checkout');
    expect(receipt.isolatedWorktree).toBeUndefined();
    expect(h.spawn.mock.calls[1][0]).toMatchObject({ cwd: nested });
    expect(h.spawn.mock.calls[1][0].executionScope.rootRealPath).toBe(nested);
    expect(registry.listMission(ctx.scope, ctx.missionId!)).toHaveLength(0);
    // Segundo writer na MESMA worktree aninhada: serializado, com a saída.
    await expect(paneSpawnTool.handler({ agentName: 'Executor', cwd: path.join(nested, '.') }, ctx))
      .rejects.toThrow(/same-checkout delegation is serialized.*isolatedWriter:true/);
    expect(h.spawn).toHaveBeenCalledTimes(2);
  });

  it('F-981: o cwd do worker de missão é honrado dentro do checkout e recusado fora — nunca descartado em silêncio', async () => {
    const root = ctx.scope.rootRealPath;
    fs.mkdirSync(path.join(root, 'sub'));
    await paneSpawnTool.handler({ agentName: 'Executor', cwd: 'sub' }, ctx);
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ cwd: path.join(root, 'sub'), executionScope: ctx.scope });
    await expect(paneSpawnTool.handler({ agentName: 'Executor', readOnly: true, cwd: path.join(temp, 'fora') }, ctx))
      .rejects.toThrow(/cwd descartado/);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('F-981: writer ainda em spawn (ACK pendente, não espelhado ou sem papel nos snapshots) conta como escritor do checkout', async () => {
    const root = ctx.scope.rootRealPath;
    h.spawn.mockImplementationOnce(async () => { throw new Error('pane spawn pending'); });
    h.pending.mockReturnValueOnce({ ok: true, paneId: 'pending-pane', sessionId: null, pending: true });
    h.pendingPanes.add('pending-pane');
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(h.spawn.mock.calls[0][0].cwd).toBe(root);
    // O renderer ainda não espelhou o pane (concessão pendente no Main): o segundo writer não divide o checkout.
    const receipt = await paneSpawnTool.handler({ agentName: 'Executor' }, ctx) as Record<string, any>;
    expect(h.spawn.mock.calls[1][0]).toMatchObject({ isolatedWriter: true });
    expect(h.spawn.mock.calls[1][0].cwd).not.toBe(root);
    expect(receipt.isolatedWorktree.reason).toMatch(/em spawn/);
    // Espelhado com sessão, ainda em spawning e sem papel/escopo: continua contando.
    const pending: PaneSnapshot = { paneId: 'pending-pane', sessionId: 'pending-session', kind: 'cli-agent', title: 'w', state: 'spawning' };
    h.panes.push(pending);
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(h.spawn.mock.calls[2][0]).toMatchObject({ isolatedWriter: true });
    // Terminou: o checkout volta a ficar livre.
    pending.state = 'exited';
    await paneSpawnTool.handler({ agentName: 'Executor' }, ctx);
    expect(h.spawn.mock.calls[3][0].cwd).toBe(root);
    expect(h.spawn.mock.calls[3][0].isolatedWriter).toBeUndefined();
    h.panes.splice(h.panes.indexOf(pending), 1);
  });
});
