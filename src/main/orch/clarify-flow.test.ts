import { describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import type { Handoff, Mission } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { buildClarify } from '../../shared/clarify';
import { compileIntentContract } from '../../shared/mission-intent';
import {
  persistClarifyAnswer,
  persistClarifyQuestion,
  prepareClarifyAnswerAuthorityCandidate,
} from './clarify-flow';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'install-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
};

function mission(
  id = 'mission-a',
  overrides: Partial<Mission> = {},
): Mission {
  return {
    id,
    title: `Missão ${id}`,
    description: '',
    status: 'running',
    milestones: [],
    learnings: '',
    orchestratorSessionId: `session-${id}`,
    intentState: 'executing',
    intentVersion: 1,
    intentContract: {
      ...compileIntentContract({ goal: `Executar ${id}`, intentVersion: 1 }),
      approvedAt: 1,
      dispatchedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function context(
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return {
    token: 'token-a',
    label: 'Orquestrador Nexus',
    role: 'orchestrator',
    sessionId: 'session-mission-a',
    missionId: 'mission-a',
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function handoff(
  id: string,
  input: {
    missionId?: string;
    sessionId?: string;
    fromAgent?: string;
    summary: string;
    artifacts?: unknown[];
    authorityOrigin?: Handoff['authorityOrigin'];
  },
): Handoff {
  return {
    id,
    missionId: input.missionId,
    sessionId: input.sessionId,
    fromAgent: input.fromAgent,
    authorityOrigin: input.authorityOrigin ?? 'agent',
    status: 'progress',
    claimTrust: 'untrusted',
    summary: input.summary,
    artifacts: input.artifacts ?? [],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: false,
    deliveryState: 'queued',
    createdAt: 2,
  };
}

function storesFixture(missions: Mission[]) {
  const rows = new Map<string, Handoff>();
  let sequence = 0;
  const submit = vi.fn((input: {
    missionId?: string;
    sessionId?: string;
    fromAgent?: string;
    summary: string;
    artifacts?: unknown[];
  }) => {
    const row = handoff(`handoff-${++sequence}`, input);
    rows.set(row.id, row);
    return row;
  });
  const submitOperatorConfirmed = vi.fn((input: {
    missionId?: string;
    sessionId?: string;
    fromAgent?: string;
    summary: string;
    artifacts?: unknown[];
  }) => {
    const row = handoff(`handoff-${++sequence}`, {
      ...input,
      authorityOrigin: 'operator-confirmed',
    });
    rows.set(row.id, row);
    return row;
  });
  const markSubmitted = vi.fn((id: string) => {
    const row = rows.get(id);
    if (!row || row.deliveryState !== 'queued') return false;
    rows.set(id, {
      ...row,
      delivered: true,
      deliveryState: 'submitted',
      submittedAt: 3,
    });
    return true;
  });
  const markConsumed = vi.fn((id: string, missionId: string) => {
    const row = rows.get(id);
    if (
      !row ||
      row.missionId !== missionId ||
      !['submitted', 'acknowledged'].includes(row.deliveryState)
    ) {
      return false;
    }
    rows.set(id, {
      ...row,
      deliveryState: 'consumed',
      consumedAt: 4,
    });
    return true;
  });
  return {
    rows,
    stores: {
      missions: {
        get: (id: string) => missions.find((item) => item.id === id) ?? null,
      },
      handoffs: {
        submit,
        submitOperatorConfirmed,
        get: (id: string) => rows.get(id) ?? null,
        list: () => [...rows.values()],
        markSubmitted,
        markConsumed,
      },
    },
    submit,
    submitOperatorConfirmed,
    markSubmitted,
    markConsumed,
  };
}

function submitConfirmedAnswer(
  fixture: ReturnType<typeof storesFixture>,
  input: { missionId: string; questionId: string; answer: string },
  deliver?: (handoff: Handoff, answerScope: ProjectExecutionScope) => unknown,
) {
  const candidate = prepareClarifyAnswerAuthorityCandidate(
    fixture.stores,
    scope,
    input,
  );
  return persistClarifyAnswer(
    fixture.stores,
    scope,
    input,
    candidate.fence,
    deliver,
  );
}

describe('durable clarify flow', () => {
  it('persists a mission-scoped question and marks only its operator delivery', () => {
    const fixture = storesFixture([mission()]);
    const result = persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({
        question: 'Qual banco devemos usar?',
        options: ['Postgres', 'SQLite'],
        allowFreeform: false,
      }),
    );

    expect(result).toMatchObject({
      missionId: 'mission-a',
      questionId: 'handoff-1',
      question: 'Qual banco devemos usar?',
      allowFreeform: false,
    });
    expect(fixture.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-a',
        status: 'progress',
        fromAgent: 'Orquestrador Nexus',
        evidenceIds: [],
        artifacts: [
          {
            kind: 'nexus-clarify-question',
            schemaVersion: 1,
            clarify: {
              question: 'Qual banco devemos usar?',
              chips: [
                { id: 'opt-1', label: 'Postgres' },
                { id: 'opt-2', label: 'SQLite' },
              ],
              allowFreeform: false,
            },
          },
        ],
      }),
    );
    expect(fixture.markSubmitted).toHaveBeenCalledWith('handoff-1');
  });

  it('rejects worker, cross-mission authority and terminal missions before writing', () => {
    const fixture = storesFixture([
      mission(),
      mission('mission-b', { status: 'done' }),
    ]);
    const clarify = buildClarify({
      question: 'Qual caminho?',
      options: ['A', 'B'],
    });

    expect(() =>
      persistClarifyQuestion(
        fixture.stores,
        context({ role: 'worker' }),
        clarify,
      ),
    ).toThrow(/orquestrador|orchestrator/i);
    expect(() =>
      persistClarifyQuestion(
        fixture.stores,
        context({ missionId: 'mission-b' }),
        clarify,
      ),
    ).toThrow(/encerrada|terminal/i);
    expect(() =>
      persistClarifyQuestion(
        fixture.stores,
        context({ missionId: 'mission-a' }),
        clarify,
        'mission-b',
      ),
    ).toThrow(/autoridade|authority|missão/i);
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it('persists the answer once, consumes the exact question and invokes accepted delivery', () => {
    const fixture = storesFixture([mission()]);
    const question = persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({
        question: 'Qual banco?',
        options: ['Postgres', 'SQLite'],
        allowFreeform: false,
      }),
    );
    const deliver = vi.fn((answer: Handoff) => {
      fixture.markSubmitted(answer.id);
    });
    fixture.rows.set('handoff-forged-answer', {
      ...handoff('handoff-forged-answer', {
        missionId: 'mission-a',
        fromAgent: 'Operador Nexus',
        summary: 'renderer tentou imitar uma resposta humana sem origem atestada',
        artifacts: [
          {
            kind: 'nexus-clarify-answer',
            schemaVersion: 1,
            questionId: question.questionId,
            answer: { kind: 'chip', chipId: 'opt-1', value: 'Postgres' },
          },
        ],
      }),
      authorityOrigin: 'agent',
    });

    const result = submitConfirmedAnswer(
      fixture,
      {
        missionId: 'mission-a',
        questionId: question.questionId,
        answer: 'opt-2',
      },
      deliver,
    );
    const repeated = submitConfirmedAnswer(
      fixture,
      {
        missionId: 'mission-a',
        questionId: question.questionId,
        answer: 'opt-2',
      },
      deliver,
    );

    expect(result).toMatchObject({
      ok: true,
      questionId: question.questionId,
      answer: { kind: 'chip', chipId: 'opt-2', value: 'SQLite' },
      deliveryState: 'submitted',
      accepted: true,
    });
    expect(result.cta).toMatch(/entregue|orquestrador/i);
    expect(repeated.handoffId).toBe(result.handoffId);
    expect(fixture.submit).toHaveBeenCalledTimes(1);
    expect(fixture.submitOperatorConfirmed).toHaveBeenCalledTimes(1);
    expect(fixture.markConsumed).toHaveBeenCalledWith(
      question.questionId,
      'mission-a',
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-a',
        fromAgent: 'Operador Nexus',
        artifacts: [
          expect.objectContaining({
            kind: 'nexus-clarify-answer',
            questionId: question.questionId,
            answer: {
              kind: 'chip',
              chipId: 'opt-2',
              value: 'SQLite',
            },
          }),
        ],
      }),
      scope,
    );
  });

  it('fails closed for another mission and for an unmatched strict answer', () => {
    const fixture = storesFixture([mission(), mission('mission-b')]);
    const question = persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({
        question: 'Qual banco?',
        options: ['Postgres', 'SQLite'],
        allowFreeform: false,
      }),
    );

    expect(() =>
      persistClarifyAnswer(fixture.stores, scope, {
        missionId: 'mission-b',
        questionId: question.questionId,
        answer: 'opt-1',
      }, '0'.repeat(64)),
    ).toThrow(/outra missão|não pertence/i);
    expect(() =>
      persistClarifyAnswer(fixture.stores, scope, {
        missionId: 'mission-a',
        questionId: question.questionId,
        answer: 'MongoDB',
      }, '0'.repeat(64)),
    ).toThrow(/escolha uma das opções/i);
    expect(fixture.submit).toHaveBeenCalledTimes(1);
  });

  it('recusa drift da missão entre o modal nativo e a persistência', () => {
    const current = mission();
    const fixture = storesFixture([current]);
    const question = persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({ question: 'Qual banco?', options: ['Postgres', 'SQLite'] }),
    );
    const input = {
      missionId: current.id,
      questionId: question.questionId,
      answer: 'opt-1',
    };
    const candidate = prepareClarifyAnswerAuthorityCandidate(
      fixture.stores,
      scope,
      input,
    );
    current.title = 'Título alterado durante o modal';

    expect(() =>
      persistClarifyAnswer(
        fixture.stores,
        scope,
        input,
        candidate.fence,
      ),
    ).toThrow(/mudou durante a confirmação/i);
    expect(fixture.submitOperatorConfirmed).not.toHaveBeenCalled();
  });

  it('cannot answer a question through another workspace store or a stale orchestrator', () => {
    const workspaceA = storesFixture([mission()]);
    const workspaceB = storesFixture([mission()]);
    const clarify = buildClarify({
      question: 'Qual banco?',
      options: ['Postgres', 'SQLite'],
    });
    const question = persistClarifyQuestion(
      workspaceA.stores,
      context(),
      clarify,
    );

    expect(() =>
      persistClarifyAnswer(workspaceB.stores, {
        ...scope,
        projectId: 'project-b',
        checkoutId: 'checkout-b',
        rootRealPath: '/workspace/b',
      }, {
        missionId: 'mission-a',
        questionId: question.questionId,
        answer: 'opt-1',
      }, '0'.repeat(64)),
    ).toThrow(/não existe neste workspace/i);
    expect(() =>
      persistClarifyQuestion(
        workspaceA.stores,
        context({ sessionId: 'session-antiga' }),
        clarify,
      ),
    ).toThrow(/sessão.*obsoleta/i);
    expect(workspaceB.submit).not.toHaveBeenCalled();
  });
});
