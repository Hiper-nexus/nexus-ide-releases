import { describe, expect, it } from 'vitest';
import {
  createForwardHealTracker,
  cursorInsideBounds,
} from './pet-forward-heal';

const BOUNDS = { x: 100, y: 200, width: 300, height: 340 };

function insideInput(overrides: Partial<Parameters<
  ReturnType<typeof createForwardHealTracker>['observe']
>[0]> = {}) {
  return {
    cursorInside: true,
    ignoresMouse: true,
    dragging: false,
    windowVisible: true,
    ...overrides,
  };
}

describe('cursorInsideBounds', () => {
  it('aceita cursor dentro e rejeita fora dos bounds (DIP)', () => {
    expect(cursorInsideBounds({ x: 250, y: 370 }, BOUNDS)).toBe(true);
    // Bordas inclusivas — hit no pixel do limite não deve tremer.
    expect(cursorInsideBounds({ x: 100, y: 200 }, BOUNDS)).toBe(true);
    expect(cursorInsideBounds({ x: 400, y: 540 }, BOUNDS)).toBe(true);
    expect(cursorInsideBounds({ x: 99, y: 370 }, BOUNDS)).toBe(false);
    expect(cursorInsideBounds({ x: 250, y: 541 }, BOUNDS)).toBe(false);
  });
});

describe('createForwardHealTracker — Bug 7 (pet “de vidro”)', () => {
  it('revive o forward só depois de N ticks consecutivos com o cursor dentro', () => {
    let clock = 0;
    const tracker = createForwardHealTracker({
      reviveAfterTicks: 4,
      minReviveIntervalMs: 1_500,
      now: () => clock,
    });
    // tick 1: entra — sonda, sem revive
    expect(tracker.observe(insideInput())).toEqual({ revive: false, probe: true });
    // ticks 2–3: acumulando
    expect(tracker.observe(insideInput()).revive).toBe(false);
    expect(tracker.observe(insideInput()).revive).toBe(false);
    // tick 4: revive + sonda
    expect(tracker.observe(insideInput())).toEqual({ revive: true, probe: true });
  });

  it('sonda apenas na transição fora→dentro (não a cada tick)', () => {
    const tracker = createForwardHealTracker({
      reviveAfterTicks: 4,
      minReviveIntervalMs: 1_500,
    });
    expect(tracker.observe(insideInput()).probe).toBe(true);
    expect(tracker.observe(insideInput()).probe).toBe(false);
    // saiu e voltou → nova sonda
    expect(tracker.observe(insideInput({ cursorInside: false }))).toEqual({
      revive: false,
      probe: false,
    });
    expect(tracker.observe(insideInput()).probe).toBe(true);
  });

  it('não revive quando a janela está interativa, arrastando ou oculta', () => {
    for (const overrides of [
      { ignoresMouse: false },
      { dragging: true },
      { windowVisible: false },
    ] as const) {
      const tracker = createForwardHealTracker({
        reviveAfterTicks: 2,
        minReviveIntervalMs: 0,
      });
      for (let i = 0; i < 5; i += 1) {
        const decision = tracker.observe(insideInput(overrides));
        expect(decision.revive).toBe(false);
        expect(decision.probe).toBe(false);
      }
    }
  });

  it('zera o contador quando o cursor sai antes do limiar', () => {
    const tracker = createForwardHealTracker({
      reviveAfterTicks: 3,
      minReviveIntervalMs: 0,
    });
    expect(tracker.observe(insideInput()).revive).toBe(false);
    expect(tracker.observe(insideInput()).revive).toBe(false);
    tracker.observe(insideInput({ cursorInside: false }));
    // Voltou: começa do zero — 2 ticks não bastam mais.
    expect(tracker.observe(insideInput()).revive).toBe(false);
    expect(tracker.observe(insideInput()).revive).toBe(false);
    expect(tracker.observe(insideInput()).revive).toBe(true);
  });

  it('re-tenta o revive respeitando o intervalo mínimo (forward não colou)', () => {
    let clock = 0;
    const tracker = createForwardHealTracker({
      reviveAfterTicks: 1,
      minReviveIntervalMs: 1_500,
      now: () => clock,
    });
    expect(tracker.observe(insideInput()).revive).toBe(true);
    // Dentro da janela de throttle: sem novo revive (não recompõe em spam).
    clock = 1_000;
    expect(tracker.observe(insideInput()).revive).toBe(false);
    // Passou a janela e o cursor CONTINUA lá: tenta reviver de novo.
    clock = 1_600;
    expect(tracker.observe(insideInput()).revive).toBe(true);
  });
});
