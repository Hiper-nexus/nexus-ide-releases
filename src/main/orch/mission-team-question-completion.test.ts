import { describe, expect, it, vi } from 'vitest';
import type { Handoff, Mission, MissionPaneSpec, Squad } from '../../shared/orch-types';
import { maybeApplyCivilianPronto } from './civilian-pronto';
import { maybeCompleteFastLaneOnDelivery } from './civilian-delivery-completion';
import { inspectTeamQuestionCompletion } from './mission-team-question-completion';
import { hashMissionIntentAuthority } from './mission-pane-authority';
import { completeVerifiedMission } from './mission-engine-production';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { testProjectScope } from './__tests__/scope-fixture';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

const scope = testProjectScope();
const squad = {
  id: 'team', name: 'Team', builtin: false, createdAt: '1', orchestratorInstructions: '',
  agents: ['Maestro', 'Codex', 'Cursor', 'DeepSeek'].map((agentName, index) => ({
    id: `agent-${index}`, agentName, category: index === 0 ? 'orchestrator' : 'executor',
    cli: 'codex', effort: 'medium', instructions: '',
  })),
} as Squad;

function mission(): Mission {
  return {
    id: 'ask-team', title: 'Pergunte aos panes quanto é 2 + 2 e consolide a resposta de cada integrante.',
    description: 'Não altere arquivos.', status: 'running', intentState: 'executing', intentVersion: 1,
    squadId: squad.id, createdAt: 1, updatedAt: 100, learnings: '', milestones: [],
    intentContract: {
      version: 1, intentVersion: 1, lane: 'consult', approvedAt: 10, dispatchedAt: 20,
      source: 'typed', acceptanceCriteria: ['Resposta identificada de cada integrante'], risk: 'normal',
      executionMode: 'assisted', contextPolicy: 'minimal', budgets: { planningTokens: 100, executionTokens: 100, maxWorkers: 3 },
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
      routingAdvice: { source: 'router', kind: 'mission-question', question: 'quanto é 2 + 2', readOnlyWorkers: true },
      goal: 'Pergunte aos panes quanto é 2 + 2.',
    },
  } as Mission;
}

function handoff(agentName = 'Maestro'): Handoff {
  return {
    id: `handoff-${agentName}`, missionId: 'ask-team', sessionId: `session-${agentName}`,
    workerIncarnationId: `generation-${agentName}`, fromAgent: agentName, authorityOrigin: 'agent',
    status: 'success', claimTrust: 'untrusted', summary: '4', artifacts: [], evidenceIds: [],
    evidenceTrust: 'unverified', delivered: true, deliveryState: 'acknowledged', createdAt: 50,
    mcpProvenance: {
      receiptId: `receipt-${agentName}`, toolCallId: `receipt-${agentName}`, toolName: 'nexus_handoff_submit',
      source: 'pty-stream', missionId: 'ask-team', sessionId: `session-${agentName}`,
      workerIncarnationId: `generation-${agentName}`, authoritySha256: 'a'.repeat(64), issuedAt: 49,
    },
  };
}

function pane(agentName: string, current = mission()): MissionPaneSpec {
  return {
    id: `spec-${agentName}`, paneId: `pane-${agentName}`, missionId: current.id,
    adapterId: 'cli', title: agentName, agentName, role: 'worker', readOnly: true,
    workerIncarnationId: `generation-${agentName}`, createdAt: 30,
    authoritySeal: {
      intentVersion: 1, intentContractHash: hashMissionIntentAuthority(current.intentContract!),
      squadRevisionHash: current.intentContract!.squadRevisionHash!, contextRevision: 'context', contractHash: 'b'.repeat(64),
    },
  };
}

function runtime(agentName: string) {
  return { paneId: `pane-${agentName}`, missionId: 'ask-team', sessionId: `session-${agentName}`, role: 'worker', agentName, state: 'idle' };
}

const targetNames = ['Codex', 'Cursor', 'DeepSeek'];

