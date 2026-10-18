import { describe, expect, it } from 'vitest';
import type { MissionSummarySnapshot } from '../../shared/mission-engine-contract';
import type { Mission, TodoList } from '../../shared/orch-types';
import {
  MISSION_OPERATOR_APPROVED_MARKER,
  MISSION_RUNTIME_CLOSED_MARKER,
} from '../../shared/mission-recovery-policy';
import { missionChromeTitle } from '../../shared/mission-identity';
import { NEXUS_LEFTOVER_PARKED_MARKER } from '../../shared/mission-leftover-isolation';
import {
  groupTaskBoardMissionsByLane,
  isRemovableTaskBoardMission,
  isTaskBoardMissionEntry,
  projectTaskBoardEntries,
  taskBoardIsEmpty,
  type TaskBoardMissionEntry,
} from './task-board-projection';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-live',
    title: 'Missão rolando',
    description: '',
    status: 'running',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function summary(
  overrides: Partial<MissionSummarySnapshot> = {},
): MissionSummarySnapshot {
  return {
    id: 'mission-live',
    title: 'Missão rolando',
    state: 'running',
    progress: { completed: 0, total: 0 },
    needsAttention: false,
    updatedAt: 2,
    ...overrides,
  };
}

function missionEntries(
  input: Parameters<typeof projectTaskBoardEntries>[0],
): readonly TaskBoardMissionEntry[] {
  return projectTaskBoardEntries(input).filter(isTaskBoardMissionEntry);
}

describe('task-board-projection — lanes derivadas do snapshot', () => {
  it('o snapshot canônico manda no estado; a linha legada só prova o aceite', () => {
    const [entry] = missionEntries({
      missions: [mission({ status: 'pending' })],
      missionSummaries: [summary({ state: 'running' })],
      todoLists: [],
    });
    expect(entry).toMatchObject({
      kind: 'mission',
      name: 'Missão rolando',
      lane: 'building',
      stateLabel: 'Trabalhando',
      awaitsOperatorReview: false,
    });
  });

  it('concluída sem aceite fica em Validando como "Pronto para revisar"', () => {
    const [entry] = missionEntries({
      missions: [mission({ status: 'done' })],
      missionSummaries: [summary({ state: 'completed' })],
      todoLists: [],
    });
    expect(entry?.lane).toBe('validating');
    expect(entry?.stateLabel).toBe('Pronto para revisar');
    expect(entry?.awaitsOperatorReview).toBe(true);
  });

  it('concluída com o marcador de aceite vai para Pronto', () => {
    const [entry] = missionEntries({
      missions: [
        mission({
          status: 'done',
          description: `Entregue\n\n${MISSION_OPERATOR_APPROVED_MARKER}`,
        }),
      ],
      missionSummaries: [summary({ state: 'completed' })],
      todoLists: [],
    });
    expect(entry?.lane).toBe('ready');
    expect(entry?.stateLabel).toBe('Pronto');
  });

  it('concluída sem linha legada não reivindica aceite (sem prova, Validando)', () => {
    const [entry] = missionEntries({
      missions: [],
      missionSummaries: [summary({ state: 'completed' })],
      todoLists: [],
    });
    expect(entry?.lane).toBe('validating');
  });

  it('pergunta aberta cai em Precisa de você com a palavra certa', () => {
    const [entry] = missionEntries({
      missions: [mission({ status: 'blocked' })],
      missionSummaries: [
        summary({
          state: 'blocked_user',
          stateReason: { code: 'open-question', label: 'Aguardando sua resposta' },
          needsAttention: true,
        }),
      ],
      todoLists: [],
    });
    expect(entry?.lane).toBe('needs_you');
    expect(entry?.stateLabel).toBe('Precisa de você');
  });

  it('Parou (Encerrar) fica em Precisa de você com o rótulo civil (F-741)', () => {
    const [entry] = missionEntries({
      missions: [],
      missionSummaries: [
        summary({
          state: 'blocked_user',
          stateReason: { code: 'runtime-closed', label: 'Parou' },
        }),
      ],
      todoLists: [],
    });
    expect(entry?.lane).toBe('needs_you');
    expect(entry?.stateLabel).toBe('Parou');
  });

  it('Parou arquivado pelo operador vai para o Arquivo', () => {
    const [entry] = missionEntries({
      missions: [],
      missionSummaries: [
        summary({
          state: 'blocked_user',
          stateReason: { code: 'runtime-closed', label: 'Parou' },
        }),
      ],
      todoLists: [],
      archivedMissionIds: ['mission-live'],
    });
    expect(entry?.lane).toBe('archive');
    expect(entry?.stateLabel).toBe('Parou');
  });

  it('falhou vai para o Arquivo e lê Falhou', () => {
    const [entry] = missionEntries({
      missions: [],
      missionSummaries: [summary({ state: 'failed', needsAttention: true })],
      todoLists: [],
    });
    expect(entry?.lane).toBe('archive');
    expect(entry?.stateLabel).toBe('Falhou');
  });

  it('missão arquivada pelo operador sai do fluxo, mas nunca enquanto trabalha', () => {
    const entries = missionEntries({
      missions: [],
      missionSummaries: [
        summary({ id: 'parked', state: 'review_ready', title: 'Parada' }),
        summary({ id: 'live', state: 'running', title: 'Viva' }),
      ],
      todoLists: [],
      archivedMissionIds: ['parked', 'live'],
    });
    expect(entries.map((entry) => [entry.name, entry.lane])).toEqual([
      ['Parada', 'archive'],
      ['Viva', 'building'],
    ]);
  });

  it('título vazio usa o fallback civil da identidade da missão', () => {
    const [entry] = missionEntries({
      missions: [],
      missionSummaries: [summary({ title: '   ' })],
      todoLists: [],
    });
    expect(entry?.name).toBe(missionChromeTitle('   '));
    expect(entry?.name.trim()).not.toBe('');
  });
});

