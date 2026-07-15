import { describe, expect, it } from 'vitest';
import {
  missionGoalNeedsFutureEvidence,
  MISSION_EVIDENCE_WAIT_MESSAGE,
} from './mission-evidence';

describe('missionGoalNeedsFutureEvidence', () => {
  it('holds a goal that promises prints in a later step', () => {
    expect(
      missionGoalNeedsFutureEvidence(
        'Preciso analisar e corrigir alguns bugs que vou te apontar na próxima etapa com prints.',
      ),
    ).toBe(true);
  });

  it('holds a goal that will receive audio after submission', () => {
    expect(
      missionGoalNeedsFutureEvidence('Corrija o bug quando eu enviar o áudio e a captura.'),
    ).toBe(true);
  });

  it('does not hold a normal text-only objective', () => {
    expect(missionGoalNeedsFutureEvidence('Corrija o bug de login e rode os testes.')).toBe(
      false,
    );
  });

  it('does not hold an objective that uses an already attached print', () => {
    expect(
      missionGoalNeedsFutureEvidence('Analise o print anexado e corrija o erro visível.'),
    ).toBe(false);
  });

  it('exposes the user-facing wait message', () => {
    expect(MISSION_EVIDENCE_WAIT_MESSAGE).toMatch(/Anexe os prints ou áudios/);
  });
});
