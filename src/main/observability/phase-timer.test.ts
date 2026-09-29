import { describe, expect, it } from 'vitest';
import { startPhaseTimer } from './phase-timer';

describe('startPhaseTimer (F-213)', () => {
  it('registra o delta de cada fase desde o mark anterior e o total', () => {
    let now = 1_000;
    const timer = startPhaseTimer(() => now);
    now += 40;
    timer.mark('provider-prep');
    now += 10;
    timer.mark('pty-spawn');
    now += 5;
    const { totalMs, phases } = timer.finish();
    expect(totalMs).toBe(55);
    expect(phases).toEqual({ 'provider-prep': 40, 'pty-spawn': 10 });
  });

  it('acumula marks com o mesmo nome (fases revisitadas pela recursão)', () => {
    let now = 0;
    const timer = startPhaseTimer(() => now);
    now += 5;
    timer.mark('route');
    now += 3;
    timer.mark('gate');
    now += 7;
    timer.mark('route');
    const { phases, totalMs } = timer.finish();
    expect(phases.route).toBe(12);
    expect(phases.gate).toBe(3);
    expect(totalMs).toBe(15);
  });

  it('nunca devolve delta negativo se o relógio andar para trás', () => {
    let now = 100;
    const timer = startPhaseTimer(() => now);
    now -= 30;
    timer.mark('x');
    const { phases, totalMs } = timer.finish();
    expect(phases.x).toBe(0);
    expect(totalMs).toBe(0);
  });

  it('mede contra o relógio real por padrão', () => {
    const timer = startPhaseTimer();
    timer.mark('fase');
    const { totalMs, phases } = timer.finish();
    expect(totalMs).toBeGreaterThanOrEqual(0);
    expect(phases.fase).toBeGreaterThanOrEqual(0);
  });
});
