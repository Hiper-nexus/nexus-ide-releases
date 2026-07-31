import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  mission: null as any,
  planReceipt: null as any,
  workflowService: {
    enrichDraftFromOrientation: vi.fn(async (draft: unknown) => draft),
    freezeContract: vi.fn(() => ({
      contract: {
        contextRevision: 'context-revision-1',
        impactedSymbols: [],
        impactedDomains: [],
      },
    })),
    getMissionWorkflow: vi.fn(() => ({ contract: null, workflow: null })),
  },
  bindFreezeDraftToApprovedIntent: vi.fn((_mission: unknown, input: unknown) => input),
  drivePrevcAutopilot: vi.fn(async () => ({ stage: 'execution' })),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: vi.fn(() => ({
    missions: { get: () => mocks.mission },
    tasks: { getPlanReceipt: () => mocks.planReceipt },
    missionPanes: { list: () => [] },
  })),
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextKnowledgeService: vi.fn(),
  getContextWorkflowService: vi.fn(() => mocks.workflowService),
}));

vi.mock('./mission-freeze-authority', () => ({
  bindFreezeDraftToApprovedIntent: mocks.bindFreezeDraftToApprovedIntent,
}));

vi.mock('./prevc-autopilot-coordinator', () => ({
  drivePrevcAutopilot: mocks.drivePrevcAutopilot,
  runPrevcCouncilReview: vi.fn(),
  runPrevcFinalValidation: vi.fn(),
}));

vi.mock('./gate', () => ({
  assertOrchestratorMission: vi.fn(),
  executionScopeFor: vi.fn((ctx: any) => ctx.scope),
  getContextBySession: vi.fn(() => null),
  rotateContextRevisionAuthority: vi.fn(),
}));

import { buildContextTools } from './tools-context';

const scope = testProjectScope({ checkoutId: 'guided-prevc-ceremony' });

const ctx = {
  token: 'orchestrator-token',
  label: 'orchestrator',
  role: 'orchestrator' as const,
  sessionId: 'orchestrator-session',
  missionId: 'mission-guided',
  contextRevision: 'context-revision-a',
  scope,
  allowedTools: null,
  allowedSkills: null,
  stopAttempts: 0,
  handoffSubmitted: false,
};

function tool(name: string) {
  const found = buildContextTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function guidedMission() {
  return {
    id: 'mission-guided',
    squadId: 'saved-squad',
    intentContract: {
      version: 1,
      source: 'typed',
      goal: 'Entregar a correção guiada',
      acceptanceCriteria: ['Candidate validado'],
      risk: 'normal',
      intentVersion: 1,
      promotedPlan: { handoffId: 'handoff-plan-1' },
    },
  };
}

function legacyMission() {
  return {
    id: 'mission-guided',
    squadId: 'saved-squad',
    intentContract: {
      version: 1,
      source: 'typed',
      goal: 'Entregar a correção legada',
      acceptanceCriteria: ['Candidate validado'],
      risk: 'normal',
      intentVersion: 1,
    },
  };
}

const freezeArgs = {
  missionId: 'mission-guided',
  goal: 'Entregar a correção guiada',
  acceptanceCriteria: [{ statement: 'Candidate validado' }],
};

describe('guided Main-owned PREVC ceremony tools', () => {
  beforeEach(() => {
    mocks.mission = guidedMission();
    mocks.planReceipt = { intentVersion: 1, planHash: 'hash', tasks: [] };
    vi.clearAllMocks();
  });

  it('fails freeze fast with a clear Main-owned PREVC message', async () => {
    await expect(tool('nexus_mission_freeze_contract').handler(freezeArgs, ctx as any))
      .rejects.toThrow(/Main já é dono do PREVC desta missão/);
    expect(mocks.bindFreezeDraftToApprovedIntent).not.toHaveBeenCalled();
  });

  it('fails refreeze fast', async () => {
    await expect(
      tool('nexus_mission_refreeze_contract').handler(
        { missionId: 'mission-guided' },
        ctx as any,
      ),
    ).rejects.toThrow(/Main já é dono do PREVC desta missão/);
  });

  it('fails prepare_execution fast', async () => {
    await expect(
      tool('nexus_workflow_prepare_execution').handler(
        { missionId: 'mission-guided' },
        ctx as any,
      ),
    ).rejects.toThrow(/Main já é dono do PREVC desta missão/);
  });

  it('fails Doctor fast before starting any bootstrap flight', async () => {
    await expect(tool('nexus_context_doctor').handler({}, ctx as any))
      .rejects.toThrow(/Main já é dono do PREVC desta missão/);
  });

  it('keeps freeze working for a legacy mission without Main-owned PREVC', async () => {
    mocks.mission = legacyMission();
    mocks.planReceipt = null;

    const result = await tool('nexus_mission_freeze_contract').handler(
      freezeArgs,
      ctx as any,
    );

    expect(mocks.bindFreezeDraftToApprovedIntent).toHaveBeenCalledOnce();
    expect(mocks.workflowService.freezeContract).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ orientationEnriched: expect.anything() });
  });
});
