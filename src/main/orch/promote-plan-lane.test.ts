import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WebContents } from 'electron';
import type { Handoff, Squad } from '../../shared/orch-types';
import { compileIntentContract } from '../../shared/mission-intent';
import {
  NEXUS_PLAN_SQUAD_ID,
  NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
} from '../../shared/builtin-squad-ids';

const storeState = vi.hoisted(() => {
  const missions = new Map<string, Record<string, unknown>>();
  const handoffs = new Map<string, Handoff>();
  return {
    missions,
    handoffs,
    update: vi.fn((id: string, patch: Record<string, unknown>) => {
      const cur = missions.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      missions.set(id, next);
      return next;
    }),
    commitPlanPromotionRevision: vi.fn(
      (
        id: string,
        _expected: Record<string, unknown>,
        squadId: string,
        intentContract: Record<string, unknown>,
      ) => {
        const cur = missions.get(id);
        if (!cur) throw new Error('mission not found');
        const next = {
          ...cur,
          squadId,
          status: 'pending',
          intentState: 'ready_to_start',
          intentVersion: intentContract.intentVersion,
          intentContract,
        };
        missions.set(id, next);
        return next;
      },
    ),
    get: (id: string) => missions.get(id) ?? null,
  };
});

vi.mock('./mission-prompt-queue-registry', () => ({
  bumpMissionPromptIntent: vi.fn(),
  cancelMissionPrompt: vi.fn(),
  completeMissionPrompt: vi.fn(),
  enqueueMissionPrompt: vi.fn(),
  getMissionPromptAbortSignal: vi.fn(),
  peekMissionPromptQueue: vi.fn(() => ({ executing: null, queued: [] })),
  startMissionPrompt: vi.fn(),
}));

vi.mock('./mission-intent-events', () => ({
  emitMissionIntentEvent: vi.fn(),
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  requireRendererWorkspaceScope: () => ({
    version: 1,
    installationId: 'inst',
    projectId: 'p',
    checkoutId: 'c',
    rootRealPath: '/tmp/repo',
  }),
}));

vi.mock('../pty/pty-manager', () => ({
  bindOwnedAgentSessionMission: vi.fn(),
  consumeMissionOrchestratorGrant: vi.fn(),
  getOwnedAgentSessionInfo: vi.fn(),
  hasMissionOrchestratorGrant: vi.fn(),
  rollbackOwnedAgentSessionMission: vi.fn(),
}));

vi.mock('./gate', () => ({
  getContextBySession: vi.fn(),
  restoreSessionAuthority: vi.fn(),
  rollbackSessionAuthorityMission: vi.fn(),
}));

vi.mock('./pane-registry', () => ({
  attachOrchMeta: vi.fn(),
  findPaneOwnedBy: vi.fn(),
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextWorkflowService: vi.fn(() => ({
    getMissionWorkflow: () => ({ contract: null }),
  })),
}));

vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: () => ({ intentFirstMissionRuntimeV1: true }),
}));

vi.mock('../context/orientation/orientation-service', () => ({
  tryGetProjectOrientationService: () => null,
}));

import { RendererMissionAuthority } from './renderer-mission-authority';
import { BUILTIN_SQUADS } from './builtin-squads';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { missionRequiresGuidedPrevc } from './guided-mission-authority';