describe('task-board-projection — fallback da linha legada (hidratação)', () => {
  it('missão legada sem snapshot ainda aparece, no idioma do main', () => {
    const cases: ReadonlyArray<[Mission['status'], string, string]> = [
      ['pending', 'validating', 'Pronta para iniciar'],
      ['running', 'building', 'Trabalhando'],
      ['done', 'validating', 'Pronto para revisar'],
      ['failed', 'archive', 'Falhou'],
      ['blocked', 'needs_you', 'Precisa de reparo'],
    ];
    for (const [status, lane, stateLabel] of cases) {
      const [entry] = missionEntries({
        missions: [mission({ status })],
        todoLists: [],
      });
      expect([status, entry?.lane, entry?.stateLabel]).toEqual([
        status,
        lane,
        stateLabel,
      ]);
    }
  });

  it('linha legada encerrada pelo operador lê Parou em Precisa de você', () => {
    const [entry] = missionEntries({
      missions: [
        mission({
          status: 'blocked',
          description: `Encerrada\n${MISSION_RUNTIME_CLOSED_MARKER}`,
        }),
      ],
      todoLists: [],
    });
    expect(entry?.lane).toBe('needs_you');
    expect(entry?.stateLabel).toBe('Parou');
  });

  it('linha legada leftover-park lê Interrompida em Precisa de você', () => {
    const [entry] = missionEntries({
      missions: [
        mission({
          status: 'blocked',
          description: `Parada\n${NEXUS_LEFTOVER_PARKED_MARKER}`,
        }),
      ],
      todoLists: [],
    });
    expect(entry?.lane).toBe('needs_you');
    expect(entry?.stateLabel).toBe('Interrompida');
  });

  it('o snapshot vence a linha legada pelo id e não duplica o card', () => {
    const entries = missionEntries({
      missions: [mission({ status: 'pending' }), mission({ id: 'only-legacy', title: 'Só legada' })],
      missionSummaries: [summary({ state: 'running' })],
      todoLists: [],
    });
    expect(entries.map((entry) => [entry.name, entry.lane])).toEqual([
      ['Missão rolando', 'building'],
      ['Só legada', 'building'],
    ]);
  });
});

