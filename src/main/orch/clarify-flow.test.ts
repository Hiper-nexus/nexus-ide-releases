import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import type { Handoff, Mission } from '../../shared/orch-types';
import type { MissionSnapshot } from '../../shared/mission-engine-contract';
import type { ProjectExecutionScope } from '../../shared/types';
import { buildClarify } from '../../shared/clarify';
import { compileIntentContract } from '../../shared/mission-intent';

vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: vi.fn(() => true),
}));

const missionLeaderGateMocks = vi.hoisted(() => ({
  requireMissionLeaderSession: vi.fn(
    (
      _scope: unknown,
      _missionId: string,
      ctx: { sessionId?: string | null },
    ): import('./mission-leader-gate').MissionLeaderGateResult => ({
      ok: true,
      leader: {
        sessionId: ctx.sessionId ?? 'default-leader',
        paneId: null,
        source: 'live',
        proven: true,
      },
    }),
  ),
}));
vi.mock('./mission-leader-gate', () => ({
  requireMissionLeaderSession: missionLeaderGateMocks.requireMissionLeaderSession,
}));

import { orchWriteSession } from '../pty/pty-manager';
import {
  persistClarifyAnswer,
  persistClarifyDismiss,
  persistClarifyQuestion,
  prepareClarifyAnswerAuthorityCandidate,
  resetForwardedNativeClarifyForTests,
} from './clarify-flow';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'install-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest',
};

function runningSnapshot(missionId = 'mission-a'): MissionSnapshot {
  return {
    id: missionId,
    title: `Missão ${missionId}`,
    objective: `Executar ${missionId}`,
    workspaceLabel: 'project-a/checkout-a',
    state: 'running',
    progress: { completed: 0, total: 0 },
    agents: [],
    edges: [],
    units: [],
    allowedActions: ['stop'],
    version: 1,
    updatedAt: 1,
  };
}

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
  const command = vi.fn(async () => runningSnapshot());
  return {
    rows,
    stores: {
      missions: {
        get: (id: string) => missions.find((item) => item.id === id) ?? null,
        transitionLifecycle: vi.fn(
          (
            id: string,
            _expectation: { updatedAt: number; intentVersion: number },
            patch: { status: Mission['status']; intentState: Mission['intentState'] },
          ) => {
            const current = missions.find((item) => item.id === id);
            if (!current) return null;
            current.status = patch.status;
            current.intentState = patch.intentState;
            return current;
          },
        ),
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
    missionEngine: { command },
  };
}

async function submitConfirmedAnswer(
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
    fixture.missionEngine,
  );
}

