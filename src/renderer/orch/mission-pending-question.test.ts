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
): Mission {
  return {
    id,
    title,
    description: '',
    status,
    milestones: [],
    learnings: '',
    orchestratorSessionId: `session-${id}`,
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
  it('includes blocked missions and attaches mission titles', () => {
    const questions = pendingMissionQuestions(
      [
        mission('m-run', 'running', 'Entrega API'),
        mission('m-block', 'blocked', 'Corrigir login'),
        mission('m-done', 'done', 'Já fechada'),
      ],
      [
        questionHandoff('q-run', 'm-run', 10),
        questionHandoff('q-block', 'm-block', 5),
        questionHandoff('q-done', 'm-done', 1),
      ],
    );

    expect(questions.map((q) => q.questionId)).toEqual(['q-block', 'q-run']);
    expect(questions[0]).toMatchObject({
      questionId: 'q-block',
      missionId: 'm-block',
      missionTitle: 'Corrigir login',
      question: 'Pergunta q-block?',
    });
    expect(questions[1]?.missionTitle).toBe('Entrega API');
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
  it('returns only mission ids with open questions', () => {
    const ids = missionIdsAwaitingAnswer(
      [mission('a'), mission('b'), mission('c', 'pending')],
      [
        questionHandoff('q-a', 'a', 1),
        questionHandoff('q-c', 'c', 2),
      ],
    );
    expect([...ids].sort()).toEqual(['a', 'c']);
  });
});
