import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { MissionEventJournal } from './mission-event-journal';
import { createScopedMissionStore } from './mission-store';
import type { MissionEventAppendInput } from '../../shared/mission-events';
import type {
  Mission,
  MissionPaneSpec,
  Squad,
  SquadAgent,
} from '../../shared/orch-types';
import type {
  MissionIntentContract,
} from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import {
  deliverMissionDirectInstruction,
  flushQueuedKickoffDirectsForMission,
  runtimeAuthorityMismatches,
  type MissionDirectDeliveryDeps,
} from './mission-engine-production';
import { takeKickoffDirects, resetKickoffDirectQueueForTests, beginKickoffBriefDelivery, endKickoffBriefDelivery,
  pendingKickoffBriefDelivery, kickoffIntentAuthorityHash, peekKickoffDirects } from './mission-kickoff-direct-queue';

afterEach(resetKickoffDirectQueueForTests);

/**
 * Caminho operador-como-orquestrador (P0-2, dossiê 2026-08-11): numa squad SEM
 * orquestrador (modo livre da Via Rápida), `deliverMissionDirectInstruction`
 * aceita a direção do operador contra um worker vivo. Gates preservados:
 * missão existe, dispatch authority live, squad selada e idempotência.
 */

function makeScope(): ProjectExecutionScope {
  return {
    version: 1,
    installationId: 'inst-1',
    projectId: 'proj-1',
    checkoutId: 'checkout-1',
    rootRealPath: '/tmp/nexus-workspace',
    identitySource: 'manifest',
  };
}

function makeAgent(overrides: Partial<SquadAgent> = {}): SquadAgent {
  return {
    id: 'ag-exec',
    agentName: 'Executor',
    category: 'executor',
    cli: 'claude',
    effort: 'medium',
    instructions: 'Implemente.',
    ...overrides,
  } as SquadAgent;
}

function makeSquad(agents: readonly SquadAgent[] = [makeAgent()]): Squad {
  return {
    id: 'squad-1',
    name: 'Equipe livre',
    createdAt: '1',
    builtin: false,
    orchestratorInstructions: '',
    agents: [...agents],
  } as Squad;
}

function makeIntentContract(
  squadHash: string,
  options: { readonly freeAgentChoice?: boolean } = {},
): MissionIntentContract {
  return {
    version: 1,
    source: 'typed',
    goal: 'Construir uma landing page.',
    acceptanceCriteria: ['A seção hero existe.'],
    risk: 'normal',
    executionMode: 'assisted',
    contextPolicy: 'minimal',
    budgets: {
      planningTokens: 50_000,
      executionTokens: 200_000,
      maxWorkers: 3,
    },
    intentVersion: 1,
    approvedAt: 1700000000000,
    dispatchedAt: 1700000000000,
    squadRevisionHash: squadHash,
    ...(options.freeAgentChoice ? { freeAgentChoice: true } : {}),
  };
}

/** Missão 'running' com dispatch authority live e squad selada no contrato. */
function makeApprovedMission(
  squad: Squad,
  overrides: Partial<Mission> = {},
): Mission {
  return makeMission({
    squadId: squad.id,
    intentContract: makeIntentContract(snapshotSquadAuthority(squad).hash),
    ...overrides,
  });
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Prova',
    description: '',
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    learnings: '',
    ...overrides,
  } as Mission;
}

function makeWorkerSession(
  overrides: Partial<OwnedAgentSessionInfo> = {},
): OwnedAgentSessionInfo {
  return {
    sessionId: 'sess-worker',
    paneId: 'pane-worker',
    adapterId: 'cli',
    cwd: '/tmp/nexus-workspace',
    scope: makeScope(),
    source: 'pending',
    role: 'worker',
    missionId: 'mission-1',
    squadId: 'squad-1',
    agentName: 'Executor',
    readOnly: false,
    allowedTools: null,
    allowedSkills: null,
    ...overrides,
  } as OwnedAgentSessionInfo;
}

function makeWorkerPane(overrides: Partial<MissionPaneSpec> = {}): MissionPaneSpec {
  return {
    id: 'pane-worker',
    // `missionPanes.list` devolve o paneId do layout na spec — é ele que o
    // caminho operador-como-orquestrador casa com a sessão do worker vivo.
    paneId: 'pane-worker',
    missionId: 'mission-1',
    adapterId: 'cli',
    title: 'Worker',
    role: 'worker',
    ...overrides,
  } as MissionPaneSpec;
}

interface Harness {
  readonly stores: Parameters<typeof deliverMissionDirectInstruction>[1];
  readonly deps: MissionDirectDeliveryDeps;
  readonly deliverSpy: ReturnType<typeof vi.fn>;
  readonly emitSpy: ReturnType<typeof vi.fn>;
}

function makeOrchSession(
  overrides: Partial<OwnedAgentSessionInfo> = {},
): OwnedAgentSessionInfo {
  return {
    sessionId: 'sess-orch-live',
    paneId: 'pane-orch',
    adapterId: 'cli',
    cwd: '/tmp/nexus-workspace',
    scope: makeScope(),
    source: 'pending',
    role: 'orchestrator',
    missionId: 'mission-1',
    squadId: 'squad-1',
    agentName: 'Orquestrador',
    readOnly: false,
    allowedTools: null,
    allowedSkills: null,
    ...overrides,
  } as OwnedAgentSessionInfo;
}

