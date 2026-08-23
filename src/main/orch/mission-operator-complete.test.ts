import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { MISSION_OPERATOR_APPROVED_MARKER } from '../../shared/mission-recovery-policy';
import { completeMissionByOperator } from './mission-operator-complete';
import { MISSION_RUNTIME_CLOSED_MARKER } from '../../shared/mission-recovery-policy';
import { testProjectScope } from './__tests__/scope-fixture';

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'profissional',
    description: `${MISSION_RUNTIME_CLOSED_MARKER}\n[NEXUS_RUNTIME_CLOSED] Encerrada.`,
    status: 'blocked',
    intentState: 'blocked_user',
    intentVersion: 2,
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 10,
    ...patch,
  };
}

describe('completeMissionByOperator', () => {
  const scope = testProjectScope();

  it('conclui missão estacionada pelo Encerrar via MissionEngine', () => {
    const parked = mission();
    const done = mission({
      status: 'done',
      intentState: 'done',
      result: {
        outcome: 'success',
        summary: 'Concluída pelo operador.',
        evidenceIds: [],
        artifactRefs: [],
      },
    });
    const get = vi
      .fn<(id: string) => Mission | null>()
      .mockReturnValueOnce(parked)
      .mockReturnValueOnce(done);
    const completeVerified = vi.fn();

    const result = completeMissionByOperator(
      scope,
      { missions: { get } } as never,
      'mission-1',
      { completeVerified },
    );

    // O carimbo de aprovação humana entra na descrição: é ele que tira a
    // missão de "Aguardando você".
    expect(result.ok).toBe(true);
    expect(result.mission?.description).toContain(
      MISSION_OPERATOR_APPROVED_MARKER,
    );
    expect(completeVerified).toHaveBeenCalledWith(scope, {
      missionId: 'mission-1',
      expectedStatus: 'blocked',
      expectedIntentState: 'blocked_user',
      expectedUpdatedAt: 10,
      expectedIntentVersion: 2,
      learnings:
        'O operador marcou a missão como concluída. Histórico e receipts permanecem.',
      result: {
        outcome: 'success',
        summary: 'Concluída pelo operador.',
        evidenceIds: [],
        artifactRefs: [],
      },
      // 19/08: missão Parou 0/0 ficava presa — "Marcar concluída" batia em
      // review_missing sem caminho de saída. A palavra do operador vence o
      // gate; só este IPC main-side seta a flag.
      operatorOverride: true,
    });
  });

  it('é idempotente quando a missão já está done', () => {
    const done = mission({ status: 'done', intentState: 'done' });
    const completeVerified = vi.fn();
    const result = completeMissionByOperator(
      scope,
      { missions: { get: () => done } } as never,
      'mission-1',
      { completeVerified },
    );
    // O carimbo de aprovação humana entra na descrição: é ele que tira a
    // missão de "Aguardando você".
    expect(result.ok).toBe(true);
    expect(result.mission?.description).toContain(
      MISSION_OPERATOR_APPROVED_MARKER,
    );
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('recusa rascunho e falha', () => {
    const completeVerified = vi.fn();
    expect(
      completeMissionByOperator(
        scope,
        {
          missions: {
            get: () => mission({ status: 'pending', intentState: 'draft', description: '' }),
          },
        } as never,
        'mission-1',
        { completeVerified },
      ).ok,
    ).toBe(false);
    expect(
      completeMissionByOperator(
        scope,
        {
          missions: {
            get: () => mission({ status: 'failed', description: '' }),
          },
        } as never,
        'mission-1',
        { completeVerified },
      ).ok,
    ).toBe(false);
    expect(completeVerified).not.toHaveBeenCalled();
  });

  it('devolve o erro do motor quando completeVerified recusa a cerca', () => {
    const parked = mission();
    const completeVerified = vi.fn(() => {
      throw new Error('mission engine lifecycle fence changed');
    });
    const result = completeMissionByOperator(
      scope,
      { missions: { get: () => parked } } as never,
      'mission-1',
      { completeVerified },
    );
    expect(result).toEqual({
      ok: false,
      mission: parked,
      error: 'mission engine lifecycle fence changed',
    });
  });
});