describe('task-board-projection — agrupamento por lane', () => {
  it('cada lane sai na ordem: atenção primeiro, depois updatedAt desc', () => {
    const lanes = groupTaskBoardMissionsByLane(
      projectTaskBoardEntries({
        missions: [],
        missionSummaries: [
          summary({ id: 'quiet-old', title: 'Quieta velha', state: 'running', updatedAt: 10 }),
          summary({ id: 'quiet-new', title: 'Quieta nova', state: 'starting', updatedAt: 50 }),
          summary({
            id: 'warned',
            title: 'Com aviso',
            state: 'running',
            needsAttention: true,
            updatedAt: 1,
          }),
          summary({ id: 'plan', title: 'Plano', state: 'review_ready', updatedAt: 3 }),
          summary({ id: 'broken', title: 'Quebrada', state: 'failed', needsAttention: true }),
        ],
        todoLists: [],
      }),
    );
    expect(lanes.building.map((entry) => entry.summary.id)).toEqual([
      'quiet-new',
      'quiet-old',
    ]);
    expect(lanes.needs_you.map((entry) => entry.summary.id)).toEqual(['warned']);
    expect(lanes.validating.map((entry) => entry.summary.id)).toEqual(['plan']);
    expect(lanes.ready).toEqual([]);
    expect(lanes.archive.map((entry) => entry.summary.id)).toEqual(['broken']);
  });

  it('todas as lanes existem mesmo vazias, e tarefas não entram', () => {
    const lanes = groupTaskBoardMissionsByLane(
      projectTaskBoardEntries({
        missions: [],
        todoLists: [
          {
            id: 'list',
            updatedAt: 1,
            items: [{ id: 'a', name: 'Tarefa', status: 'todo', createdAt: 1 }],
          },
        ],
      }),
    );
    expect(Object.keys(lanes)).toEqual([
      'building',
      'validating',
      'needs_you',
      'ready',
      'archive',
    ]);
    expect(Object.values(lanes).every((members) => members.length === 0)).toBe(
      true,
    );
    expect(Object.isFrozen(lanes)).toBe(true);
  });
});

describe('task-board-projection — Remover no card (F-741)', () => {
  function removable(
    overrides: Partial<MissionSummarySnapshot>,
    archivedMissionIds: readonly string[] = [],
  ): boolean {
    const [entry] = missionEntries({
      missions: [],
      missionSummaries: [summary(overrides)],
      todoLists: [],
      archivedMissionIds,
    });
    return isRemovableTaskBoardMission(entry!);
  }

  it('oferece Remover para missão parada, dormindo ou sem sessão', () => {
    expect(
      removable({
        state: 'blocked_user',
        stateReason: { code: 'runtime-closed', label: 'Parou' },
      }),
    ).toBe(true);
    expect(
      removable({
        state: 'blocked_user',
        stateReason: { code: 'session-sleeping', label: 'Dormindo' },
      }),
    ).toBe(true);
    expect(
      removable({
        state: 'blocked_technical',
        stateReason: { code: 'session-dead', label: 'Sem sessão' },
        needsAttention: true,
      }),
    ).toBe(true);
  });

  it('oferece Remover para tudo que está no Arquivo', () => {
    expect(removable({ state: 'failed', needsAttention: true })).toBe(true);
    expect(removable({ state: 'completed' }, ['mission-live'])).toBe(true);
    expect(removable({ state: 'review_ready' }, ['mission-live'])).toBe(true);
  });

  it('nunca oferece Remover para trabalho vivo ou pergunta aberta', () => {
    for (const state of ['starting', 'running', 'recovering', 'stopping'] as const) {
      expect(removable({ state })).toBe(false);
      // Arquivar não esconde trabalho vivo, então também não o torna removível.
      expect(removable({ state }, ['mission-live'])).toBe(false);
    }
    expect(
      removable({
        state: 'blocked_user',
        stateReason: { code: 'open-question', label: 'Aguardando sua resposta' },
        needsAttention: true,
      }),
    ).toBe(false);
    expect(removable({ state: 'completed' })).toBe(false);
  });
});

describe('task-board-projection — tarefas', () => {
  it('keeps canonical todos next to the mission card', () => {
    const list: TodoList = {
      id: 'release-list',
      updatedAt: 2,
      items: [
        {
          id: 'prepare-release',
          name: 'Preparar release',
          status: 'todo',
          createdAt: 1,
        },
      ],
    };
    const entries = projectTaskBoardEntries({
      missions: [mission()],
      todoLists: [list],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(['mission', 'todo']);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Missão rolando',
      'Preparar release',
    ]);
    expect(Object.isFrozen(entries)).toBe(true);
  });

  it('shows a running mission on an otherwise empty board', () => {
    const entries = projectTaskBoardEntries({
      missions: [mission()],
      todoLists: [{ id: 'empty-list', items: [], updatedAt: 1 }],
    });
    expect(taskBoardIsEmpty(entries)).toBe(false);
  });

  it('is empty only when there is no mission and no task', () => {
    expect(
      taskBoardIsEmpty(
        projectTaskBoardEntries({ missions: [], todoLists: [] }),
      ),
    ).toBe(true);
  });
});
