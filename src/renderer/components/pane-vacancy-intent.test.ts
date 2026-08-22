import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { NEXUS_PROCESS_STARTED_AT } from '../../shared/session-restore-liveness';
import { paneVacancyIntent, paneVacancyMission } from './pane-vacancy-intent';

/** Timestamps frescos POR PADRÃO: leftover pré-boot não narra mais a vacancy.
 *  Date.now() na HORA do teste — na carga do módulo a constante de boot ainda
 *  não nasceu e offsets pequenos cairiam do lado errado da fronteira. */
function mission(patch: Partial<Mission>): Mission {
  return {
    id: 'mission',
    title: 'Missão',
    description: '',
    status: 'pending',
    milestones: [],
    learnings: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  };
}

describe('paneVacancyMission — who owns an empty grid', () => {
  it('ignores missions that are not in flight', () => {
    expect(
      paneVacancyMission([
        mission({ id: 'a', status: 'done' }),
        mission({ id: 'b', status: 'failed' }),
        mission({ id: 'c', status: 'pending' }),
      ]),
    ).toBeNull();
  });

  /**
   * Leftover de um boot anterior (status cru do SQLite, processo morto) não
   * pode abrir o workspace narrando uma missão que o operador não pediu —
   * cockpit limpo no reopen; trabalho velho mora na rail.
   */
  it('ignora leftover atualizado antes deste processo nascer', () => {
    const stale = NEXUS_PROCESS_STARTED_AT - 60_000;
    expect(
      paneVacancyMission([
        mission({ id: 'velha', status: 'blocked', updatedAt: stale }),
        mission({ id: 'velha-running', status: 'running', updatedAt: stale }),
      ]),
    ).toBeNull();
  });

  it('missão desta sessão continua dona da vacancy', () => {
    const picked = paneVacancyMission([
      mission({
        id: 'velha',
        status: 'blocked',
        updatedAt: NEXUS_PROCESS_STARTED_AT - 60_000,
      }),
      mission({ id: 'nova', status: 'blocked', updatedAt: Date.now() }),
    ]);
    expect(picked?.id).toBe('nova');
  });

  /**
   * A blocked mission is the one waiting on a HUMAN. A running one that has
   * not presented yet is seconds away from replacing this vacancy outright
   * (I1), so it must not out-shout the mission that needs a decision.
   */
  it('prefers the blocked mission over a running one', () => {
    const base = Date.now();
    const picked = paneVacancyMission([
      mission({ id: 'running', status: 'running', updatedAt: base + 1_000 }),
      mission({ id: 'blocked', status: 'blocked', updatedAt: base }),
    ]);
    expect(picked?.id).toBe('blocked');
  });

  it('breaks ties on the most recent update', () => {
    const base = Date.now();
    const picked = paneVacancyMission([
      mission({ id: 'old', status: 'blocked', updatedAt: base }),
      mission({ id: 'new', status: 'blocked', updatedAt: base + 1_000 }),
    ]);
    expect(picked?.id).toBe('new');
  });
});

