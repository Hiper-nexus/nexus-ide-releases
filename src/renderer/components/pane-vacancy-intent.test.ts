import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { paneVacancyIntent, paneVacancyMission } from './pane-vacancy-intent';

function mission(patch: Partial<Mission>): Mission {
  return {
    id: 'mission',
    title: 'Missão',
    description: '',
    status: 'pending',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
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
   * A blocked mission is the one waiting on a HUMAN. A running one that has
   * not presented yet is seconds away from replacing this vacancy outright
   * (I1), so it must not out-shout the mission that needs a decision.
   */
  it('prefers the blocked mission over a running one', () => {
    const picked = paneVacancyMission([
      mission({ id: 'running', status: 'running', updatedAt: 99 }),
      mission({ id: 'blocked', status: 'blocked', updatedAt: 2 }),
    ]);
    expect(picked?.id).toBe('blocked');
  });

  it('breaks ties on the most recent update', () => {
    const picked = paneVacancyMission([
      mission({ id: 'old', status: 'blocked', updatedAt: 5 }),
      mission({ id: 'new', status: 'blocked', updatedAt: 9 }),
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
});
