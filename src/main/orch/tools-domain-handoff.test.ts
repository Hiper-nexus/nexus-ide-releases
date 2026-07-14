import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  markHandoffSubmitted: vi.fn(),
  onHandoffSubmitted: vi.fn(),
  getStores: vi.fn(),
}));

vi.mock('./gate', () => ({
  assertOrchestratorMission: vi.fn(),
  markHandoffSubmitted: mocks.markHandoffSubmitted,
}));

vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: mocks.onHandoffSubmitted,
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: mocks.getStores,
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
    deliveryState: 'queued',
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStores.mockReturnValue({
      missions: {
        get: () => ({
          id: 'mission-a',
          title: 'Mission',
          description: 'Authorized work',
          status: 'running',
          milestones: [],
          learnings: '',
          intentState: 'dispatched',
          intentVersion: 1,
          intentContract: {
            version: 1,
            source: 'typed',
            goal: 'Authorized work',
            acceptanceCriteria: ['Done'],
            risk: 'normal',
            executionMode: 'assisted',
            contextPolicy: 'on-demand',
            intentVersion: 1,
            approvedAt: 1,
            budgets: {
              planningTokens: 1_200,
              executionTokens: 8_000,
              maxWorkers: 2,
            },
          },
          createdAt: 1,
          updatedAt: 1,
        }),
      },
      tasks: { list: () => [] },
      missionPanes: { list: () => [] },
      handoffs: { submit: mocks.submit, list: vi.fn() },
    });
  });

  it('fails closed when mission authority cannot be loaded', async () => {
    mocks.getStores.mockImplementationOnce(() => {
      throw new Error('database at /private/runtime.sqlite failed');
    });

    await expect(
      submitTool().handler(
        {
          status: 'success',
          summary: 'Worker reports that implementation is complete.',
        },
        context(),
      ),
    ).rejects.toThrow('handoff_origin: mission authority unavailable');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

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

  it('returns the dedicated Pet Studio package validation result to the maker', async () => {
    const submitted = handoff('unverified');
    mocks.submit.mockReturnValue(submitted);
    mocks.onHandoffSubmitted.mockReturnValue({
      handled: true,
      completed: false,
      error: 'inclua o caminho absoluto de pet.json',
    });

    const result = await submitTool().handler(
      { status: 'success', summary: submitted.summary },
      context(),
    );

    expect(result).toMatchObject({
      petStudioCompletion: {
        handled: true,
        completed: false,
        error: 'inclua o caminho absoluto de pet.json',
      },
    });
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
