import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { newMissionWorkspaceBinding, prepareMissionExecutionScope } from './mission-execution-scope';
import { missionExecutionScope } from './mission-execution-scope';
import { captureWorkingTreeCandidate } from '../context/candidate-working-tree-snapshot';
import { ensureMissionCodeCompletion } from './mission-code-completion';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff, Mission, Squad, SquadAgent } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { missionIntentContractSchema } from '../../shared/mission-intent';
import { ProcessGitRunner } from '../runtime/git-command';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry, type ProjectDomainStoreSuite } from './project-domain-store-registry';
import { createScopedEffectOutboxStore } from './effect-outbox';
import type { ScopedTaskRecord } from './task-store';
import { completeVerifiedMission } from './mission-engine-production';
import { maybeCompleteFastLaneOnDelivery, type CivilianStores } from './civilian-delivery-completion';
import { __resetCivilianAutoReviewForTests, enforceCivilianAutoReview } from './civilian-auto-review';
import { getAutomaticCompletionProof, withAutomaticCompletionProof } from './automatic-completion-proof';
import { recordOperatorTabCompletionRequest } from './operator-tab-completion';

/** Real reconciliation, scanner, filesystem/Git, proof and final gates; no Electron app or external CLI. */
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isReady: () => true },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];
const GOOD_SOURCE = 'export function bookingLabel() {\n  return "Agendamento";\n}\n';
const BAD_SOURCE = 'export function bookingLabel() {\n  return "Agendamento";\n  console.log("unreachable");\n}\n';

