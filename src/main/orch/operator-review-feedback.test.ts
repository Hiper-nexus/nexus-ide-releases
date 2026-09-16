import { describe, expect, it, vi } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  persistOperatorReviewFeedback,
  prepareOperatorReviewAuthorityCandidate,
} from './operator-review-feedback';
import { MissionLeadershipError, type MissionLeader } from './mission-leadership';

/** Onda 1 (religação da liderança): stub padrão — A e C concordam, provado. */
function stubResolveMissionLeader(sessionId = 'session-orch'): () => MissionLeader | null {
  return () => ({ sessionId, paneId: 'pane-orch', source: 'durable', proven: true });
}

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'install-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
};

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-a',
    title: 'Corrigir checkout',
    description: '',
    status: 'running',
    squadId: 'nexus-fullstack',
    milestones: [],
    learnings: '',
    intentState: 'executing',
    intentVersion: 3,
    intentContract: {
      version: 1,
      goal: 'Corrigir checkout',
      source: 'typed',
      contextPolicy: 'minimal',
      acceptanceCriteria: ['Testes verdes'],
      lane: 'standard',
      risk: 'normal',
      executionMode: 'autopilot',
      approvedAt: 1,
      dispatchedAt: 1,
      intentVersion: 3,
      budgets: {
        planningTokens: 10_000,
        executionTokens: 100_000,
        maxWorkers: 2,
      },
    },
    orchestratorSessionId: 'session-orch',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('operator diff review feedback', () => {
  it('persists an untrusted progress handoff and asks idle delivery to submit it', () => {
    const submitted: Array<Record<string, unknown>> = [];
    const deliver = vi.fn();
    const handoff = {
      id: 'handoff-review',
      missionId: 'mission-a',
      status: 'progress',
      summary: 'review',
      artifacts: [],
      evidenceIds: [],
      evidenceTrust: 'unverified',
      claimTrust: 'untrusted',
      authorityOrigin: 'operator-confirmed',
      delivered: false,
      deliveryState: 'queued',
      createdAt: 2,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    } satisfies Handoff & { projectId: string; checkoutId: string };
    const stores = {
        missions: { get: () => mission() },
        handoffs: {
          submitOperatorConfirmed: (input: unknown) => {
            submitted.push(input as Record<string, unknown>);
            return handoff;
          },
          get: () => handoff,
          list: () => [],
        },
      };
    const input = {
      missionId: 'mission-a',
      annotations: [
        { path: 'src/checkout.ts', line: 42, body: 'Trate o valor nulo.' },
      ],
    };
    const candidate = prepareOperatorReviewAuthorityCandidate(
      stores, scope, input, stubResolveMissionLeader(),
    );
    const result = persistOperatorReviewFeedback(
      stores,
      scope,
      input,
      candidate.fence,
      deliver,
      stubResolveMissionLeader(),
    );

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      status: 'progress',
      missionId: 'mission-a',
      fromAgent: 'Operador Nexus',
      evidenceIds: [],
    });
    expect(submitted[0]?.summary).toContain('src/checkout.ts:42');
    expect(submitted[0]?.artifacts).toEqual([
      {
        kind: 'nexus-diff-review',
        schemaVersion: 1,
        reviewId: candidate.fence,
        annotations: [
          { path: 'src/checkout.ts', line: 42, body: 'Trate o valor nulo.' },
        ],
      },
    ]);
    expect(deliver).toHaveBeenCalledWith(handoff, scope);
    expect(result).toEqual({
      ok: true,
      handoffId: 'handoff-review',
      deliveryState: 'queued',
    });
  });

  it('rejects a terminal mission and unsafe paths before persistence', () => {
    const stores = {
      missions: { get: () => mission({ status: 'done' }) },
      handoffs: {
        submitOperatorConfirmed: vi.fn(),
        get: vi.fn(),
        list: vi.fn(() => []),
      },
    };
    expect(() =>
      persistOperatorReviewFeedback(stores, scope, {
        missionId: 'mission-a',
        annotations: [{ path: 'src/a.ts', line: 1, body: 'Corrija.' }],
      }, '0'.repeat(64)),
    ).toThrow(/em execução/i);
    expect(() =>
      persistOperatorReviewFeedback(
        { ...stores, missions: { get: () => mission() } },
        scope,
        {
          missionId: 'mission-a',
          annotations: [{ path: '../secret', line: 1, body: 'Leia.' }],
        },
        '0'.repeat(64),
      ),
    ).toThrow(/caminho/i);
    expect(stores.handoffs.submitOperatorConfirmed).not.toHaveBeenCalled();
  });

  it('recusa drift da missão entre o review nativo e a gravação', () => {
    const current = mission();
    const handoffs = {
      submitOperatorConfirmed: vi.fn(),
      get: vi.fn(),
      list: vi.fn(() => []),
    };
    const stores = { missions: { get: () => current }, handoffs };
    const input = {
      missionId: current.id,
      annotations: [{ path: 'src/a.ts', line: 1, body: 'Corrija.' }],
    };
    const candidate = prepareOperatorReviewAuthorityCandidate(
      stores, scope, input, stubResolveMissionLeader(),
    );
    current.title = 'Mudou durante o modal';

    expect(() =>
      persistOperatorReviewFeedback(
        stores, scope, input, candidate.fence, undefined, stubResolveMissionLeader(),
      ),
    ).toThrow(/mudou durante a confirmação/i);
    expect(handoffs.submitOperatorConfirmed).not.toHaveBeenCalled();
  });

  it('religação onda 1: A morto (source live, proven:false) recusa mesmo com sessão durável presente', () => {
    const stores = {
      missions: { get: () => mission() },
      handoffs: { submitOperatorConfirmed: vi.fn(), get: vi.fn(), list: vi.fn(() => []) },
    };
    const input = {
      missionId: 'mission-a',
      annotations: [{ path: 'src/a.ts', line: 1, body: 'Corrija.' }],
    };
    expect(() =>
      prepareOperatorReviewAuthorityCandidate(stores, scope, input, () => ({
        sessionId: 'session-orch', paneId: 'pane-orch', source: 'live', proven: false,
      })),
    ).toThrow(/sessão atual do orquestrador/i);
    expect(stores.handoffs.submitOperatorConfirmed).not.toHaveBeenCalled();
  });

  it('religação onda 1: split-brain nunca é engolido — vira erro tipado reconhecível, sem escolher sessão por ordem de array', () => {
    const stores = {
      missions: { get: () => mission() },
      handoffs: { submitOperatorConfirmed: vi.fn(), get: vi.fn(), list: vi.fn(() => []) },
    };
    const input = {
      missionId: 'mission-a',
      annotations: [{ path: 'src/a.ts', line: 1, body: 'Corrija.' }],
    };
    expect(() =>
      prepareOperatorReviewAuthorityCandidate(stores, scope, input, () => {
        throw new MissionLeadershipError('split_brain', {
          missionId: 'mission-a', sessionIds: ['session-orch', 'session-orch-2'],
        });
      }),
    ).toThrow(/liderança da missão sem conflito \(split_brain\)/i);
    expect(stores.handoffs.submitOperatorConfirmed).not.toHaveBeenCalled();
  });
});
