import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  markHandoffSubmitted: vi.fn(),
  onHandoffSubmitted: vi.fn(),
}));

vi.mock('./gate', () => ({
  assertOrchestratorMission: vi.fn(),
  markHandoffSubmitted: mocks.markHandoffSubmitted,
}));

vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: mocks.onHandoffSubmitted,
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: vi.fn(() => ({
    handoffs: { submit: mocks.submit, list: vi.fn() },
  })),
}));

import { buildDomainTools } from './tools-domain';

const scope = testProjectScope();

function context(): AgentGateContext {
  return {
    token: 'worker-token',
    label: 'worker',
    role: 'worker',
    missionId: 'mission-a',
    sessionId: 'worker-session',
    agentName: 'worker-a',
    contextRevision: 'c'.repeat(64),
    scope,
    allowedTools: [],
    allowedSkills: [],
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function handoff(
  evidenceTrust: Handoff['evidenceTrust'],
): Handoff {
  return {
    id: 'handoff-a',
    missionId: 'mission-a',
    sessionId: 'worker-session',
    fromAgent: 'worker-a',
    status: 'success',
    claimTrust: 'untrusted',
    summary: 'Worker reports that implementation is complete.',
    artifacts: [],
    evidenceIds:
      evidenceTrust === 'nexus-trusted' ? ['evidence-a'] : [],
    evidenceTrust,
    delivered: false,
    createdAt: 1,
  };
}

function submitTool() {
  const tool = buildDomainTools().find(
    (candidate) => candidate.name === 'nexus_handoff_submit',
  );
  if (!tool) throw new Error('handoff submit tool is not registered');
  return tool;
}

describe('handoff MCP stop receipt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delivers an unverified report without satisfying the stop gate', async () => {
    const submitted = handoff('unverified');
    mocks.submit.mockReturnValue(submitted);
    const ctx = context();

    const result = await submitTool().handler(
      {
        status: 'success',
        summary: submitted.summary,
        artifacts: [{ path: 'src/a.ts' }],
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      evidenceTrust: 'unverified',
      stopGateSatisfied: false,
    });
    expect(mocks.markHandoffSubmitted).not.toHaveBeenCalled();
    expect(mocks.onHandoffSubmitted).toHaveBeenCalledWith(submitted, scope);
  });

  it('satisfies the stop gate only after the store validates Nexus evidence', async () => {
    const submitted = handoff('nexus-trusted');
    mocks.submit.mockReturnValue(submitted);
    const ctx = context();

    const result = await submitTool().handler(
      {
        status: 'success',
        summary: submitted.summary,
        evidenceIds: ['evidence-a'],
      },
      ctx,
    );

    expect(result).toMatchObject({
      evidenceTrust: 'nexus-trusted',
      stopGateSatisfied: true,
    });
    expect(mocks.markHandoffSubmitted).toHaveBeenCalledWith(ctx);
  });

  it('does not mark or deliver a rejected evidence claim', async () => {
    mocks.submit.mockImplementation(() => {
      throw new Error('trusted evidence "missing" not found');
    });

    await expect(
      submitTool().handler(
        {
          status: 'success',
          summary: 'Worker reports that implementation is complete.',
          evidenceIds: ['missing'],
        },
        context(),
      ),
    ).rejects.toThrow(/trusted evidence.*not found/i);
    expect(mocks.markHandoffSubmitted).not.toHaveBeenCalled();
    expect(mocks.onHandoffSubmitted).not.toHaveBeenCalled();
  });
});