function makeOrchPane(overrides: Partial<MissionPaneSpec> = {}): MissionPaneSpec {
  return {
    id: 'pane-orch',
    paneId: 'pane-orch',
    missionId: 'mission-1',
    adapterId: 'cli',
    title: 'Orquestrador',
    role: 'orchestrator',
    agentName: 'Orquestrador',
    ...overrides,
  } as MissionPaneSpec;
}

function makeHarness(options: {
  readonly mission: Mission;
  readonly squad: Squad;
  readonly workers: readonly OwnedAgentSessionInfo[];
  readonly panes?: readonly MissionPaneSpec[];
  readonly getRuntimeAgentSessionInfo?: (
    sessionId: string,
  ) => OwnedAgentSessionInfo | null;
  readonly resumeOrchestrator?: MissionDirectDeliveryDeps['resumeOrchestrator'];
  readonly missionsUpdate?: (
    id: string,
    patch: { readonly status: Mission['status'] },
  ) => Mission | null;
  readonly kickoffReceipt?: boolean;
}): Harness {
  const deliverSpy = vi.fn(async () => true);
  const emitSpy = vi.fn(() => true);
  const stores = {
    missions: {
      get: () => options.mission,
      hasCurrentKickoffAcceptance: () => options.kickoffReceipt ?? true,
      ...(options.missionsUpdate
        ? { update: options.missionsUpdate }
        : {}),
    },
    missionPanes: {
      list: () => (options.panes ?? []).slice(),
    },
  } as unknown as Parameters<typeof deliverMissionDirectInstruction>[1];
  const deps: MissionDirectDeliveryDeps = {
    getRuntimeAgentSessionInfo:
      options.getRuntimeAgentSessionInfo ?? (() => null),
    getAcpDriverSession: () => null,
    getAcpDriverSemanticStatus: () => 'idle',
    getPaneRuntimeAuthorityBySession: () => null,
    getSquad: () => options.squad,
    listMissionWorkerSessions: () => options.workers.slice(),
    deliverAgentPrompt: deliverSpy as unknown as MissionDirectDeliveryDeps['deliverAgentPrompt'],
    emitMissionEvent: emitSpy as unknown as MissionDirectDeliveryDeps['emitMissionEvent'],
    ...(options.resumeOrchestrator
      ? { resumeOrchestrator: options.resumeOrchestrator }
      : {}),
  };
  return { stores, deps, deliverSpy, emitSpy };
}

function directCommand(
  overrides: Partial<{
    missionId: string;
    targetAgentId: string | null;
    text: string;
  }> = {},
) {
  return {
    kind: 'direct' as const,
    missionId: 'mission-1',
    targetAgentId: null as string | null,
    text: 'Adicione uma seção hero.',
    ...overrides,
  };
}

it('keeps the approved Maestro model and effort strict after default materialization (F-428)', () => {
  const scope = makeScope();
  const mission = makeMission({ orchestratorSessionId: 'sess-orch-live' });
  const runtime = { adapterId: 'cli', model: 'approved-model', effort: 'medium', readOnly: false, nativeReadOnly: false } satisfies Parameters<typeof runtimeAuthorityMismatches>[5];
  const seal = { intentVersion: 1, intentContractHash: 'a'.repeat(64), contextRevision: 'reviewed', contractHash: 'b'.repeat(64), squadRevisionHash: 'c'.repeat(64) };
  const pane = makeOrchPane({ model: runtime.model, effort: runtime.effort, cwd: scope.rootRealPath, authoritySeal: seal });
  const agent = makeOrchSession({ requestedModel: runtime.model, effort: runtime.effort, nativeReadOnly: false, authoritySeal: seal });
  const authority = { sessionId: agent.sessionId, paneId: pane.paneId!, kind: 'cli-agent' as const, missionId: mission.id, role: 'orchestrator' as const, scope, owner: null };
  expect(runtimeAuthorityMismatches(scope, mission, pane, agent, authority, runtime)).toEqual([]);
  expect(runtimeAuthorityMismatches(scope, mission, { ...pane, effort: 'high' }, { ...agent, effort: 'high' }, authority, runtime)).toContain('pane.effort×runtime[high != medium]');
  expect(runtimeAuthorityMismatches(scope, mission, { ...pane, model: 'other-model' }, { ...agent, requestedModel: 'other-model' }, authority, runtime)).toContain('pane.model×runtime[other-model != approved-model]');
});