function harness(handoffs: Handoff[], names = targetNames, current = mission()) {
  const panes = names.map((name) => pane(name, current));
  const completeVerified = vi.fn((_scope, input) => {
    Object.assign(current, { status: 'done', result: input.result });
  });
  const transitionLifecycle = vi.fn((_id, _expected, patch) => {
    Object.assign(current, patch);
    return current;
  });
  const stores = {
    missions: { get: () => current, transitionLifecycle }, handoffs: { list: () => handoffs },
    missionPanes: { list: () => panes },
    tasks: { list: () => [{ id: 'only-master', status: 'done' }], listPlannedTasks: () => [], markLifecycleStatus: vi.fn() },
  } as unknown as ProjectDomainStoreSuite;
  const deps = {
    getStores: () => stores, getSquad: () => squad, listPanes: () => names.map(runtime), listProductFiles: () => ['README.md'],
    missionEngine: { completeVerified, blockUser: vi.fn() },
  };
  return { current, stores, completeVerified, transitionLifecycle, deps, panes };
}

async function pronto(handoffs: Handoff[], names = targetNames, current = mission()) {
  const state = harness(handoffs, names, current);
  return { ...state, result: await maybeApplyCivilianPronto(scope, current.id, state.deps) };
}

function inspect(handoffs: Handoff[], extra: Partial<Parameters<typeof inspectTeamQuestionCompletion>[0]> = {}) {
  const current = mission();
  return inspectTeamQuestionCompletion({
    mission: current, squad, panes: targetNames.map((name) => pane(name, current)),
    runtimePanes: targetNames.map(runtime), handoffs, ...extra,
  });
}

function complete(handoffs: Handoff[], options: { operatorOverride?: boolean; current?: Mission } = {}) {
  const state = harness(handoffs, targetNames, options.current);
  const input = {
    missionId: state.current.id, expectedStatus: 'running' as const, expectedIntentState: 'executing' as const,
    expectedUpdatedAt: 100, expectedIntentVersion: 1, learnings: '',
    result: { outcome: 'success' as const, summary: 'Master says all answered.', evidenceIds: [], artifactRefs: ['README.md'] },
    ...(options.operatorOverride ? { operatorOverride: true as const } : {}),
  };
  return { ...state, run: () => completeVerifiedMission(scope, state.stores, input, state.deps) };
}

