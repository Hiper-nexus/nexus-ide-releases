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

  it('does not hold a future-evidence phrase when evidence is already attached', () => {
    expect(
      missionGoalNeedsFutureEvidence(
        'Anexei um print e vou montar a missão com essa captura.',
        true,
      ),
    ).toBe(false);
  });

  it('does not hold a goal that only references an existing print in a later step', () => {
    // Real bug report: "em seguida melhore isto. do print." describes an
    // existing screenshot, it does not promise to send evidence later.
    expect(
      missionGoalNeedsFutureEvidence(
        'preciso de melhorias. atualize o repo. em seguida melhore isto. do print. onde a tela ohmipy ainda mostra instalado errado',
      ),
    ).toBe(false);
  });

  it('does not hold "veja o print e corrija" style objectives', () => {
    expect(missionGoalNeedsFutureEvidence('Veja o print e corrija o bug da OAuth.')).toBe(
      false,
    );
  });

  it('exposes the user-facing wait message', () => {
    expect(MISSION_EVIDENCE_WAIT_MESSAGE).toMatch(/Anexe os prints ou áudios/);
  });
});
