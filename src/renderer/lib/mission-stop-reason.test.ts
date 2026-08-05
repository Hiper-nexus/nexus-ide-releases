import { describe, expect, it } from 'vitest';
import { missionStopReason } from './mission-stop-reason';

const stopped = {
  hasActiveRuntime: false,
  hasObservedRuntime: true,
} as const;

describe('missionStopReason', () => {
  // O invariante que dá nome ao módulo. Voo real 05/08 (mission-3be48989): a
  // missão parou, os panes fecharam e o card dizia só "Aguarda você" — o
  // operador não tinha o que fazer com aquilo.
  it('NUNCA deixa uma missão parada sem motivo e sem próximo passo', () => {
    const semRelatorio = missionStopReason({
      ...stopped,
      status: 'pending',
      latestHandoff: null,
    });
    expect(semRelatorio).not.toBeNull();
    expect(semRelatorio?.reason.trim().length).toBeGreaterThan(0);
    expect(semRelatorio?.nextAction.trim().length).toBeGreaterThan(0);
  });

  it('usa o relatório do worker como motivo quando ele bloqueou', () => {
    const stop = missionStopReason({
      ...stopped,
      status: 'pending',
      latestHandoff: {
        status: 'blocked',
        summary:
          'Story 1.2 preparada em TBD-BLOCKED. O gate não foi promovido: falta OD-23 resolvido.',
      },
    });
    expect(stop?.reason).toContain('OD-23');
    expect(stop?.nextAction).toContain('Retomar');
  });

  it('nomeia a falha do worker como falha, não como espera', () => {
    const stop = missionStopReason({
      ...stopped,
      status: 'pending',
      latestHandoff: { status: 'failed', summary: 'migração quebrou o schema' },
    });
    expect(stop?.reason).toContain('falhou');
    expect(stop?.reason).toContain('migração quebrou o schema');
  });

  it('não inventa motivo para missão que nunca materializou runtime', () => {
    expect(
      missionStopReason({
        hasActiveRuntime: false,
        hasObservedRuntime: false,
        status: 'pending',
        latestHandoff: null,
      }),
    ).toBeNull();
  });

  it('não fala em parada enquanto a missão está viva', () => {
    expect(
      missionStopReason({
        hasActiveRuntime: true,
        hasObservedRuntime: true,
        status: 'running',
        latestHandoff: { status: 'blocked', summary: 'relatório antigo' },
      }),
    ).toBeNull();
  });

  it('não promete retomada para missão terminal', () => {
    expect(
      missionStopReason({
        ...stopped,
        status: 'done',
        latestHandoff: null,
      }),
    ).toBeNull();
  });

  it('corta um relatório longo sem perder a frase inicial', () => {
    const stop = missionStopReason({
      ...stopped,
      status: 'pending',
      latestHandoff: { status: 'blocked', summary: 'A'.repeat(500) },
    });
    expect(stop?.reason.length).toBeLessThanOrEqual(240);
    expect(stop?.reason).toContain('…');
  });
});

describe('B-254 residual — evidência durável, não layout vivo', () => {
  // Voo real 05/08 (HiperGO): o worker deixou um handoff `blocked` com o motivo
  // inteiro escrito, o reaper fechou os panes, e o card voltou a "Retomar ·
  // data". O chamador derivava runtime de `paneMissions` VIVO, que é 0 depois
  // da colheita — então a razão existia no banco e o produto calava de novo.
  it('um handoff durável PROVA que a missão materializou runtime', () => {
    const stop = missionStopReason({
      status: 'pending',
      hasActiveRuntime: false,
      // Panes já colhidos: o layout não sabe mais de nada.
      hasObservedRuntime: false,
      latestHandoff: {
        status: 'blocked',
        summary: 'Faltou a credencial do banco de homologação.',
      },
    });

    expect(stop).not.toBeNull();
    expect(stop?.reason).toContain('Faltou a credencial');
  });

  it('trabalho planejado também prova runtime quando não há relatório', () => {
    const stop = missionStopReason({
      status: 'pending',
      hasActiveRuntime: false,
      hasObservedRuntime: false,
      latestHandoff: null,
      plannedWork: 8,
    });

    expect(stop).not.toBeNull();
    expect(stop?.nextAction).toBeTruthy();
  });

  it('missão sem plano, sem handoff e sem pane segue sem parada a explicar', () => {
    expect(
      missionStopReason({
        status: 'pending',
        hasActiveRuntime: false,
        hasObservedRuntime: false,
        latestHandoff: null,
        plannedWork: 0,
      }),
    ).toBeNull();
  });

  it('runtime vivo continua vencendo qualquer evidência durável', () => {
    expect(
      missionStopReason({
        status: 'pending',
        hasActiveRuntime: true,
        hasObservedRuntime: false,
        latestHandoff: { status: 'blocked', summary: 'x' },
        plannedWork: 8,
      }),
    ).toBeNull();
  });
});