describe('team-question automatic completion', () => {
  it('reports a fail-closed handoff before waiting for the remaining team', async () => {
    const failed = { ...handoff('Codex'), status: 'blocked' as const, summary: 'sandbox_denied: provider launch refused' };
    const first = await pronto([failed], ['Codex']);
    expect(first.result).toMatchObject({ action: 'refuse', reason: 'fail-closed', completed: false });
    expect(first.completeVerified).not.toHaveBeenCalled();
    const state = harness([failed], ['Codex']);
    const second = await maybeCompleteFastLaneOnDelivery(scope, state.current.id, {
      ...state.deps, missionEngine: { ...state.deps.missionEngine, blockUser: vi.fn() },
    });
    expect(second).toMatchObject({ action: 'refuse-fail-closed', completed: false });
    expect(state.completeVerified).not.toHaveBeenCalled();
    expect(state.stores.tasks.markLifecycleStatus).not.toHaveBeenCalled();
  });

  it('does not complete from the master alone despite a done board and a pre-existing file', async () => {
    const outcome = await pronto([handoff()], []);
    expect(outcome.result.action).toBe('wait');
    expect(outcome.current.status).toBe('running');
    expect(outcome.completeVerified).not.toHaveBeenCalled();
    expect(outcome.result.reason).toContain('(0/3)');
  });

  it('waits for the approved absent targets after only one of three has responded', async () => {
    const outcome = await pronto([handoff('Codex')], ['Codex']);
    expect(outcome.result).toMatchObject({ action: 'wait', completed: false });
    expect(outcome.result.reason).toContain('(1/3)');
    expect(outcome.result.reason).toContain('Cursor, DeepSeek');
  });

  it('accepts all three physically identified responses without attaching old files or the master claim', async () => {
    const outcome = await pronto([handoff(), ...targetNames.map((name) => handoff(name))]);
    expect(outcome.result.completed).toBe(true);
    expect(outcome.result.reason).toBe('all-workers-delivered (3/3)');
    expect(outcome.current.result?.artifactRefs).toEqual([]);
    expect(outcome.current.result?.summary).toBe('Respostas da equipe:\n- Codex: 4\n- Cursor: 4\n- DeepSeek: 4');
  });

  it.each([
    ['missing physical receipt', (h: Handoff) => ({ ...h, mcpProvenance: undefined })],
    ['synthetic author', (h: Handoff) => ({ ...h, authorityOrigin: undefined, fromAgent: 'nexus-watchdog' })],
    ['other mission', (h: Handoff) => ({ ...h, missionId: 'other-mission' })],
    ['stale incarnation', (h: Handoff) => ({ ...h, workerIncarnationId: 'old-generation' })],
    ['stale session', (h: Handoff) => ({ ...h, sessionId: 'old-session' })],
    ['stale evidence', (h: Handoff) => ({ ...h, evidenceTrust: 'stale' as const })],
    ['old receipt', (h: Handoff) => ({ ...h, mcpProvenance: { ...h.mcpProvenance!, issuedAt: 1 } })],
    ['mismatched receipt', (h: Handoff) => ({ ...h, mcpProvenance: { ...h.mcpProvenance!, workerIncarnationId: 'other-generation' } })],
    ['empty response', (h: Handoff) => ({ ...h, summary: ' ' })],
    ['partial response', (h: Handoff) => ({ ...h, status: 'partial' as const })],
  ])('rejects %s as a target response', (_label, invalid) => {
    const outcome = inspect([invalid(handoff('Codex')), handoff('Cursor'), handoff('DeepSeek')]);
    expect(outcome.ready).toBe(false);
    expect(outcome.missingTargets).toEqual(['Codex']);
  });

  it('refuses a replaced pane generation and changed approval seal', () => {
    const current = mission();
    const specs = targetNames.map((name) => pane(name, current));
    const replaced = { ...specs[0]!, workerIncarnationId: 'new-generation', createdAt: 60 };
    expect(inspect(targetNames.map((name) => handoff(name)), { panes: [...specs, replaced] }).missingTargets).toEqual(['Codex']);
    expect(inspect(targetNames.map((name) => handoff(name)), {
      panes: specs.map((spec) => ({ ...spec, authoritySeal: { ...spec.authoritySeal!, intentVersion: 2 } })),
    }).ready).toBe(false);
  });

  it('accepts durable physical responses after their panes have legitimately closed', () => {
    expect(inspect(targetNames.map((name) => handoff(name)), { runtimePanes: [] }).ready).toBe(true);
  });

  it('accepts a fast response emitted before its identical physical pane spec was persisted', () => {
    expect(inspect(targetNames.map((name) => handoff(name)), {
      panes: targetNames.map((name) => ({ ...pane(name), createdAt: 80 })),
    }).ready).toBe(true);
  });

  it('accepts an exited sessionless pane leaf using its durable incarnation receipt', () => {
    expect(inspect(targetNames.map((name) => handoff(name)), {
      runtimePanes: targetNames.map((name) => ({ ...runtime(name), sessionId: null, state: 'exited' })),
    }).ready).toBe(true);
  });

  it('rejects an active runtime with a missing session or a different mission', () => {
    for (const override of [{ sessionId: null, state: 'busy' }, { missionId: 'another-mission' }]) {
      expect(inspect(targetNames.map((name) => handoff(name)), {
        runtimePanes: targetNames.map((name) => ({ ...runtime(name), ...override })),
      }).ready).toBe(false);
    }
  });

  it('does not shrink the approved roster after the saved squad changes', () => {
    const smaller = { ...squad, agents: squad.agents.slice(0, 2) };
    expect(inspect([handoff('Codex')], { squad: smaller })).toMatchObject({ ready: false, responses: [] });
  });

  it('also protects legacy pane questions without router advice', () => {
    const current = mission();
    current.intentContract = { ...current.intentContract!, routingAdvice: undefined };
    expect(inspect([handoff()], { mission: current }).ready).toBe(false);
  });

  it('preserves ordinary single-coordinator consultations and non-ASK work', () => {
    for (const goal of ['Explique closures em JavaScript.', 'Implemente um app que pergunta aos panes.']) {
      const current = mission();
      current.title = goal;
      current.intentContract = { ...current.intentContract!, goal, routingAdvice: undefined };
      expect(inspect([], { mission: current })).toMatchObject({ applicable: false, ready: true });
    }
  });

  it('blocks the other civilian helper before any board or file advancement', async () => {
    const state = harness([handoff()], []);
    const result = await maybeCompleteFastLaneOnDelivery(scope, state.current.id, {
      ...state.deps, missionEngine: { ...state.deps.missionEngine, blockUser: vi.fn() },
    });
    expect(result).toMatchObject({ action: 'wait', completed: false, missingTargets: targetNames });
    expect(state.stores.tasks.markLifecycleStatus).not.toHaveBeenCalled();
    expect(state.completeVerified).not.toHaveBeenCalled();
  });

  it('refuses automatic done at the production boundary even if a caller bypasses civilian helpers', () => {
    const state = complete([handoff()]);
    expect(state.run).toThrow('team-question-responses-pending (0/3)');
    expect(state.current.status).toBe('running');
    expect(state.transitionLifecycle).not.toHaveBeenCalled();
  });

  it('completes at the production boundary only with all current physical responses', () => {
    const state = complete(targetNames.map((name) => handoff(name)));
    state.run();
    expect(state.current.status).toBe('done');
    expect(state.current.result?.summary).toBe('Respostas da equipe:\n- Codex: 4\n- Cursor: 4\n- DeepSeek: 4');
    expect(state.current.result?.artifactRefs).toEqual([]);
  });

  it('preserves explicit operator override completion authority', () => {
    const state = complete([], { operatorOverride: true });
    state.run();
    expect(state.current.status).toBe('done');
    expect(state.current.result?.summary).toBe('Master says all answered.');
  });

  it('keeps a normal single-coordinator consult completable at the production boundary', () => {
    const current = mission();
    current.title = 'Quanto é 2 + 2?';
    current.intentContract = { ...current.intentContract!, goal: current.title, routingAdvice: undefined };
    const state = complete([handoff()], { current });
    state.run();
    expect(state.current.status).toBe('done');
  });
});

