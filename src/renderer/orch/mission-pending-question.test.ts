import { describe, expect, it } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import {
  missionIdsAwaitingAnswer,
  pendingMissionQuestions,
} from './mission-pending-question';

function mission(
  id: string,
  status: Mission['status'] = 'running',
  title = `Missão ${id}`,
  intentState?: Mission['intentState'],
): Mission {
  return {
    id,
    title,
    description: '',
    status,
    milestones: [],
    learnings: '',
    orchestratorSessionId: `session-${id}`,
    ...(intentState === undefined ? {} : { intentState }),
    createdAt: 1,
    updatedAt: 1,
  };
}

function questionHandoff(
  id: string,
  missionId: string,
  createdAt: number,
  deliveryState: Handoff['deliveryState'] = 'submitted',
): Handoff {
  return {
    id,
    missionId,
    sessionId: `session-${missionId}`,
    fromAgent: 'Orquestrador Nexus',
    status: 'progress',
    claimTrust: 'untrusted',
    summary: 'Pergunta ao operador',
    artifacts: [
      {
        kind: 'nexus-clarify-question',
        schemaVersion: 1,
        clarify: {
          question: `Pergunta ${id}?`,
          chips: [
            { id: 'opt-1', label: 'Sim' },
            { id: 'opt-2', label: 'Não' },
          ],
          allowFreeform: true,
        },
      },
    ],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState,
    createdAt,
  };
}

describe('pendingMissionQuestions', () => {
  // running + blocked_user (worker pediu decisão). blocked_technical / done /
  // pending não respondem chip — o main recusaria ou o próximo passo é outro.
  it('só pergunta de missão executável (running ou blocked_user), com título', () => {
    const questions = pendingMissionQuestions(
      [
        mission('m-run', 'running', 'Entrega API'),
        mission('m-block-user', 'blocked', 'Story 1.4', 'blocked_user'),
        mission('m-block-tech', 'blocked', 'Crash técnico', 'blocked_technical'),
        mission('m-pending', 'pending', 'Na fila'),
        mission('m-done', 'done', 'Já fechada'),
      ],
      [
        questionHandoff('q-run', 'm-run', 10),
        questionHandoff('q-block-user', 'm-block-user', 5),
        questionHandoff('q-block-tech', 'm-block-tech', 4),
        questionHandoff('q-pending', 'm-pending', 3),
        questionHandoff('q-done', 'm-done', 1),
      ],
    );

    expect(questions.map((q) => q.questionId)).toEqual([
      'q-block-user',
      'q-run',
    ]);
    expect(questions[0]).toMatchObject({
      missionId: 'm-block-user',
      missionTitle: 'Story 1.4',
    });
    expect(questions[1]).toMatchObject({
      missionId: 'm-run',
      missionTitle: 'Entrega API',
      question: 'Pergunta q-run?',
    });
  });

  it('drops answered, consumed, and foreign-session questions', () => {
    const answer: Handoff = {
      ...questionHandoff('answer-q1', 'm1', 20),
      sessionId: undefined,
      fromAgent: 'Operador Nexus',
      artifacts: [
        {
          kind: 'nexus-clarify-answer',
          schemaVersion: 1,
          questionId: 'q1',
          answer: { kind: 'chip', chipId: 'opt-1', value: 'Sim' },
        },
      ],
    };
    const questions = pendingMissionQuestions(
      [mission('m1')],
      [
        questionHandoff('q1', 'm1', 1),
        answer,
        questionHandoff('q2', 'm1', 2, 'consumed'),
        {
          ...questionHandoff('q3', 'm1', 3),
          sessionId: 'other-session',
        },
      ],
    );
    expect(questions).toEqual([]);
  });
});

describe('missionIdsAwaitingAnswer', () => {
  it('só devolve missão em execução com pergunta aberta', () => {
    const ids = missionIdsAwaitingAnswer(
      [mission('a'), mission('b'), mission('c', 'pending')],
      [
        questionHandoff('q-a', 'a', 1),
        questionHandoff('q-c', 'c', 2),
      ],
    );
    // 'b' não tem pergunta; 'c' tem, mas está na fila — o main recusaria.
    expect([...ids]).toEqual(['a']);
  });
});