describe('mission direct — operador como orquestrador', () => {
  it('F-1109: a queued proved owner that lost its physical runtime never resumes into a different delivery target', async () => {
    const scope = makeScope(), squad = makeSquad([makeAgent(), makeAgent({ id: 'ag-orch', agentName: 'Orquestrador', category: 'orchestrator' })]);
    const mission = makeApprovedMission(squad, { orchestratorSessionId: 'sess-orch-live' });
    let alive = true, resumed = 0, submitted = 0;
    const h = makeHarness({ mission, squad, workers: [], panes: [makeOrchPane()], kickoffReceipt: true,
      getRuntimeAgentSessionInfo: id => alive ? makeOrchSession({ sessionId: id }) : null,
      resumeOrchestrator: async () => { resumed++; alive = true; mission.orchestratorSessionId = 'replacement'; } });
    h.deliverSpy.mockImplementation(async () => { submitted++; return true; });
    const current = beginKickoffBriefDelivery(scope, { missionId: mission.id, orchestratorSessionId: mission.orchestratorSessionId!, intentVersion: 1,
      intentAuthorityHash: kickoffIntentAuthorityHash(mission), promptHash: 'a'.repeat(64) });
    await deliverMissionDirectInstruction(scope, h.stores, directCommand(), h.deps);
    endKickoffBriefDelivery(current, true); alive = false;
    await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, h.deps);
    expect(submitted).toBe(0); expect(resumed).toBe(0);
    expect(h.emitSpy.mock.calls.map(call => call[1]).at(-1)?.payload.deliveryState).toBe('unproven');
  });
  it.each(['blocked_user', 'blocked_technical', 'done', 'operator-closed'] as const)(
    'F-1109: a pending transport grants no direction authority to %s', async state => {
      const scope = makeScope(), squad = makeSquad([makeAgent(), makeAgent({ id: 'ag-orch', category: 'orchestrator' })]);
      const mission = makeApprovedMission(squad, { orchestratorSessionId: 'sess-orch-live' });
      const h = makeHarness({ mission, squad, workers: [], panes: [makeOrchPane()], kickoffReceipt: true,
        getRuntimeAgentSessionInfo: id => makeOrchSession({ sessionId: id }) });
      beginKickoffBriefDelivery(scope, { missionId: mission.id, orchestratorSessionId: mission.orchestratorSessionId!, intentVersion: 1,
        intentAuthorityHash: kickoffIntentAuthorityHash(mission), promptHash: 'a'.repeat(64) });
      mission.status = state === 'done' ? 'done' : 'blocked';
      mission.intentState = state === 'operator-closed' ? 'blocked_technical' : state;
      if (state === 'operator-closed') mission.description = '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador.';
      h.deliverSpy.mockImplementation(async () => { throw new Error('forbidden lifecycle transport'); });
      await expect(deliverMissionDirectInstruction(scope, h.stores, directCommand(), h.deps)).rejects.toThrow(/dispatch authority/);
      expect(peekKickoffDirects(mission.id, scope)).toEqual([]); expect(h.emitSpy.mock.calls).toEqual([]);
    });
  it.each(['new-session', 'sess-orch-live'])(
    'F-1109: proving a later attempt on %s never delivers an older attempt before its delayed failure', async nextSession => {
      const scope = makeScope(), squad = makeSquad([makeAgent(), makeAgent({ id: 'ag-orch', agentName: 'Orquestrador', category: 'orchestrator' })]);
      const mission = makeApprovedMission(squad, { orchestratorSessionId: 'sess-orch-live' });
      const h = makeHarness({ mission, squad, workers: [], panes: [makeOrchPane()], kickoffReceipt: true,
        getRuntimeAgentSessionInfo: id => makeOrchSession({ sessionId: id }) });
      const texts: string[] = [];
      h.deliverSpy.mockImplementation(async (_session: string, prompt: string) => { texts.push(prompt); return true; });
      const old = beginKickoffBriefDelivery(scope, { missionId: mission.id, orchestratorSessionId: mission.orchestratorSessionId!, intentVersion: 1,
        intentAuthorityHash: kickoffIntentAuthorityHash(mission), promptHash: 'a'.repeat(64) });
      await deliverMissionDirectInstruction(scope, h.stores, directCommand({ text: 'old-attempt-only' }), h.deps);
      const oldId = peekKickoffDirects(mission.id, scope)[0]!.directionId;
      mission.orchestratorSessionId = nextSession;
      const current = beginKickoffBriefDelivery(scope, { missionId: mission.id, orchestratorSessionId: nextSession, intentVersion: 1,
        intentAuthorityHash: kickoffIntentAuthorityHash(mission), promptHash: 'b'.repeat(64) });
      await deliverMissionDirectInstruction(scope, h.stores, directCommand({ text: 'current-attempt-only' }), h.deps);
      const newId = peekKickoffDirects(mission.id, scope).find(item => item.text === 'current-attempt-only')!.directionId;
      expect(endKickoffBriefDelivery(current, true)).toBe(true);
      await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, h.deps);
      expect(texts).toHaveLength(1); expect(texts[0]).toContain('current-attempt-only'); expect(texts[0]).not.toContain('old-attempt-only');
      await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, h.deps, { failedKickoffAttempt: old });
      const outcomes = h.emitSpy.mock.calls.map(call => call[1]).filter(event => event.payload.kind === 'operator_direction_delivery').map(event => event.payload);
      expect(outcomes).toEqual([
        { kind: 'operator_direction_delivery', directionId: oldId, deliveryState: 'unproven', reason: 'delivery_unavailable' },
        { kind: 'operator_direction_delivery', directionId: newId, deliveryState: 'delivered', reason: 'acceptance_proved' },
      ]);
    });
  it('F-1109: a pending transport queues despite the early receipt; old failure preserves new SID/intent directions', async () => {
    const scope = makeScope(), squad = makeSquad([makeAgent(), makeAgent({ id: 'ag-orch', agentName: 'Orquestrador', category: 'orchestrator' })]);
    const mission = makeApprovedMission(squad, { orchestratorSessionId: 'sess-orch-live' });
    let submitted = 0, resumed = 0;
    const h = makeHarness({ mission, squad, workers: [], panes: [makeOrchPane()], kickoffReceipt: true,
      getRuntimeAgentSessionInfo: id => makeOrchSession({ sessionId: id }), resumeOrchestrator: async () => { resumed++; } });
    h.deliverSpy.mockImplementation(async () => { submitted++; return true; });
    const old = beginKickoffBriefDelivery(scope, { missionId: mission.id, orchestratorSessionId: mission.orchestratorSessionId!,
      intentVersion: 1, intentAuthorityHash: kickoffIntentAuthorityHash(mission), promptHash: 'a'.repeat(64) });
    await deliverMissionDirectInstruction(scope, h.stores, directCommand({ text: 'old direction' }), h.deps);
    await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, h.deps);
    expect(submitted).toBe(0); expect(resumed).toBe(0);
    const oldId = peekKickoffDirects(mission.id, scope)[0]!.directionId;
    mission.orchestratorSessionId = 'new-session'; mission.intentVersion = 2;
    mission.intentContract = { ...mission.intentContract!, intentVersion: 2, goal: 'A new authorized goal' };
    const current = beginKickoffBriefDelivery(scope, { missionId: mission.id, orchestratorSessionId: 'new-session', intentVersion: 2,
      intentAuthorityHash: kickoffIntentAuthorityHash(mission), promptHash: 'b'.repeat(64) });
    await deliverMissionDirectInstruction(scope, h.stores, directCommand({ text: 'new direction' }), h.deps);
    const newId = peekKickoffDirects(mission.id, scope).find(item => item.text === 'new direction')!.directionId;
    expect(endKickoffBriefDelivery(old)).toBe(false);
    await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, h.deps, { failedKickoffAttempt: old });
    await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, h.deps, { failedKickoffAttempt: old });
    const events = h.emitSpy.mock.calls.map(call => call[1]);
    expect(events.filter(event => event.payload.kind === 'operator_direction_delivery').map(event => event.payload)).toEqual([
      { kind: 'operator_direction_delivery', directionId: oldId, deliveryState: 'unproven', reason: 'delivery_unavailable' },
    ]);
    expect(peekKickoffDirects(mission.id, scope).map(item => item.directionId)).toEqual([newId]);
    expect(pendingKickoffBriefDelivery(scope, mission.id)).toBe(current); expect(submitted).toBe(0); expect(resumed).toBe(0);
  });
  it('F-1109: a queued row from a prior intent settles unproven without reaching the new transport', async () => {
    const scope = makeScope(), squad = makeSquad([makeAgent(), makeAgent({ id: 'ag-orch', category: 'orchestrator' })]);
    const mission = makeApprovedMission(squad, { orchestratorSessionId: 'sess-orch-live' });
    const options = { mission, squad, workers: [], panes: [makeOrchPane()], kickoffReceipt: false,
      getRuntimeAgentSessionInfo: (id: string) => makeOrchSession({ sessionId: id }) };
    const h = makeHarness(options); let submitted = 0;
    h.deliverSpy.mockImplementation(async () => { submitted++; return true; });
    await deliverMissionDirectInstruction(scope, h.stores, directCommand(), h.deps);
    const id = peekKickoffDirects(mission.id, scope)[0]!.directionId;
    mission.intentContract = { ...mission.intentContract!, goal: 'Changed authorized goal' }; options.kickoffReceipt = true;
    const current = beginKickoffBriefDelivery(scope, { missionId: mission.id, orchestratorSessionId: 'sess-orch-live', intentVersion: 1,
      intentAuthorityHash: kickoffIntentAuthorityHash(mission), promptHash: 'a'.repeat(64) });
    expect(takeKickoffDirects(mission.id, scope, current.attemptId)).toEqual([]);
    endKickoffBriefDelivery(current);
    await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, h.deps);
    expect(submitted).toBe(0);
    expect(h.emitSpy.mock.calls.map(call => call[1]).at(-1)?.payload).toEqual({ kind: 'operator_direction_delivery',
      directionId: id, deliveryState: 'unproven', reason: 'delivery_unavailable' });
  });
  it.each(['proved', 'false-proof', 'timeout-after-submit', 'throw-after-submit', 'revoked-after-submit', 'rebound-after-submit', 'scope-mutated-after-submit', 'still-kicking-off'] as const)(
    'F-1105: %s settles the exact queued journal row once and refreshes the existing scoped listeners', async changed => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-direction-outcome-'));
      const manager = new ProjectRuntimeManager({ baseDir: root, appVersion: 'unit-only' });
      const scope = { ...makeScope() }, ownerScope = { ...scope }, journal = new MissionEventJournal(manager, ownerScope);
      manager.open(ownerScope).db.prepare(`INSERT INTO missions (id, title, description, status, squad_id, milestones_json, orch_session_id, created_at, updated_at)
        VALUES ('mission-1', 'fixture', '', 'pending', NULL, '[]', NULL, 1, 1)`).run();
      const passiveStore = createScopedMissionStore(manager, ownerScope);
      const before = passiveStore.get('mission-1'); let refreshedOutcomes = 0;
      const unsubscribe = passiveStore.onChange(() => {
        if (journal.replay({ missionId: 'mission-1', afterSequence: 0, limit: 20 }).some(event => event.payload.kind === 'operator_direction_delivery')) refreshedOutcomes++;
      });
      const squad = makeSquad([makeAgent(), makeAgent({ id: 'ag-orch', agentName: 'Orquestrador', category: 'orchestrator' })]);
      const mission = makeApprovedMission(squad, { orchestratorSessionId: 'sess-orch-live' });
      const options = { mission, squad, workers: [], panes: [makeOrchPane()], kickoffReceipt: false,
        getRuntimeAgentSessionInfo: (id: string) => makeOrchSession({ sessionId: id }) };
      const h = makeHarness(options);
      h.stores.missions.notifyDeliveryObservation = id => passiveStore.notifyDeliveryObservation(id);
      const deps = { ...h.deps, emitMissionEvent: (owner: ProjectExecutionScope, input: MissionEventAppendInput) => {
        expect(owner).toEqual(ownerScope); journal.append(input); return true;
      } };
      let submitted = 0;
      h.deliverSpy.mockImplementation(async () => {
        submitted++;
        if (changed === 'timeout-after-submit' || changed === 'throw-after-submit') throw new Error('raw-private-error-and-body-must-not-be-journaled');
        if (changed === 'revoked-after-submit') mission.intentState = 'blocked_technical';
        if (changed === 'rebound-after-submit') mission.orchestratorSessionId = 'replacement-session';
        if (changed === 'scope-mutated-after-submit') scope.checkoutId = 'replacement-checkout';
        return changed !== 'false-proof';
      });
      try {
        await deliverMissionDirectInstruction(scope, h.stores, directCommand(), deps);
        const admitted = journal.replay({ missionId: mission.id, afterSequence: 0, limit: 20 });
        expect(admitted).toHaveLength(1); expect(admitted[0].payload.deliveryState).toBe('queued');
        await flushQueuedKickoffDirectsForMission({ ...scope, checkoutId: 'foreign' }, h.stores, mission.id, deps);
        expect(submitted).toBe(0); expect(journal.replay({ missionId: mission.id, afterSequence: 0, limit: 20 })).toHaveLength(1);
        options.kickoffReceipt = changed !== 'still-kicking-off';
        await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, deps);
        await flushQueuedKickoffDirectsForMission(scope, h.stores, mission.id, deps);
        const recorded = journal.replay({ missionId: mission.id, afterSequence: 0, limit: 20 });
        expect(recorded).toHaveLength(2);
        expect(recorded[1].payload).toEqual({ kind: 'operator_direction_delivery', directionId: admitted[0].payload.directionId,
          deliveryState: changed === 'proved' ? 'delivered' : 'unproven', reason: changed === 'proved' ? 'acceptance_proved' : 'delivery_unavailable' });
        expect(JSON.stringify(recorded[1])).not.toContain('raw-private-error');
        expect(submitted).toBe(changed === 'still-kicking-off' ? 0 : 1);
        expect(takeKickoffDirects(mission.id, scope)).toEqual([]);
        expect(refreshedOutcomes).toBe(1); expect(passiveStore.get('mission-1')).toEqual(before);
      } finally { unsubscribe(); manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
    });
  it('F-1105: admission records queued truth with a unique Main correlation for each identical direction', async () => {
    const squad = makeSquad([makeAgent(), makeAgent({ id: 'ag-orch', agentName: 'Orquestrador', category: 'orchestrator' })]);
    const mission = makeApprovedMission(squad, { orchestratorSessionId: 'sess-orch-live' });
    const { stores, deps, emitSpy, deliverSpy } = makeHarness({ mission, squad, workers: [], panes: [makeOrchPane()], kickoffReceipt: false });
    await deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps);
    await deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps);
    const accepted = emitSpy.mock.calls.map(call => call[1]);
    expect(accepted).toHaveLength(2);
    expect(accepted[0].payload.deliveryState).toBe('queued');
    expect(accepted[0].payload.directionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(accepted[1].idempotencyKey).not.toBe(accepted[0].idempotencyKey);
    expect(takeKickoffDirects(mission.id, makeScope()).map(item => item.directionId)).toEqual(accepted.map(item => item.payload.directionId));
    expect(deliverSpy).not.toHaveBeenCalled();
  });
  it('squad sem orquestrador + worker vivo → direção aceita contra o worker', async () => {
    const squad = makeSquad();
    const mission = makeApprovedMission(squad);
    const worker = makeWorkerSession();
    const { stores, deps, deliverSpy, emitSpy } = makeHarness({
      mission,
      squad,
      workers: [worker],
      panes: [makeWorkerPane()],
    });

    await deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps);

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [sessionId, prompt] = deliverSpy.mock.calls[0] as [string, string];
    expect(sessionId).toBe('sess-worker');
    expect(prompt).toContain('directs this mission directly');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const emitted = emitSpy.mock.calls[0]?.[1] as {
      payload: { kind: string; targetAgentId: string | null };
    };
    expect(emitted.payload.kind).toBe('operator_direction');
    expect(emitted.payload.targetAgentId).toBeNull();
  });

  it('alvo nomeado da squad selada → direção chega no worker certo', async () => {
    const squad = makeSquad([makeAgent()]);
    const mission = makeApprovedMission(squad);
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane()],
    });

    await deliverMissionDirectInstruction(
      makeScope(),
      stores,
      directCommand({ targetAgentId: 'ag-exec' }),
      deps,
    );

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [sessionId, prompt] = deliverSpy.mock.calls[0] as [string, string];
    expect(sessionId).toBe('sess-worker');
    expect(prompt).toContain('selected this agent directly');
  });

  it('squad com orquestrador → comportamento atual preservado (gate de orquestrador live)', async () => {
    const squad = makeSquad();
    const mission = makeApprovedMission(squad, {
      orchestratorSessionId: 'sess-orch',
    });
    const { stores, deps } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane()],
    });

    // getRuntimeAgentSessionInfo retorna null para a sessão do orquestrador →
    // o caminho com orquestrador exige sessão live e rejeita; o branch de
    // operador-como-orquestrador NÃO foi tomado.
    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow('mission direct orchestrator session is not live');
  });

  it('targetAgentId fora da squad selada → rejeitado (autoridade de squad stale)', async () => {
    // Squad selada no contrato tem só o executor; a squad viva ganhou um
    // segundo agente depois do selo. Direcionar o novo agente é rejeitado.
    const sealedSquad = makeSquad([makeAgent()]);
    const liveSquad = makeSquad([
      makeAgent(),
      makeAgent({ id: 'ag-renegade', agentName: 'Renegade' }),
    ]);
    const mission = makeApprovedMission(sealedSquad);
    const { stores, deps } = makeHarness({
      mission,
      squad: liveSquad,
      workers: [makeWorkerSession({ agentName: 'Renegade' })],
      panes: [makeWorkerPane()],
    });

    await expect(
      deliverMissionDirectInstruction(
        makeScope(),
        stores,
        directCommand({ targetAgentId: 'ag-renegade' }),
        deps,
      ),
    ).rejects.toThrow('mission direct target squad authority is stale');
  });

  it('missão sem dispatch authority live → rejeitada', async () => {
    const squad = makeSquad();
    const mission = makeApprovedMission(squad, { status: 'pending' });
    const { stores, deps } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane()],
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow('mission direct requires live current dispatch authority');
  });

  it('split-brain running+blocked_technical é CURADO antes de recusar a orientação do operador', async () => {
    const squad = makeSquad();
    const mission = makeApprovedMission(squad, {
      status: 'running',
      intentState: 'blocked_technical',
    });
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane()],
      missionsUpdate: (_id, patch) => ({
        ...mission,
        ...patch,
        // O guard do mission-store.update normaliza o intent na reativação.
        intentState: patch.status === 'running' ? 'executing' : mission.intentState,
      }),
    });

    await deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps);
    expect(deliverSpy).toHaveBeenCalled();
  });

  it('sem worker vivo → rejeitado', async () => {
    const squad = makeSquad();
    const mission = makeApprovedMission(squad);
    const { stores, deps } = makeHarness({
      mission,
      squad,
      workers: [],
      panes: [makeWorkerPane()],
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow(
      'mission direct requires a live worker in the fast-lane squad',
    );
  });

  it('vários workers vivos sem alvo nomeado → rejeitado por ambiguidade', async () => {
    const squad = makeSquad([
      makeAgent(),
      makeAgent({ id: 'ag-2', agentName: 'Dois' }),
    ]);
    const mission = makeApprovedMission(squad);
    const { stores, deps } = makeHarness({
      mission,
      squad,
      workers: [
        makeWorkerSession(),
        makeWorkerSession({
          sessionId: 'sess-worker-2',
          paneId: 'pane-worker-2',
          agentName: 'Dois',
        }),
      ],
      panes: [
        makeWorkerPane(),
        makeWorkerPane({ id: 'pane-worker-2', paneId: 'pane-worker-2' }),
      ],
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow(
      'mission direct for a single worker is ambiguous: name the target agent',
    );
  });

  it('worker vivo fora do squad selado + direção à missão → rejeitado (gate 8 no alvo nulo)', async () => {
    // Um worker ad-hoc com CLI do roster pode estar vivo sem pertencer à squad
    // selada; a direção à missão não pode alcançá-lo (fix do security review).
    const squad = makeSquad();
    const mission = makeApprovedMission(squad);
    const { stores, deps } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession({ agentName: 'Intruso' })],
      panes: [makeWorkerPane()],
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow('mission direct worker is not in the sealed squad');
  });

  it('squad editado após o selo + direção à missão → rejeitado (hash stale)', async () => {
    const sealedSquad = makeSquad();
    const driftedSquad = makeSquad([
      makeAgent(),
      makeAgent({ id: 'ag-2', agentName: 'Dois' }),
    ]);
    const mission = makeApprovedMission(sealedSquad);
    const { stores, deps } = makeHarness({
      mission,
      squad: driftedSquad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane()],
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow('mission direct squad authority is stale');
  });

  it('pane do worker com identidade divergente → rejeitado (binding de pane)', async () => {
    // Finding 2 do security review: o binding do pane não pode ser só paneId.
    // Pane que declara agentName divergente da sessão viva é rejeitado.
    const squad = makeSquad();
    const mission = makeApprovedMission(squad);
    const { stores, deps } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane({ agentName: 'Outro' })],
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow('mission direct worker pane authority is incomplete');
  });

  it('pane do worker com identidade consistente → direção aceita', async () => {
    // O cross-check não pode ser estrito demais: pane e sessão declarando a
    // MESMA identidade (agentName + workerIncarnationId) seguem válidos.
    const squad = makeSquad();
    const mission = makeApprovedMission(squad);
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession({ workerIncarnationId: 'inc-1' })],
      panes: [makeWorkerPane({ agentName: 'Executor', workerIncarnationId: 'inc-1' })],
    });

    await deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps);

    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });

  it('squad selada com orquestrador + sessão morta sem recover → falha fechada (não desce pro worker)', async () => {
    // Finding 3 do security review: `orchestratorSessionId == null` sozinho
    // não habilita o caminho operador-como-orquestrador. Sem resume, a
    // missão SELADA exige orquestrador vivo — não redireciona ao worker.
    const squad = makeSquad([
      makeAgent(),
      makeAgent({
        id: 'ag-orch',
        agentName: 'Orquestrador',
        category: 'orchestrator',
      }),
    ]);
    const mission = makeApprovedMission(squad); // orchestratorSessionId ausente
    const { stores, deps } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane()],
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow('mission direct requires a live orchestrator session');
  });

  it('squad selada com orquestrador + sessão morta → respawna o Maestro e entrega', async () => {
    const squad = makeSquad([
      makeAgent(),
      makeAgent({
        id: 'ag-orch',
        agentName: 'Orquestrador',
        category: 'orchestrator',
      }),
    ]);
    const mission = makeApprovedMission(squad);
    const orch = makeOrchSession();
    let live = false;
    const resume = vi.fn(async () => {
      live = true;
      mission.orchestratorSessionId = orch.sessionId;
    });
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane(), makeOrchPane()],
      getRuntimeAgentSessionInfo: (sessionId) =>
        live && sessionId === orch.sessionId ? orch : null,
      resumeOrchestrator: resume,
    });

    await deliverMissionDirectInstruction(
      makeScope(),
      stores,
      directCommand(),
      deps,
    );

    expect(resume).toHaveBeenCalledTimes(1);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy.mock.calls[0]?.[0]).toBe(orch.sessionId);
  });

  it('missão pending não pede respawn do Maestro', async () => {
    const squad = makeSquad();
    const mission = makeApprovedMission(squad, { status: 'pending' });
    const resume = vi.fn(async () => {});
    const { stores, deps } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession()],
      panes: [makeWorkerPane()],
      resumeOrchestrator: resume,
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow('mission direct requires live current dispatch authority');
    expect(resume).not.toHaveBeenCalled();
  });

  it('modo livre + worker ad-hoc → direção à missão aceita (exceção ao selo)', async () => {
    // O opt-in de modo livre desacopla o worker da squad por escolha selada do
    // operador; a checagem de pertencimento não se aplica.
    const squad = makeSquad();
    const mission = makeApprovedMission(squad, {
      intentContract: makeIntentContract(
        snapshotSquadAuthority(squad).hash,
        { freeAgentChoice: true },
      ),
    });
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad,
      workers: [makeWorkerSession({ agentName: 'Ad-hoc' })],
      panes: [makeWorkerPane()],
    });

    await deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps);

    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });
});