describe('team-question observer fallback for unsealed panes (F-143)', () => {
  function unsealedPane(agentName: string, current: Mission): MissionPaneSpec {
    const spec = pane(agentName, current);
    return { ...spec, workerIncarnationId: undefined, authoritySeal: undefined };
  }

  function unsealedHarness(current: Mission) {
    return {
      mission: current,
      squad,
      panes: targetNames.map((name) => unsealedPane(name, current)),
      runtimePanes: [],
      handoffs: targetNames.map((name) => handoff(name)),
      observerPaneSessions: targetNames.map((name) => ({ paneId: `pane-${name}`, sessionId: `session-${name}` })),
    };
  }

  it('stays pending for unsealed panes without observer bindings', () => {
    const current = mission();
    const input = unsealedHarness(current);
    const outcome = inspectTeamQuestionCompletion({ ...input, observerPaneSessions: [] });
    expect(outcome).toMatchObject({ applicable: true, ready: false });
    expect(outcome.missingTargets).toEqual(targetNames);
    expect(outcome.fallbackAgents).toEqual([]);
  });

  it('consolidates real answers via observer bindings after their panes died', () => {
    const outcome = inspectTeamQuestionCompletion(unsealedHarness(mission()));
    expect(outcome).toMatchObject({ applicable: true, ready: true });
    expect(outcome.missingTargets).toEqual([]);
    expect(outcome.fallbackAgents).toEqual(targetNames);
    expect(outcome.responses.map((response) => response.agentName)).toEqual(targetNames);
  });

  it('still rejects a forged fromAgent arriving from another session', () => {
    const current = mission();
    const input = unsealedHarness(current);
    const forged = targetNames.map((name, index) => ({
      ...handoff(name),
      sessionId: `session-${targetNames[(index + 1) % targetNames.length]}`,
      mcpProvenance: {
        ...handoff(name).mcpProvenance!,
        sessionId: `session-${targetNames[(index + 1) % targetNames.length]}`,
      },
    }));
    const outcome = inspectTeamQuestionCompletion({ ...input, handoffs: forged });
    expect(outcome.ready).toBe(false);
    expect(outcome.missingTargets).toEqual(targetNames);
  });

  it('prefers the latest binding when a pane was rebound to a new session', () => {
    const current = mission();
    const input = unsealedHarness(current);
    const outcome = inspectTeamQuestionCompletion({
      ...input,
      observerPaneSessions: [
        { paneId: 'pane-Codex', sessionId: 'session-Codex-old' },
        ...input.observerPaneSessions,
      ],
    });
    expect(outcome).toMatchObject({ ready: true });
    expect(outcome.fallbackAgents).toEqual(targetNames);
  });

  it('binds a live unsealed pane through its runtime session without journal history', () => {
    const current = mission();
    const input = unsealedHarness(current);
    const outcome = inspectTeamQuestionCompletion({
      ...input,
      observerPaneSessions: [],
      runtimePanes: targetNames.map(runtime),
    });
    expect(outcome).toMatchObject({ ready: true });
    expect(outcome.fallbackAgents).toEqual(targetNames);
  });

  it('does not let the fallback rescue a sealed pane with a mismatched incarnation', () => {
    const bad = { ...handoff('Codex'), workerIncarnationId: 'other-generation' };
    const outcome = inspect([bad, handoff('Cursor'), handoff('DeepSeek')], {
      observerPaneSessions: targetNames.map((name) => ({ paneId: `pane-${name}`, sessionId: `session-${name}` })),
    });
    expect(outcome.ready).toBe(false);
    expect(outcome.missingTargets).toEqual(['Codex']);
    // Sealed panes stay on the strict path even with bindings present.
    expect(outcome.fallbackAgents).toEqual([]);
  });

  it('completes unsealed legacy panes at the production boundary via observer bindings', () => {
    const current = mission();
    const specs = targetNames.map((name) => unsealedPane(name, current));
    const stores = {
      missions: { get: () => current, transitionLifecycle: (_id: string, _e: unknown, patch: Record<string, unknown>) => Object.assign(current, patch) },
      handoffs: { list: () => targetNames.map((name) => handoff(name)) },
      missionPanes: { list: () => specs },
      tasks: { list: () => [], listPlannedTasks: () => [] },
    } as unknown as ProjectDomainStoreSuite;
    completeVerifiedMission(scope, stores, {
      missionId: current.id, expectedStatus: 'running' as const, expectedIntentState: 'executing' as const,
      expectedUpdatedAt: 100, expectedIntentVersion: 1, learnings: '',
      result: { outcome: 'success' as const, summary: 'Master says all answered.', evidenceIds: [], artifactRefs: [] },
    }, {
      getSquad: () => squad,
      listPanes: () => [],
      listObserverPaneSessions: () => targetNames.map((name) => ({ paneId: `pane-${name}`, sessionId: `session-${name}` })),
    });
    expect(current.status).toBe('done');
    expect(current.result?.summary).toBe('Respostas da equipe:\n- Codex: 4\n- Cursor: 4\n- DeepSeek: 4');
  });
});