beforeEach(() => __resetCivilianAutoReviewForTests());
afterEach(async () => {
  await disposeProjectDomainStoreRegistry();
  disposeWorktreeRuntimeRegistry();
  managers.splice(0).forEach(manager => manager.closeAll());
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function fixture(options: { git?: boolean; goal?: string; lane?: 'standard' | 'consult'; paneMission?: boolean } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-autopilot-integration-')));
  roots.push(root);
  const git = new ProcessGitRunner();
  const runGit = (...args: string[]) => git.run(root, args).stdout.trim();
  if (options.git) {
    runGit('init', '-q');
    runGit('config', 'user.name', 'Nexus Fixture');
    runGit('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'README.md'), '# Temporary fixture\n');
    runGit('add', '--', 'README.md');
    runGit('commit', '-qm', 'Fixture baseline');
    fs.utimesSync(path.join(root, 'README.md'), 1, 1);
  }
  const baselineSha = options.git ? runGit('rev-parse', 'HEAD') : null;
  const stat = fs.statSync(root);
  const scope: ProjectExecutionScope = {
    version: 1, installationId: 'integration', projectId: path.basename(root),
    checkoutId: path.basename(root), rootRealPath: root, identitySource: 'manifest',
    workspaceRootDevice: String(stat.dev), workspaceRootInode: String(stat.ino),
  };
  const domainRuntime = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-completion-domain-runtime-')));
  roots.push(domainRuntime);
  const domainManager = new ProjectRuntimeManager({ baseDir: domainRuntime, appVersion: 'completion-test' });
  managers.push(domainManager);
  configureProjectDomainStoreRegistry(domainManager).forScope(scope);
  const agents: SquadAgent[] = [
    { id: 'orchestrator', agentName: 'Orchestrator', category: 'orchestrator', cli: 'codex' },
    { id: 'builder', agentName: 'Builder', category: 'executor', cli: 'codex' },
    { id: 'reviewer', agentName: 'Reviewer', category: 'reviewer', cli: 'claude' },
  ];
  const squad = { id: 'fixture-squad', name: 'Fixture squad', agents } as Squad;
  const goal = options.goal ?? 'Crie um sistema de agendamento simples';
  let mission: Mission = {
    id: path.basename(root), title: 'Agendamento', description: goal, squadId: options.paneMission ? undefined : squad.id,
    ...(options.paneMission ? { orchestratorSessionId: 'fixture-orchestrator' } : {}),
    status: 'running', intentState: 'executing', intentVersion: 1,
    createdAt: Date.now() - 1000, updatedAt: 1000, milestones: [], learnings: '',
    intentContract: missionIntentContractSchema.parse({ version: 1, source: 'typed', goal, lane: options.lane ?? 'standard',
      orchestrationMode: 'livre', freeAgentChoice: true, acceptanceCriteria: [],
      risk: 'normal', executionMode: 'autopilot', contextPolicy: 'minimal', intentVersion: 1,
      ...(options.paneMission ? { workspaceBinding: { version: 1, adoptedPaneId: 'operator-pane' } } : {}),
      budgets: { planningTokens: 1000, executionTokens: 1000, maxWorkers: 3 } }),
  } as Mission;
  const tasks: ScopedTaskRecord[] = [{
    id: 'build-task', missionId: mission.id, title: 'Builder', detail: '', status: 'done',
    createdAt: mission.createdAt, updatedAt: 1000, projectId: scope.projectId, checkoutId: scope.checkoutId,
  }];
  const handoffs: Handoff[] = [{
    id: 'builder-result', missionId: mission.id, fromAgent: 'Builder', sessionId: 'fixture-builder',
    status: 'success', summary: options.lane === 'consult' ? 'A resposta é 2.' : 'O pedido foi executado.',
    artifacts: [], evidenceIds: [], claimTrust: 'untrusted', evidenceTrust: 'unverified',
    delivered: true, deliveryState: 'consumed', createdAt: Date.now(),
  }];
  const transition = vi.fn((id: string, expected: { updatedAt: number; intentVersion: number }, patch: Partial<Mission>) => {
    if (id !== mission.id || expected.updatedAt !== mission.updatedAt || expected.intentVersion !== mission.intentVersion) return null;
    mission = { ...mission, ...patch, updatedAt: mission.updatedAt + 1 };
    return mission;
  });
  const stores = {
    missions: { get: (id: string) => id === mission.id ? mission : null, transitionLifecycle: transition },
    handoffs: { list: () => handoffs, listDeliveryAttempts: () => [] },
    taskDispatches: { list: () => [] },
    missionPanes: { list: () => [], record: vi.fn() },
    tasks: {
      list: () => tasks,
      listPlannedTasks: () => [{ taskId: tasks[0]!.id, agentCategory: 'executor' as const, agent: agents[1]! }],
      markLifecycleStatus: (id: string) => tasks.find((task) => task.id === id) ?? null,
    },
  };
  const productionStores = stores as unknown as ProjectDomainStoreSuite;
  const observedProofs: ReturnType<typeof getAutomaticCompletionProof>[] = [];
  const complete = vi.fn((executionScope: ProjectExecutionScope, input: Parameters<typeof completeVerifiedMission>[2]) => {
    observedProofs.push(getAutomaticCompletionProof(executionScope, mission));
    // The callback MUST delegate to the real production boundary, never mark done itself.
    completeVerifiedMission(executionScope, productionStores, input, { getSquad: () => squad, listPanes: () => [] });
  });
  const blockUser = vi.fn();
  const deliverRepair = vi.fn(async () => true);
  let clock = Date.now();
  const review = vi.fn(async (input: Parameters<typeof enforceCivilianAutoReview>[0]) =>
    enforceCivilianAutoReview({ ...input, liveOrchestratorSessionId: 'fixture-orchestrator' }, {
      now: () => clock,
      deliverRepair,
      typecheck: async () => ({ kind: 'typecheck', status: 'passed', summary: 'Fixture compiler result.', findings: [] }),
      audit: async () => ({ kind: 'dependency-audit', status: 'passed', summary: 'Fixture audit result.', findings: [] }),
    }));
  const reconcile = () => maybeCompleteFastLaneOnDelivery(scope, mission.id, {
    getStores: () => stores as CivilianStores, getSquad: () => squad, listPanes: () => [],
    readFrozenReviewContext: () => null, runAutoReviewGate: review,
    ...(options.paneMission ? { resolveMissionLeader: () => ({ sessionId: 'fixture-orchestrator', paneId: 'operator-pane', source: 'durable' as const, proven: true as const }) } : {}),
    runCodeCompletionGate: (input) => ensureMissionCodeCompletion({ scope, executionScope: missionExecutionScope(scope, mission),
      mission, baselineSha, authorSessionIds: ['fixture-writer'], requiredPaths: input.productFiles,
    }, {
      captureCandidate: captureWorkingTreeCandidate,
      assertCurrent: () => input.lifetime?.assertCurrent(),
      runMechanical: (work) => review({ ...input, productFiles: work.candidate.coveredPaths ?? work.candidate.changedPaths, completionBaseSha: work.baseSha }),
      // No provider/model call: the production coordinator, scanner, candidate
      // snapshots and final proof boundary remain real; only the judge is a fixture.
      ensureIndependentReview: async (work) => ({ kind: 'reviewed', readOnly: true,
        baseSha: work.baseSha, candidateFingerprint: work.candidate.fingerprint,
        verdict: { verdictId: 'fixture-frontier-review', missionId: mission.id, headSha: work.candidate.headSha,
          treeDirty: true, verdict: 'approve', reviewerAdapter: 'codex', reviewerModel: 'gpt-6.1-sol',
          reviewerSession: 'fixture-independent-judge', frontier: true, findings: [], summary: 'Independent fixture review', createdAt: Date.now() } }),
    }),
    missionEngine: { completeVerified: complete, blockUser },
  });
  let executionRoot = root;
  const writeProduct = (body = GOOD_SOURCE, target = executionRoot) => {
    fs.mkdirSync(path.join(target, 'src'), { recursive: true });
    fs.writeFileSync(path.join(target, 'src/bookings.ts'), body);
  };
  const isolate = async () => {
    const runtime = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-completion-tab-runtime-')));
    roots.push(runtime);
    const manager = new ProjectRuntimeManager({ baseDir: runtime, appVersion: 'test' });
    managers.push(manager);
    configureWorktreeRuntimeRegistry(manager);
    mission = { ...mission, intentContract: { ...mission.intentContract!, workspaceBinding: newMissionWorkspaceBinding() } };
    executionRoot = (await prepareMissionExecutionScope(scope, mission)).rootRealPath;
    mission.intentContract!.dispatchedAt = Date.now();
    return executionRoot;
  };
  return { root, scope, domainManager, squad, handoffs, isolate, runGit, writeProduct, reconcile, complete, review, deliverRepair,
    observedProofs, transition, mission: () => mission, advanceClock: () => { clock += 100000; } };
}

describe('autopilot completion through the real production boundary', () => {
  it('cannot complete reviewed code while the coordination DB has a pending physical obligation', async () => {
    const state = fixture({ git: true });
    await state.isolate();
    state.writeProduct();
    const outbox = createScopedEffectOutboxStore(state.domainManager, state.scope);
    outbox.enqueue({ commandId: 'owned-process-still-alive', threadId: state.mission().id, type: 'dispatch.physical-settlement' });
    const result = await state.reconcile();
    expect(result.completed).toBe(false);
    expect(state.mission().status).toBe('running');
    expect(state.complete).not.toHaveBeenCalled();
    expect(state.transition).not.toHaveBeenCalled();
    expect(outbox.listUnsettledBlocking(state.mission().id).rows).toEqual([
      expect.objectContaining({ type: 'dispatch.physical-settlement', status: 'pending' }),
    ]);
  });

  it.each([false, true])('a scanner-only receipt cannot bypass independent code review (pane mission=%s)', (paneMission) => {
    const state = fixture({ git: true, paneMission });
    state.writeProduct();
    const mission = state.mission();
    expect(() => withAutomaticCompletionProof(state.scope, mission, { status: 'verified', candidateFingerprint: 'unbound-scanner' }, () => {
      state.complete(state.scope, {
        missionId: mission.id, expectedStatus: 'running', expectedIntentState: mission.intentState ?? 'legacy',
        expectedUpdatedAt: mission.updatedAt, expectedIntentVersion: mission.intentVersion ?? 0,
        learnings: 'Entrega declarada sem revisão independente.',
        result: { outcome: 'success', summary: 'Código pronto.', artifactRefs: ['src/bookings.ts'], evidenceIds: [] },
      });
      return true;
    })).toThrow(/revisão frontier independente/i);
    expect(state.mission().status).toBe('running');
  });

  it('a +Pane mission without squad waits for the operator request and verifies the current code through the same production boundary', async () => {
    const state = fixture({ git: true, paneMission: true });
    state.writeProduct();
    expect(state.mission().squadId).toBeUndefined();
    expect((await state.reconcile()).completed).toBe(false);
    expect(state.review).not.toHaveBeenCalled();
    recordOperatorTabCompletionRequest(state.scope, state.mission());
    expect((await state.reconcile()).completed).toBe(true);
    expect(state.mission().status).toBe('done');
    expect(state.observedProofs[0]?.codeCompletion).toMatchObject({ kind: 'code', reviewerSessionId: 'fixture-independent-judge' });
  });
  it.each([true, false])('reviews the tab bytes, independent of opposite main content (tab bad=%s)', async (tabBad) => {
    const state = fixture({ git: true });
    const tab = await state.isolate();
    state.writeProduct(tabBad ? GOOD_SOURCE : BAD_SOURCE, state.root);
    state.writeProduct(tabBad ? BAD_SOURCE : GOOD_SOURCE);
    const result = await state.reconcile();
    expect(result.completed).toBe(!tabBad);
    expect(state.deliverRepair.mock.calls.length).toBe(tabBad ? 1 : 0);
    expect(fs.readFileSync(path.join(state.root, 'src/bookings.ts'), 'utf8')).toBe(tabBad ? GOOD_SOURCE : BAD_SOURCE);
    expect(tab).not.toBe(state.root);
    if (!tabBad) expect(state.mission().result?.artifactRefs).toContain('src/bookings.ts');
  });

  it('rejects a missing tab even when main contains a complete product', async () => {
    const state = fixture({ git: true });
    const tab = await state.isolate();
    state.writeProduct(GOOD_SOURCE, state.root);
    const empty = await state.reconcile();
    expect(empty.completed).toBe(false);
    expect(empty.productFiles).not.toContain('src/bookings.ts');
    expect(state.transition).not.toHaveBeenCalled();
    const attempts = state.complete.mock.calls.length;
    fs.rmSync(tab, { recursive: true });
    await expect(state.reconcile()).rejects.toThrow();
    expect(state.complete).toHaveBeenCalledTimes(attempts);
    expect(state.transition).not.toHaveBeenCalled();
  });

  it.each([false, true])('discovers the real product and completes without path metadata or approval (Git=%s)', async (withGit) => {
    const state = fixture({ git: withGit });
    state.writeProduct();
    if (withGit) { state.runGit('add', '--', 'src/bookings.ts'); state.runGit('commit', '-qm', 'Delivered product'); }

    const result = await state.reconcile();

    expect(result.completed).toBe(true);
    expect(state.mission().status).toBe('done');
    expect(state.mission().result?.artifactRefs).toContain('src/bookings.ts');
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.complete.mock.calls[0]![1].operatorOverride).not.toBe(true);
    expect(state.observedProofs[0]?.status).toBe('verified');
    expect(state.observedProofs[0]?.candidateFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(getAutomaticCompletionProof(state.scope, state.mission())).toBeNull();
  });

  it('waits for repair and completes only after a second review of the corrected files', async () => {
    const state = fixture();
    state.writeProduct(BAD_SOURCE);
    expect((await state.reconcile()).completed).toBe(false);
    expect(state.deliverRepair).toHaveBeenCalledOnce();
    expect(state.complete).not.toHaveBeenCalled();
    expect(state.mission().status).toBe('running');

    state.writeProduct();
    state.advanceClock();
    expect((await state.reconcile()).completed).toBe(true);
    expect(state.review).toHaveBeenCalledTimes(2);
    expect(state.mission().status).toBe('done');
  });

  it('accepts the current Main review despite a negative historical reviewer handoff', async () => {
    const state = fixture();
    state.writeProduct();
    state.handoffs.unshift({ ...state.handoffs[0]!, id: 'old-review', fromAgent: 'Reviewer',
      status: 'failed', summary: 'Reprovado: erro no candidato anterior.', createdAt: 1 });

    expect((await state.reconcile()).completed).toBe(true);
    expect(state.mission().status).toBe('done');
    expect(state.handoffs[0]?.status).toBe('failed');
    expect(state.observedProofs[0]?.status).toBe('verified');
  });

  it('completes a real deletion with Main-collected Git evidence and no replacement artifact', async () => {
    const state = fixture({ git: true, goal: 'Apague README.md' });
    fs.unlinkSync(path.join(state.root, 'README.md'));

    const result = await state.reconcile();

    expect(result.completed).toBe(true);
    expect(state.mission().result?.artifactRefs).toEqual([]);
    expect(state.observedProofs[0]?.deletedArtifactPaths).toContain('README.md');
    expect(fs.existsSync(path.join(state.root, 'README.md'))).toBe(false);
  });

  it('completes a textual consultation without creating files', async () => {
    const state = fixture({ lane: 'consult', goal: 'Quanto é 1+1?' });
    expect((await state.reconcile()).completed).toBe(true);
    expect(state.mission().status).toBe('done');
    expect(state.mission().result?.artifactRefs).toEqual([]);
    expect(fs.readdirSync(state.root)).toEqual([]);
  });

  it('keeps an empty creation unfinished even when the worker says it succeeded', async () => {
    const state = fixture();
    const result = await state.reconcile();
    expect(result.completed).toBe(false);
    expect(state.mission().status).toBe('running');
    expect(state.transition).not.toHaveBeenCalled();
  });

  it.each(['.claude', '.qwen'])('does not mistake automatically created %s settings for the requested app', async (directory) => {
    const state = fixture();
    fs.mkdirSync(path.join(state.root, directory));
    fs.writeFileSync(path.join(state.root, directory, 'settings.json'), '{"model":"fixture"}');

    expect((await state.reconcile()).completed).toBe(false);
    expect(state.mission().status).toBe('running');
  });

  it('completes an ordinary requested project configuration after reviewing its actual bytes', async () => {
    const state = fixture({ goal: 'Crie config/app.json para o projeto' });
    fs.mkdirSync(path.join(state.root, 'config'));
    fs.writeFileSync(path.join(state.root, 'config/app.json'), '{"theme":"dark"}');
    state.handoffs[0]!.artifacts = [{ path: 'config/app.json' }];
    expect((await state.reconcile()).completed).toBe(true);
    expect(state.mission().result?.artifactRefs).toContain('config/app.json');
  });

  it('does not claim a protected configuration artifact was reviewed merely because it was delivered', async () => {
    const state = fixture({ goal: 'Crie o arquivo .claude/settings.json para o projeto' });
    fs.mkdirSync(path.join(state.root, '.claude'));
    fs.writeFileSync(path.join(state.root, '.claude/settings.json'), '{"model":"fixture"}');
    state.handoffs[0]!.artifacts = [{ path: '.claude/settings.json' }];

    expect((await state.reconcile()).completed).toBe(false);
    expect(state.mission().status).toBe('running');
    expect(state.complete).not.toHaveBeenCalled();
    expect(state.handoffs[0]?.artifacts).toContainEqual({ path: '.claude/settings.json' });
    expect(fs.readFileSync(path.join(state.root, '.claude/settings.json'), 'utf8')).toBe('{"model":"fixture"}');
  });
});