describe('mission direct — missão da aba (sem squad, orquestrador = pane do operador)', () => {
  // isOperatorTabMission: sem squadId + workspaceBinding.adoptedPaneId. O
  // Maestro é a conversa promovida do operador — nunca houve briefing de
  // kickoff, logo o recibo nunca existirá; exigir era a falha do print.
  function operatorTabMission(overrides: Partial<Mission> = {}): Mission {
    return makeMission({
      intentContract: {
        ...makeIntentContract('hash-livre'),
        workspaceBinding: { version: 1, adoptedPaneId: 'pane-orch' },
      },
      orchestratorSessionId: 'sess-orch-live',
      ...overrides,
    });
  }

  it('Maestro da aba vivo sem recibo de kickoff → direção entregue à sessão do orquestrador', async () => {
    const mission = operatorTabMission();
    const orch = makeOrchSession({ squadId: undefined, agentName: 'Maestro' });
    const resume = vi.fn(async () => {});
    const { stores, deps, deliverSpy, emitSpy } = makeHarness({
      mission,
      squad: makeSquad(),
      workers: [],
      panes: [makeOrchPane()],
      kickoffReceipt: false,
      getRuntimeAgentSessionInfo: (sessionId) =>
        sessionId === orch.sessionId ? orch : null,
      resumeOrchestrator: resume,
    });

    await deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps);

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [sessionId, prompt] = deliverSpy.mock.calls[0] as [string, string];
    expect(sessionId).toBe('sess-orch-live');
    expect(prompt).toContain('Apply this direction to your current mission');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    // O recibo ausente NÃO é falha recuperável para a missão da aba: nada de
    // respawnar o orquestrador à toa.
    expect(resume).not.toHaveBeenCalled();
    expect(takeKickoffDirects('mission-1', makeScope())).toEqual([]);
  });

  it('Maestro da aba com sessão morta → mesma falha fechada de sempre', async () => {
    const mission = operatorTabMission({ orchestratorSessionId: 'sess-orch-morta' });
    const resume = vi.fn(async () => {});
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad: makeSquad(),
      workers: [],
      panes: [makeOrchPane()],
      kickoffReceipt: false,
      getRuntimeAgentSessionInfo: () => null,
      resumeOrchestrator: resume,
    });

    await expect(
      deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps),
    ).rejects.toThrow('mission direct orchestrator session is not live');
    expect(resume).toHaveBeenCalledTimes(1);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it('alvo pane:<paneId> de worker → entregue ao Maestro com a regra de repasse por nexus_pane_write', async () => {
    const mission = operatorTabMission();
    const orch = makeOrchSession({ squadId: undefined, agentName: 'Maestro' });
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad: makeSquad(),
      workers: [],
      panes: [
        makeOrchPane(),
        makeWorkerPane({ paneId: 'pane-helper-1', id: 'pane-helper-1', agentName: 'Auxiliar' }),
      ],
      kickoffReceipt: false,
      getRuntimeAgentSessionInfo: (sessionId) =>
        sessionId === orch.sessionId ? orch : null,
    });

    await deliverMissionDirectInstruction(
      makeScope(),
      stores,
      directCommand({ targetAgentId: 'pane:pane-helper-1' }),
      deps,
    );

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [sessionId, prompt] = deliverSpy.mock.calls[0] as [string, string];
    expect(sessionId).toBe('sess-orch-live');
    expect(prompt).toContain(
      'Route this direction to the mission helper in pane "pane-helper-1" ' +
        'with nexus_pane_write and retain orchestration authority.',
    );
  });

  it('alvo orchestrator na missão da aba → mesma regra do alvo nulo', async () => {
    const mission = operatorTabMission();
    const orch = makeOrchSession({ squadId: undefined, agentName: 'Maestro' });
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad: makeSquad(),
      workers: [],
      panes: [makeOrchPane()],
      kickoffReceipt: false,
      getRuntimeAgentSessionInfo: (sessionId) =>
        sessionId === orch.sessionId ? orch : null,
    });

    await deliverMissionDirectInstruction(
      makeScope(),
      stores,
      directCommand({ targetAgentId: 'orchestrator' }),
      deps,
    );

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliverSpy.mock.calls[0]?.[1]).toContain(
      'Apply this direction to your current mission.',
    );
  });

  it('alvo inexistente ou pane que não é worker → recusado, sem entrega', async () => {
    const mission = operatorTabMission();
    const orch = makeOrchSession({ squadId: undefined, agentName: 'Maestro' });
    const { stores, deps, deliverSpy } = makeHarness({
      mission,
      squad: makeSquad(),
      workers: [],
      panes: [
        makeOrchPane(),
        makeWorkerPane({ paneId: 'pane-helper-1', id: 'pane-helper-1' }),
      ],
      kickoffReceipt: false,
      getRuntimeAgentSessionInfo: (sessionId) =>
        sessionId === orch.sessionId ? orch : null,
    });

    await expect(
      deliverMissionDirectInstruction(
        makeScope(),
        stores,
        directCommand({ targetAgentId: 'pane:nope' }),
        deps,
      ),
    ).rejects.toThrow('mission direct target is not an agent of this mission');
    // Existe, mas é o pane do orquestrador — helper só se for role worker.
    await expect(
      deliverMissionDirectInstruction(
        makeScope(),
        stores,
        directCommand({ targetAgentId: 'pane:pane-orch' }),
        deps,
      ),
    ).rejects.toThrow('mission direct target is not an agent of this mission');
    await expect(
      deliverMissionDirectInstruction(
        makeScope(),
        stores,
        directCommand({ targetAgentId: 'qualquer-outra-coisa' }),
        deps,
      ),
    ).rejects.toThrow('mission direct target is not an agent of this mission');
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it('missão COM squad sem recibo → inalterado: enfileira no kickoff, sem erro cru', async () => {
    const squad = makeSquad([
      makeAgent(),
      makeAgent({
        id: 'ag-orch',
        agentName: 'Orquestrador',
        category: 'orchestrator',
      }),
    ]);
    const mission = makeApprovedMission(squad, {
      orchestratorSessionId: 'sess-orch-live',
    });
    const { stores, deps, deliverSpy, emitSpy } = makeHarness({
      mission,
      squad,
      workers: [],
      panes: [makeOrchPane()],
      kickoffReceipt: false,
      getRuntimeAgentSessionInfo: () => null,
    });

    await deliverMissionDirectInstruction(makeScope(), stores, directCommand(), deps);

    expect(deliverSpy).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const queued = takeKickoffDirects('mission-1', makeScope());
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toBe('Adicione uma seção hero.');
  });
});