describe('paneVacancyIntent — what the vacancy says', () => {
  it('teaches the empty case when nothing is in flight', () => {
    expect(paneVacancyIntent([])).toEqual({ kind: 'idle' });
  });

  /** The reason is already durable — transport it, never invent it. */
  it('carries the recorded block cause and its next step', () => {
    const intent = paneVacancyIntent([
      mission({
        id: 'm1',
        title: 'Publicar a release',
        status: 'blocked',
        description: 'parou\n[NEXUS_TASK_DISPATCH_BLOCKED]',
      }),
    ]);
    expect(intent).toMatchObject({
      kind: 'mission-unstaged',
      missionId: 'm1',
      missionTitle: 'Publicar a release',
    });
    if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
    expect(intent.headline).toContain('despacho');
    expect(intent.nextStep).toContain('Retomar missão');
  });

  /** Unknown must ADMIT it is unknown instead of inventing a cause. */
  it('admits an unrecorded cause instead of guessing', () => {
    const intent = paneVacancyIntent([
      mission({ id: 'm2', status: 'blocked', description: 'sem marcador' }),
    ]);
    if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
    expect(intent.headline).toContain('não registrado');
    expect(intent.nextStep.length).toBeGreaterThan(0);
  });

  it('says a running mission is still preparing, not that it failed', () => {
    const intent = paneVacancyIntent([
      mission({ id: 'm3', status: 'running', title: 'Refatorar o grid' }),
    ]);
    if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
    expect(intent.headline).toContain('preparando');
    expect(intent.nextStep.length).toBeGreaterThan(0);
  });

  describe('with live bootstrap progress', () => {
    const progress = {
      missionId: 'm3',
      step: 'squad_sealed' as const,
      occurredAt: 1_000,
    };

    it('shows the live step and its age as the headline', () => {
      const intent = paneVacancyIntent(
        [mission({ id: 'm3', status: 'running' })],
        progress,
        13_000,
      );
      if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
      expect(intent.headline).toBe('Squad selado · há 12s');
      expect(intent.nextStep.length).toBeGreaterThan(0);
    });

    it('keeps the static copy when progress belongs to another mission', () => {
      const intent = paneVacancyIntent(
        [mission({ id: 'm3', status: 'running' })],
        { ...progress, missionId: 'outra' },
        13_000,
      );
      if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
      expect(intent.headline).toBe(
        'A missão está preparando os agentes — nenhum pane foi aberto ainda.',
      );
    });

    it('never overrides the durable cause of a blocked mission', () => {
      const intent = paneVacancyIntent(
        [
          mission({
            id: 'm3',
            status: 'blocked',
            description: '[NEXUS_TASK_DISPATCH_BLOCKED]',
          }),
        ],
        progress,
        13_000,
      );
      if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
      expect(intent.headline).toContain('despacho');
      expect(intent.headline).not.toContain('Squad selado');
    });
  });

  describe('with chef-idle progress', () => {
    const chefIdle = {
      missionId: 'm3',
      workerCount: 2,
      occurredAt: 1_000,
    };

    it('shows the chef-idle headline with worker count and age', () => {
      const intent = paneVacancyIntent(
        [mission({ id: 'm3', status: 'running' })],
        null,
        13_000,
        chefIdle,
      );
      if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
      expect(intent.headline).toBe('Orquestrador aguardando 2 workers · há 12s');
    });

    it('uses singular form for 1 worker', () => {
      const intent = paneVacancyIntent(
        [mission({ id: 'm3', status: 'running' })],
        null,
        13_000,
        { ...chefIdle, workerCount: 1 },
      );
      if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
      expect(intent.headline).toBe('Orquestrador aguardando 1 worker · há 12s');
    });

    it('bootstrap progress takes priority over chef-idle', () => {
      const intent = paneVacancyIntent(
        [mission({ id: 'm3', status: 'running' })],
        { missionId: 'm3', step: 'squad_sealed' as const, occurredAt: 1_000 },
        13_000,
        chefIdle,
      );
      if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
      expect(intent.headline).toBe('Squad selado · há 12s');
    });

    it('ignores chef-idle from another mission', () => {
      const intent = paneVacancyIntent(
        [mission({ id: 'm3', status: 'running' })],
        null,
        13_000,
        { ...chefIdle, missionId: 'outra' },
      );
      if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
      expect(intent.headline).toContain('preparando');
    });

    it('never overrides the durable cause of a blocked mission', () => {
      const intent = paneVacancyIntent(
        [mission({ id: 'm3', status: 'blocked', description: '[NEXUS_TASK_DISPATCH_BLOCKED]' })],
        null,
        13_000,
        chefIdle,
      );
      if (intent.kind !== 'mission-unstaged') throw new Error('unreachable');
      expect(intent.headline).toContain('despacho');
      expect(intent.headline).not.toContain('Orquestrador');
    });
  });
});