describe('promotePlanLaneFromRenderer', () => {
  beforeEach(() => {
    storeState.missions.clear();
    storeState.handoffs.clear();
    storeState.update.mockClear();
    storeState.commitPlanPromotionRevision.mockClear();
  });

  function physicalPlanHandoff(
    missionId = 'm-plan',
    sessionId = 'plan-session-v1',
  ): Handoff {
    return {
      id: 'handoff-plan-v1',
      missionId,
      sessionId,
      fromAgent: 'Maestro',
      authorityOrigin: 'agent',
      mcpProvenance: {
        receiptId: 'receipt-plan-v1',
        toolCallId: 'tool-plan-v1',
        toolName: 'nexus_handoff_submit',
        source: 'http-mcp',
        missionId,
        sessionId,
        authoritySha256: 'a'.repeat(64),
        issuedAt: 20,
      },
      status: 'success',
      claimTrust: 'untrusted',
      summary: '# PRD Auth\nImplementar sessões seguras e rotação de token.',
      artifacts: [{ path: 'plan.md', kind: 'prd' }],
      evidenceIds: [],
      evidenceTrust: 'unverified',
      delivered: true,
      deliveryState: 'submitted',
      submittedAt: 21,
      createdAt: 20,
    };
  }

  function authority(
    assertStandardSquadReadiness: (squad: Squad) => void = () => undefined,
    squadId = 'navalha',
    extraSquads: readonly Squad[] = [],
  ) {
    const registry = {
      forScope: () => ({
        missions: {
          get: (id: string) => storeState.get(id),
          update: storeState.update,
          commitPlanPromotionRevision:
            storeState.commitPlanPromotionRevision,
          list: () => [...storeState.missions.values()],
        },
        handoffs: {
          list: ({ missionId }: { missionId: string }) =>
            [...storeState.handoffs.values()].filter(
              (handoff) => handoff.missionId === missionId,
            ),
          get: (id: string) => storeState.handoffs.get(id) ?? null,
        },
      }),
    };
    const squad: Squad = {
      id: squadId,
      name: 'Navalha',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: '## Política\nExecute o plano aprovado.',
      agents: [
        {
          id: 'orch',
          agentName: 'Maestro',
          category: 'orchestrator',
          cli: 'codex',
          allowedTools: ['nexus_task'],
          allowedSkills: [],
        },
      ],
    };
    return new RendererMissionAuthority(
      registry as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (requestedId) =>
        [...extraSquads, squad].find(
          (candidate) => candidate.id === requestedId,
        ) ?? null,
      (_resolvedSquad, orchestrator) => ({
        adapterId: orchestrator.cli,
        model: orchestrator.model ?? 'provider-default',
        accountId: 'account-a',
        effort: 'high',
        readOnly: false,
        nativeReadOnly: true,
      }),
      undefined,
      undefined,
      assertStandardSquadReadiness,
      (source) => source,
    );
  }

  it('promotes the exact physical plan → standard and expands budgets', () => {
    const contract = compileIntentContract({
      goal: 'Desenhar auth e depois implementar',
      intentVersion: 1,
      lane: 'plan',
    });
    storeState.missions.set('m-plan', {
      id: 'm-plan',
      title: 'Auth plan',
      description: contract.goal,
      status: 'running',
      milestones: [],
      learnings: '',
      intentState: 'executing',
      intentVersion: 1,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
      },
      createdAt: 1,
      updatedAt: 1,
      squadId: 'agentic-navalha',
      orchestratorSessionId: 'plan-session-v1',
    });
    const exactPlanSummary = [
      '# PRD Auth completo',
      'Arquitetura, critérios e stories aprovadas.',
      'x'.repeat(6_000),
    ].join('\n');
    const handoff = {
      ...physicalPlanHandoff(),
      summary: exactPlanSummary,
    };
    storeState.handoffs.set(handoff.id, handoff);

    const assertStandardSquadReadiness = vi.fn();
    const auth = authority(
      assertStandardSquadReadiness,
      'agentic-navalha',
    );
    const owner = {} as WebContents;
    const candidate = auth.planPromotionCandidateFromRenderer(owner, {
      missionId: 'm-plan',
    });
    storeState.missions.set('m-plan', {
      ...storeState.missions.get('m-plan')!,
      orchestratorSessionId: undefined,
    });
    const detachedCandidate =
      auth.planPromotionCandidateAfterTeardownFromMain(
        owner,
        { missionId: 'm-plan' },
        candidate.promotedPlan!,
      );
    const updated = auth.promotePlanLaneFromRenderer(
      owner,
      { missionId: 'm-plan' },
      detachedCandidate.fence,
      detachedCandidate.promotedPlan!,
    );

    expect(updated.intentContract?.lane).toBe('standard');
    expect(candidate.squad.id).toBe('agentic-navalha');
    expect(updated.squadId).toBe('agentic-navalha');
    expect(updated.intentVersion).toBe(2);
    expect(updated.intentContract?.budgets.maxWorkers).toBeGreaterThan(0);
    expect(updated.intentState).toBe('ready_to_start');
    expect(updated.intentContract?.promotedPlan).toMatchObject({
      handoffId: handoff.id,
      summary: handoff.summary,
      artifacts: handoff.artifacts,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(assertStandardSquadReadiness).toHaveBeenCalledTimes(4);
  });

  it('promove o snapshot do atalho Planejar · PRD para o squad builtin de execução revisado', () => {
    const planTemplate = BUILTIN_SQUADS.find(
      (squad) => squad.id === NEXUS_PLAN_SQUAD_ID,
    );
    const executionTarget = BUILTIN_SQUADS.find(
      (squad) => squad.id === NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
    );
    if (!planTemplate || !executionTarget) {
      throw new Error('missing plan/delivery builtin squads');
    }
    const runtimePlan: Squad = {
      ...planTemplate,
      id: 'mission-runtime-123e4567-e89b-42d3-a456-426614174000',
      builtin: false,
      runtimeSourceSquadId: planTemplate.id,
      runtimeSourceSquadRevisionHash:
        snapshotSquadAuthority(planTemplate).hash,
      agents: planTemplate.agents.map((agent) => ({ ...agent })),
    };
    const contract = compileIntentContract({
      goal: 'Planejar e entregar autenticação segura',
      acceptanceCriteria: ['Implementação segue as stories aprovadas'],
      intentVersion: 1,
      lane: 'plan',
    });
    storeState.missions.set('m-plan', {
      id: 'm-plan',
      title: 'Planejar autenticação',
      description: contract.goal,
      status: 'running',
      milestones: [],
      learnings: '',
      intentState: 'executing',
      intentVersion: 1,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
      },
      createdAt: 1,
      updatedAt: 1,
      squadId: runtimePlan.id,
      orchestratorSessionId: 'plan-session-v1',
    });
    const exactPlanSummary = [
      '# PRD Auth completo',
      'Arquitetura, critérios e stories aprovadas.',
      'x'.repeat(6_000),
    ].join('\n');
    const handoff = {
      ...physicalPlanHandoff(),
      summary: exactPlanSummary,
    };
    storeState.handoffs.set(handoff.id, handoff);
    const unavailable = authority(
      () => {
        throw new Error(
          'guided_runtime_unavailable: worker Codex qualificado ausente',
        );
      },
      runtimePlan.id,
      [runtimePlan, executionTarget],
    );
    const owner = {} as WebContents;
    expect(() =>
      unavailable.planPromotionCandidateFromRenderer(owner, {
        missionId: 'm-plan',
      }),
    ).toThrow(/worker codex qualificado ausente/i);

    const assertStandardSquadReadiness = vi.fn();
    const auth = authority(
      assertStandardSquadReadiness,
      runtimePlan.id,
      [runtimePlan, executionTarget],
    );

    const promoteChoice = {
      missionId: 'm-plan',
      orchestrationMode: 'pack' as const,
      wavePackTemplateId: 'fix' as const,
    };
    const candidate = auth.planPromotionCandidateFromRenderer(
      owner,
      promoteChoice,
    );

    expect(candidate.squad).toMatchObject({
      id: NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
      name: executionTarget.name,
      hash: snapshotSquadAuthority(executionTarget).hash,
    });
    expect(candidate.orchestrationMode).toBe('pack');
    expect(candidate.wavePackTemplateId).toBe('fix');
    expect(candidate.wavePackStoryCount).toBe(2);
    expect(
      candidate.squad.agents
        .filter((agent) => agent.category !== 'orchestrator')
        .map((agent) => agent.cli),
    ).toEqual(['codex', 'codex', 'codex', 'codex']);
    expect(candidate.squad.orchestratorInstructions).toMatch(
      /entrada física da promoção/i,
    );
    expect(candidate.orchestratorRuntime.adapterId).toBe(
      executionTarget.agents.find(
        (agent) => agent.category === 'orchestrator',
      )?.cli,
    );

    storeState.missions.set('m-plan', {
      ...storeState.missions.get('m-plan')!,
      orchestratorSessionId: undefined,
    });
    const detached =
      auth.planPromotionCandidateAfterTeardownFromMain(
        owner,
        promoteChoice,
        candidate.promotedPlan!,
      );
    expect(detached.squad.hash).toBe(candidate.squad.hash);
    expect(detached.orchestratorRuntime).toEqual(
      candidate.orchestratorRuntime,
    );
    expect(detached.orchestrationMode).toBe('pack');
    expect(detached.wavePackStoryCount).toBe(2);

    const promoted = auth.promotePlanLaneFromRenderer(
      owner,
      promoteChoice,
      detached.fence,
      detached.promotedPlan!,
    );

    expect(promoted.squadId).toBe(NEXUS_STORY_IMPLEMENTATION_SQUAD_ID);
    expect(promoted.intentContract).toMatchObject({
      lane: 'standard',
      orchestrationMode: 'pack',
      wavePackTemplateId: 'fix',
      squadRevisionHash: snapshotSquadAuthority(executionTarget).hash,
      orchestratorRuntime: candidate.orchestratorRuntime,
      promotedPlan: {
        handoffId: handoff.id,
        summary: exactPlanSummary,
        artifacts: handoff.artifacts,
      },
    });
    expect(promoted.intentContract?.wavePackStories).toHaveLength(2);
    expect(missionRequiresGuidedPrevc(promoted)).toBe(false);
    expect(
      missionRequiresGuidedPrevc(promoted, undefined, {
        enforcePrevcOnNormalRisk: true,
      }),
    ).toBe(true);
    expect(storeState.get('m-plan')?.squadId).toBe(
      NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
    );
    expect(
      missionRequiresGuidedPrevc(
        storeState.get('m-plan') as Parameters<
          typeof missionRequiresGuidedPrevc
        >[0],
      ),
    ).toBe(false);
    expect(assertStandardSquadReadiness).toHaveBeenCalledTimes(4);
    expect(assertStandardSquadReadiness).toHaveBeenCalledWith(
      executionTarget,
    );
  });

  it('rejects a promotion when the plan changes while native confirmation is open', () => {
    const contract = compileIntentContract({
      goal: 'Desenhar auth e depois implementar',
      intentVersion: 1,
      lane: 'plan',
    });
    storeState.missions.set('m-plan', {
      id: 'm-plan',
      title: 'Auth plan',
      description: contract.goal,
      status: 'running',
      milestones: [],
      learnings: '',
      intentState: 'executing',
      intentVersion: 1,
      intentContract: {
        ...contract,
        approvedAt: 10,
        dispatchedAt: 10,
      },
      createdAt: 1,
      updatedAt: 1,
      squadId: 'navalha',
      orchestratorSessionId: 'plan-session-v1',
    });
    const handoff = physicalPlanHandoff();
    storeState.handoffs.set(handoff.id, handoff);
    const auth = authority();
    const owner = {} as WebContents;
    const candidate = auth.planPromotionCandidateFromRenderer(owner, {
      missionId: 'm-plan',
    });

    storeState.missions.set('m-plan', {
      ...storeState.missions.get('m-plan')!,
      orchestratorSessionId: undefined,
      intentVersion: 2,
      intentContract: { ...contract, intentVersion: 2, goal: 'Plano trocado' },
    });
    expect(() =>
      auth.promotePlanLaneFromRenderer(
        owner,
        { missionId: 'm-plan' },
        candidate.fence,
        candidate.promotedPlan!,
      ),
    ).toThrow(/plan_handoff_stale|promotion.*stale|intent.*changed/i);
    expect(storeState.update).not.toHaveBeenCalled();
  });

  it('rejects non-plan missions', () => {
    const contract = compileIntentContract({
      goal: 'Código normal',
      intentVersion: 1,
      lane: 'standard',
    });
    storeState.missions.set('m1', {
      id: 'm1',
      title: 'Std',
      description: contract.goal,
      status: 'running',
      milestones: [],
      learnings: '',
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: contract,
      createdAt: 1,
      updatedAt: 1,
      squadId: 'navalha',
    });
    const auth = authority();
    expect(() =>
      auth.promotePlanLaneFromRenderer(
        {} as WebContents,
        { missionId: 'm1' },
        'not-used-for-non-plan',
        {} as never,
      ),
    ).toThrow(/not in plan lane/i);
  });
});
