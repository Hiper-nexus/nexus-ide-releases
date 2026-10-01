import { describe, expect, it } from 'vitest';
import {
  MOMENTUM_REPEAT_MS,
  MOMENTUM_SOLO_MS,
  decideMomentumNudge,
  momentumNudgeSummary,
} from './mission-momentum-watchdog';

const now = 10_000_000;
const base = {
  missionStatus: 'running',
  lane: null,
  maxWorkers: null,
  workerPanes: 0,
  orchestratorAlive: true,
  soloSinceMs: now - MOMENTUM_SOLO_MS,
  lastNudgeAtMs: null,
  now,
};

describe('vigia de esteira (F-714)', () => {
  it('Maestro vivo e sozinho há 20 min numa missão que delega: lembra de abrir workers', () => {
    expect(decideMomentumNudge(base)).toEqual({ action: 'nudge', soloForMs: MOMENTUM_SOLO_MS });
  });

  it('com worker vivo, há menos de 20 min, ou com lembrete na última hora: nada', () => {
    expect(decideMomentumNudge({ ...base, workerPanes: 1 })).toEqual({ action: 'none' });
    expect(decideMomentumNudge({ ...base, soloSinceMs: now - MOMENTUM_SOLO_MS + 1 })).toEqual({ action: 'none' });
    expect(decideMomentumNudge({ ...base, lastNudgeAtMs: now - MOMENTUM_REPEAT_MS + 1 })).toEqual({ action: 'none' });
    expect(decideMomentumNudge({ ...base, lastNudgeAtMs: now - MOMENTUM_REPEAT_MS }).action).toBe('nudge');
  });

  it('missão parada, de execução direta, consulta/plano ou Maestro fora do ar: nada', () => {
    for (const over of [
      { missionStatus: 'blocked' },
      { missionStatus: 'done' },
      { maxWorkers: 0 },
      { lane: 'plan' },
      { lane: 'consult' },
      { orchestratorAlive: false },
      { soloSinceMs: null },
    ]) {
      expect(decideMomentumNudge({ ...base, ...over }), JSON.stringify(over)).toEqual({ action: 'none' });
    }
  });

  it('o lembrete diz há quanto tempo e manda adiantar as próximas unidades sem paralelizar o gate', () => {
    const text = momentumNudgeSummary('mission-1', 95 * 60_000);
    expect(text).toContain('[momentum:mission-1]');
    expect(text).toContain('95 min');
    expect(text).toContain('próximas unidades');
    expect(text).toContain('um por vez');
  });
});
