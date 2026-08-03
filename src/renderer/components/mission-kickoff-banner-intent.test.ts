import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { missionKickoffBannerMission } from './mission-kickoff-banner-intent';

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Landing page',
    status: 'running',
    createdAt: 1_000,
    updatedAt: 2_000,
    ...patch,
  } as Mission;
}

describe('missionKickoffBannerMission', () => {
  it('elege a missão em voo sem pane na tela', () => {
    const result = missionKickoffBannerMission(
      [mission()],
      new Set(),
      false,
    );
    expect(result?.id).toBe('mission-1');
  });

  it('não mostra nada quando a missão já tem pane vinculado', () => {
    expect(
      missionKickoffBannerMission(
        [mission()],
        new Set(['mission-1']),
        false,
      ),
    ).toBeNull();
  });

  it('cede a vez quando o card de vaga já está na tela', () => {
    // O banner e a vaga contam a MESMA história; duas cópias simultâneas
    // são ruído — a vaga (conteúdo do grid) vence.
    expect(
      missionKickoffBannerMission([mission()], new Set(), true),
    ).toBeNull();
  });

  it('sem missão em voo, não há banner', () => {
    expect(
      missionKickoffBannerMission(
        [mission({ status: 'done' })],
        new Set(),
        false,
      ),
    ).toBeNull();
  });

  it('missão bloqueada sem pane continua elegível (veredito durável)', () => {
    const result = missionKickoffBannerMission(
      [mission({ status: 'blocked' })],
      new Set(),
      false,
    );
    expect(result?.id).toBe('mission-1');
  });

  it('outra missão com pane não esconde a missão sem pane', () => {
    const result = missionKickoffBannerMission(
      [
        mission({ id: 'mission-old', updatedAt: 1_500 }),
        mission({ id: 'mission-new', updatedAt: 3_000 }),
      ],
      new Set(['mission-old']),
      false,
    );
    expect(result?.id).toBe('mission-new');
  });
});
