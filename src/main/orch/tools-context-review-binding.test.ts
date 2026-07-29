import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';
import { buildContextTools } from './tools-context';

const mocks = vi.hoisted(() => ({
  stage: 'review-primary',
  submitReview: vi.fn(),
  advance: vi.fn(),
  getPlanReceipt: vi.fn(),
  getMission: vi.fn(),
}));

vi.mock('../context/context-workflow-registry', () => ({
  getContextKnowledgeService: vi.fn(),
  getContextWorkflowService: () => ({
    getMissionWorkflow: () => ({
      contract: {},
      workflow: { stage: mocks.stage },
    }),
    submitReview: mocks.submitReview,
    advance: mocks.advance,
  }),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: { get: mocks.getMission },
    tasks: { getPlanReceipt: mocks.getPlanReceipt },
  }),
}));

const scope: ProjectExecutionScope = Object.freeze({
  version: 1,
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
});

const ctx: AgentGateContext = {
  token: 'token-a',
  label: 'codex',
  role: 'orchestrator',
  sessionId: 'session-a',
  agentName: 'orchestrator-a',
  providerId: 'codex',
  scope,
  missionId: 'mission-a',
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

describe('Main-owned pre-execution plan binding tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stage = 'review-primary';
    mocks.getMission.mockReturnValue({
      intentContract: { intentVersion: 4 },
    });
    mocks.getPlanReceipt.mockReturnValue({
      intentVersion: 4,
      planHash: 'a'.repeat(64),
    });
  });

  it('derives the review binding from the current receipt and rejects model input', async () => {
    await expect(
      tool('nexus_review_submit').handler(
        {
          missionId: 'mission-a',
          findings: [],
          preExecutionPlanBinding: {
            intentVersion: 99,
            planHash: 'f'.repeat(64),
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/unrecognized key/i);

    await tool('nexus_review_submit').handler(
      { missionId: 'mission-a', findings: [] },
      ctx,
    );

    expect(mocks.submitReview).toHaveBeenCalledWith({
      missionId: 'mission-a',
      reviewer: {
        id: 'orchestrator-a',
        sessionId: 'session-a',
        provider: 'codex',
      },
      findings: [],
      preExecutionPlanBinding: {
        intentVersion: 4,
        planHash: 'a'.repeat(64),
      },
    });
  });

  it('derives the same binding for advance while candidate stages remain Git-only', async () => {
    await tool('nexus_workflow_advance').handler(
      { missionId: 'mission-a', next: 'execution' },
      ctx,
    );
    expect(mocks.advance).toHaveBeenCalledWith(
      'mission-a',
      'execution',
      {
        preExecutionPlanBinding: {
          intentVersion: 4,
          planHash: 'a'.repeat(64),
        },
      },
    );

    vi.clearAllMocks();
    mocks.stage = 'validation-primary';
    await tool('nexus_workflow_advance').handler(
      { missionId: 'mission-a', next: 'confirmation' },
      ctx,
    );
    expect(mocks.advance).toHaveBeenCalledWith(
      'mission-a',
      'confirmation',
      {},
    );
    expect(mocks.getPlanReceipt).not.toHaveBeenCalled();
  });
});
