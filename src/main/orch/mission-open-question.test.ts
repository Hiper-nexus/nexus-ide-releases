import { describe, expect, it } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import { resolveOpenMissionQuestion } from './mission-open-question';
import {
  projectMissionSnapshot,
  type ProjectMissionSnapshotView,
} from './mission-snapshot';

/** Onda 1 (religação): o chamador resolve o líder provado — aqui é a fixture. */
function sessionIdOf(id: string): string {
  return `session-${id}`;
}

function mission(
  id: string,
  status: Mission['status'] = 'blocked',
  intentState: Mission['intentState'] = 'blocked_user',
): Pick<Mission, 'id' | 'status' | 'intentState'> {
  return {
    id,
    status,
    ...(intentState === undefined ? {} : { intentState }),
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

describe('resolveOpenMissionQuestion', () => {
  it('isola a pergunta pela missão — a de outra missão não vaza', () => {
    const question = resolveOpenMissionQuestion(mission('m-a'), [
      questionHandoff('q-b', 'm-b', 1),
      questionHandoff('q-a', 'm-a', 2),
    ], sessionIdOf('m-a'));

    expect(question).toMatchObject({
      id: 'q-a',
      prompt: 'Pergunta q-a?',
    });
    expect(question?.id).not.toBe('q-b');
  });

  it('não some ao reler a mesma missão depois de olhar outra', () => {
    const handoffs = [
      questionHandoff('q-a', 'm-a', 1),
      questionHandoff('q-b', 'm-b', 2),
    ];

    expect(
      resolveOpenMissionQuestion(mission('m-b'), handoffs, sessionIdOf('m-b'))?.id,
    ).toBe('q-b');
    expect(
      resolveOpenMissionQuestion(mission('m-a'), handoffs, sessionIdOf('m-a'))?.id,
    ).toBe('q-a');
  });

  it('descarta respondida e consumida; sem questão da sessão corrente, a de sessão ANTERIOR fica visível (rebind)', () => {
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

    // q3 veio do orquestrador ANTES do rebind (sessão antiga): a missão segue
    // blocked_user esperando resposta — sumir do rail é a trava da família
    // "elicitation não respondida" (rodada 2 R3). Sem questão da sessão
    // corrente, ela É a pergunta em aberto.
    expect(
      resolveOpenMissionQuestion(mission('m1'), [
        questionHandoff('q1', 'm1', 1),
        answer,
        questionHandoff('q2', 'm1', 2, 'consumed'),
        {
          ...questionHandoff('q3', 'm1', 3),
          sessionId: 'other-session',
        },
      ], sessionIdOf('m1')),
    ).toMatchObject({ id: 'q3' });
  });

  it('questão da sessão CORRENTE ganha da antiga; entre antigas, a mais recente', () => {
    const current: Handoff = {
      ...questionHandoff('q-new', 'm1', 30),
    };
    const oldA = { ...questionHandoff('q-old-a', 'm1', 3), sessionId: 'old-a' };
    const oldB = { ...questionHandoff('q-old-b', 'm1', 4), sessionId: 'old-b' };

    expect(
      resolveOpenMissionQuestion(mission('m1'), [oldB, current, oldA], sessionIdOf('m1')),
    ).toMatchObject({ id: 'q-new' });

    expect(
      resolveOpenMissionQuestion(mission('m1'), [oldA, oldB], sessionIdOf('m1')),
    ).toMatchObject({ id: 'q-old-b' });
  });

  it('religação onda 1: sem sessão corrente resolvida (líder não provado), não projeta pergunta nenhuma', () => {
    expect(
      resolveOpenMissionQuestion(mission('m1'), [
        questionHandoff('q1', 'm1', 1),
      ], undefined),
    ).toBeUndefined();
    expect(
      resolveOpenMissionQuestion(mission('m1'), [
        questionHandoff('q1', 'm1', 1),
      ], null),
    ).toBeUndefined();
  });

  it('religação onda 1: quem decide "sessão corrente" é o terceiro argumento, não um campo da missão', () => {
    const handoffs = [
      { ...questionHandoff('q-x', 'm1', 1), sessionId: 'session-x' },
      { ...questionHandoff('q-y', 'm1', 2), sessionId: 'session-y' },
    ];
    expect(
      resolveOpenMissionQuestion(mission('m1'), handoffs, 'session-x'),
    ).toMatchObject({ id: 'q-x' });
    expect(
      resolveOpenMissionQuestion(mission('m1'), handoffs, 'session-y'),
    ).toMatchObject({ id: 'q-y' });
  });

  it('não projeta pergunta em missão running — o caminho vivo não vira blocked_user', () => {
    expect(
      resolveOpenMissionQuestion(
        mission('m-run', 'running'),
        [questionHandoff('q-run', 'm-run', 1)],
      ),
    ).toBeUndefined();
  });

  it('não projeta pergunta depois de Encerrar — runtime-closed ganha do clarify', () => {
    expect(
      resolveOpenMissionQuestion(
        {
          ...mission('m-quit', 'blocked', 'blocked_user'),
          description: '<!-- nexus:runtime-closed -->\nEncerrada.',
        },
        [questionHandoff('q-quit', 'm-quit', 1)],
      ),
    ).toBeUndefined();
  });

  it('não projeta pergunta em missão técnica ou encerrada', () => {
    const handoffs = [questionHandoff('q-tech', 'm-tech', 1)];
    expect(
      resolveOpenMissionQuestion(
        mission('m-tech', 'blocked', 'blocked_technical'),
        handoffs,
      ),
    ).toBeUndefined();
    expect(
      resolveOpenMissionQuestion(mission('m-tech', 'done'), handoffs),
    ).toBeUndefined();
  });

  it('o snapshot da missão B não herda a pergunta da missão A', () => {
    const handoffs = [
      questionHandoff('q-a', 'm-a', 1),
      questionHandoff('q-b', 'm-b', 2),
    ];
    const baseView = {
      hasDispatchAuthority: true,
      hasCurrentKickoffReceipt: true,
      orchestratorLive: true,
      tasks: [],
      handoffs: [],
      panes: [],
      roster: [],
    } satisfies Omit<ProjectMissionSnapshotView, 'mission' | 'openQuestion'>;

    const snapshotA = projectMissionSnapshot({
      ...baseView,
      mission: {
        id: 'm-a',
        title: 'Missão A',
        objective: 'A',
        workspaceLabel: 'ws',
        status: 'blocked',
        version: 1,
        updatedAt: 1,
      },
      openQuestion: resolveOpenMissionQuestion(mission('m-a'), handoffs, sessionIdOf('m-a')),
    });
    const snapshotB = projectMissionSnapshot({
      ...baseView,
      mission: {
        id: 'm-b',
        title: 'Missão B',
        objective: 'B',
        workspaceLabel: 'ws',
        status: 'blocked',
        version: 1,
        updatedAt: 1,
      },
      openQuestion: resolveOpenMissionQuestion(mission('m-b'), handoffs, sessionIdOf('m-b')),
    });

    expect(snapshotA.question?.id).toBe('q-a');
    expect(snapshotB.question?.id).toBe('q-b');
    expect(snapshotA.question?.prompt).not.toBe(snapshotB.question?.prompt);
  });

  it('não reabre pergunta adiada com agora não', () => {
    const dismiss: Handoff = {
      ...questionHandoff('dismiss-q1', 'm1', 20),
      sessionId: undefined,
      fromAgent: 'Operador Nexus',
      artifacts: [
        {
          kind: 'nexus-clarify-dismiss',
          schemaVersion: 1,
          questionId: 'q1',
        },
      ],
    };

    expect(
      resolveOpenMissionQuestion(mission('m1'), [
        questionHandoff('q1', 'm1', 1),
        dismiss,
      ], sessionIdOf('m1')),
    ).toBeUndefined();
  });

  it('aceita blocked_user — chips são a saída humana', () => {
    expect(
      resolveOpenMissionQuestion(
        mission('m-ask', 'blocked', 'blocked_user'),
        [questionHandoff('q-ask', 'm-ask', 1)],
        sessionIdOf('m-ask'),
      ),
    ).toMatchObject({
      id: 'q-ask',
      allowFreeText: true,
      options: [
        { id: 'opt-1', label: 'Sim' },
        { id: 'opt-2', label: 'Não' },
      ],
    });
  });
});
