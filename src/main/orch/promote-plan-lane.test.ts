import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { WebContents } from 'electron';
import type { Squad } from '../../shared/orch-types';
import { compileIntentContract } from '../../shared/mission-intent';

const storeState = vi.hoisted(() => {
  const missions = new Map<string, Record<string, unknown>>();
  return {
    missions,
    update: vi.fn((id: string, patch: Record<string, unknown>) => {
      const cur = missions.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      missions.set(id, next);
      return next;
    }),
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

describe('promotePlanLaneFromRenderer', () => {
  beforeEach(() => {
    storeState.missions.clear();
    storeState.update.mockClear();
  });

  function authority() {
    const registry = {
      forScope: () => ({
        missions: {
          get: (id: string) => storeState.get(id),
          update: storeState.update,
          list: () => [...storeState.missions.values()],
        },
      }),
    };
    const squad: Squad = {
      id: 'navalha',
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
      () => squad,
      () => ({
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-a',
        effort: 'high',
        readOnly: false,
        nativeReadOnly: true,
      }),
    );
  }

  it('promotes plan → standard and expands budgets', () => {
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
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: {
        ...contract,
        approvedAt: 100,
        dispatchedAt: 100,
      },
      createdAt: 1,
      updatedAt: 1,
      squadId: 'navalha',
    });

    const auth = authority();
    const owner = {} as WebContents;
    const updated = auth.promotePlanLaneFromRenderer(owner, {
      missionId: 'm-plan',
    });

    expect(updated.intentContract?.lane).toBe('standard');
    expect(updated.intentVersion).toBe(2);
    expect(updated.intentContract?.budgets.maxWorkers).toBeGreaterThan(0);
    expect(updated.intentState).toBe('dispatched');
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
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: { ...contract, approvedAt: 100, dispatchedAt: 100 },
      createdAt: 1,
      updatedAt: 1,
      squadId: 'navalha',
    });
    const auth = authority();
    const owner = {} as WebContents;
    const candidate = auth.planPromotionCandidateFromRenderer(owner, {
      missionId: 'm-plan',
    });

    storeState.missions.set('m-plan', {
      ...storeState.missions.get('m-plan')!,
      intentVersion: 2,
      intentContract: { ...contract, intentVersion: 2, goal: 'Plano trocado' },
    });
    expect(() =>
      auth.promotePlanLaneFromRenderer(
        owner,
        { missionId: 'm-plan' },
        candidate.fence,
      ),
    ).toThrow(/promotion.*stale|intent.*changed/i);
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
      auth.promotePlanLaneFromRenderer({} as WebContents, { missionId: 'm1' }),
    ).toThrow(/not in plan lane/i);
  });
});