describe('durable clarify flow', () => {
  beforeEach(() => {
    resetForwardedNativeClarifyForTests();
    vi.mocked(orchWriteSession).mockClear();
  });

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

  it('persistClarifyQuestion consults the resolver, not just the raw durable field', () => {
    // The context's own sessionId still matches the mission's durable field,
    // but the resolver denies (split-brain) — proves the gate is not a
    // trivial re-comparison of the two raw fields.
    const fixture = storesFixture([mission()]);
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: 'split-brain', hint: 'duas sessões vivas reivindicam a missão',
    });

    expect(() =>
      persistClarifyQuestion(
        fixture.stores,
        context(),
        buildClarify({ question: 'Qual banco?', options: ['Postgres', 'SQLite'] }),
      ),
    ).toThrow(/sessão.*obsoleta/i);
    expect(fixture.submit).not.toHaveBeenCalled();
  });

  it('prepareClarifyAnswerAuthorityCandidate consults the resolver for the question-asker session too', () => {
    const fixture = storesFixture([mission()]);
    const question = persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({ question: 'Qual banco?', options: ['Postgres', 'SQLite'] }),
    );
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: 'split-brain', hint: 'duas sessões vivas reivindicam a missão',
    });

    expect(() =>
      prepareClarifyAnswerAuthorityCandidate(fixture.stores, scope, {
        missionId: 'mission-a',
        questionId: question.questionId,
        answer: 'opt-1',
      }),
    ).toThrow(/pergunta não pertence à sessão atual/i);
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

  it('persists the answer once, consumes the exact question and invokes accepted delivery', async () => {
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

    const result = await submitConfirmedAnswer(
      fixture,
      {
        missionId: 'mission-a',
        questionId: question.questionId,
        answer: 'opt-2',
      },
      deliver,
    );
    const repeated = await submitConfirmedAnswer(
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

  it('consumes a blocked answer once and unparks it through the engine command', async () => {
    const blocked = mission('mission-a', {
      status: 'blocked',
      intentState: 'blocked_user',
    });
    const fixture = storesFixture([blocked]);
    const question = persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({
        question: 'Qual caminho devemos seguir?',
        options: ['A', 'B'],
        allowFreeform: false,
      }),
    );
    const input = {
      missionId: blocked.id,
      questionId: question.questionId,
      answer: 'opt-1',
    };
    const command = vi.fn(async () => {
      blocked.status = 'running';
      blocked.intentState = 'executing';
      return runningSnapshot(blocked.id);
    });
    const deliver = vi.fn();
    const first = prepareClarifyAnswerAuthorityCandidate(
      fixture.stores,
      scope,
      input,
    );

    await persistClarifyAnswer(
      fixture.stores,
      scope,
      input,
      first.fence,
      deliver,
      { command },
    );
    const replay = prepareClarifyAnswerAuthorityCandidate(
      fixture.stores,
      scope,
      input,
    );
    await persistClarifyAnswer(
      fixture.stores,
      scope,
      input,
      replay.fence,
      deliver,
      { command },
    );

    expect(blocked).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(fixture.submitOperatorConfirmed).toHaveBeenCalledOnce();
    expect(fixture.markConsumed).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith(scope, {
      kind: 'answer-question',
      missionId: blocked.id,
      questionId: question.questionId,
      optionId: 'opt-1',
    });
  });

  it('fails closed for another mission and for an unmatched strict answer', async () => {
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

    await expect(
      persistClarifyAnswer(fixture.stores, scope, {
        missionId: 'mission-b',
        questionId: question.questionId,
        answer: 'opt-1',
      }, '0'.repeat(64), undefined, fixture.missionEngine),
    ).rejects.toThrow(/outra missão|não pertence/i);
    await expect(
      persistClarifyAnswer(fixture.stores, scope, {
        missionId: 'mission-a',
        questionId: question.questionId,
        answer: 'MongoDB',
      }, '0'.repeat(64), undefined, fixture.missionEngine),
    ).rejects.toThrow(/escolha uma das opções/i);
    expect(fixture.submit).toHaveBeenCalledTimes(1);
  });

  it('recusa drift da missão entre o modal nativo e a persistência', async () => {
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

    await expect(
      persistClarifyAnswer(
        fixture.stores,
        scope,
        input,
        candidate.fence,
        undefined,
        fixture.missionEngine,
      ),
    ).rejects.toThrow(/mudou durante a confirmação/i);
    expect(fixture.submitOperatorConfirmed).not.toHaveBeenCalled();
  });

  it('cannot answer a question through another workspace store or a stale orchestrator', async () => {
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

    await expect(
      persistClarifyAnswer(workspaceB.stores, {
        ...scope,
        projectId: 'project-b',
        checkoutId: 'checkout-b',
        rootRealPath: '/workspace/b',
      }, {
        missionId: 'mission-a',
        questionId: question.questionId,
        answer: 'opt-1',
      }, '0'.repeat(64), undefined, workspaceB.missionEngine),
    ).rejects.toThrow(/não existe neste workspace/i);
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: 'stale-session', hint: 'outra sessão assumiu a missão',
    });
    expect(() =>
      persistClarifyQuestion(
        workspaceA.stores,
        context({ sessionId: 'session-antiga' }),
        clarify,
      ),
    ).toThrow(/sessão.*obsoleta/i);
    expect(workspaceB.submit).not.toHaveBeenCalled();
  });

  it('repassa a pergunta ao seletor nativo da CLI uma vez', () => {
    vi.mocked(orchWriteSession).mockClear();
    const fixture = storesFixture([mission()]);
    persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({
        question: 'Qual banco?',
        options: ['Postgres', 'SQLite'],
      }),
    );
    expect(orchWriteSession).toHaveBeenCalledOnce();
    expect(String(vi.mocked(orchWriteSession).mock.calls[0]?.[1])).toContain(
      '[NEXUS_CLARIFY]',
    );
    persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({
        question: 'Qual banco?',
        options: ['Postgres', 'SQLite'],
      }),
    );
    expect(orchWriteSession).toHaveBeenCalledOnce();
    expect(fixture.submit).toHaveBeenCalledOnce();
  });

  it('agora não consome sem entregar resposta vazia e não reabre', async () => {
    const blocked = mission('mission-a', {
      status: 'blocked',
      intentState: 'blocked_user',
    });
    const fixture = storesFixture([blocked]);
    const question = persistClarifyQuestion(
      fixture.stores,
      context(),
      buildClarify({
        question: 'Qual caminho?',
        options: ['A', 'B'],
        allowFreeform: false,
      }),
    );
    const deliver = vi.fn();
    const first = await persistClarifyDismiss(
      fixture.stores,
      scope,
      {
        missionId: blocked.id,
        questionId: question.questionId,
        dismiss: true,
      },
      fixture.missionEngine,
    );
    const replay = await persistClarifyDismiss(
      fixture.stores,
      scope,
      {
        missionId: blocked.id,
        questionId: question.questionId,
        dismiss: true,
      },
      fixture.missionEngine,
    );

    expect(first).toMatchObject({
      ok: true,
      dismissed: true,
      questionId: question.questionId,
    });
    expect(first.cta).toMatch(/adiada|agora não/i);
    expect(replay.handoffId).toBe(first.handoffId);
    expect(fixture.markConsumed).toHaveBeenCalledWith(
      question.questionId,
      blocked.id,
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(fixture.missionEngine.command).not.toHaveBeenCalled();
    expect(blocked).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(
      persistClarifyQuestion(
        fixture.stores,
        context(),
        buildClarify({
          question: 'Qual caminho?',
          options: ['A', 'B'],
          allowFreeform: false,
        }),
      ).questionId,
    ).toBe(question.questionId);
  });
});
