import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import {
  archiveMissionPrompt,
  canDiscardMission,
  discardMissionPrompt,
  missionListAction,
} from './mission-list-action';

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-a',
    title: 'A',
    description: '',
    status: 'pending',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe('mission list action policy', () => {
  it('nunca oferece remoção enquanto existe runtime vivo', () => {
    expect(canDiscardMission(mission({ intentState: 'awaiting_goal' }))).toBe(
      true,
    );
    expect(
      canDiscardMission(mission({ orchestratorSessionId: 'pty-live' })),
    ).toBe(false);
    expect(canDiscardMission(mission({ status: 'running' }))).toBe(false);
    expect(canDiscardMission(mission({ status: 'done' }))).toBe(false);
  });

  it('encerrar só aparece enquanto há runtime físico para encerrar', () => {
    const live = mission({
      status: 'blocked',
      intentState: 'blocked_user',
      orchestratorSessionId: 'pty-stuck',
    });
    expect(missionListAction(live, false)).toBe('close-runtime');
    expect(
      missionListAction(
        mission({ status: 'blocked', intentState: 'blocked_user' }),
        true,
      ),
    ).toBe('close-runtime');
  });

  it('após encerrar, a ação vira remoção — o operador não fica sem saída', () => {
    // Regressão: enquanto "encerrar" ficava para sempre, cada clique repetia
    // um no-op e a lista nunca esvaziava ("travado em 7 missões").
    const closed = mission({
      status: 'blocked',
      intentState: 'blocked_user',
    });
    expect(missionListAction(closed, false)).toBe('archive');
    expect(archiveMissionPrompt(closed).confirmLabel).toBe('Arquivar missão');
    expect(archiveMissionPrompt(closed).body).toMatch(/Nada é apagado/i);
  });

  it('missão concluída também sai da vista por arquivamento, nunca por apagar', () => {
    expect(missionListAction(mission({ status: 'done' }), false)).toBe(
      'archive',
    );
    expect(canDiscardMission(mission({ status: 'done' }))).toBe(false);
  });

  it('rascunho nunca despachado segue descartável com cópia própria', () => {
    const draft = mission({ intentState: 'awaiting_goal' });
    expect(missionListAction(draft, false)).toBe('discard');
    expect(discardMissionPrompt(draft).confirmLabel).toBe('Descartar missão');
  });
});
