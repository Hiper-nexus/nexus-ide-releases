import { describe, expect, it, vi } from 'vitest';
import { startPhaseTimer, watchPhaseTimerStall } from './phase-timer';

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

describe('watchPhaseTimerStall', () => {
  it('reports once, with the last finished phase, when the spawn is still unfinished past the threshold', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const timer = startPhaseTimer();
      const reports: Array<{ totalMs: number; afterPhase: string | null; phases: Record<string, number> }> = [];
      watchPhaseTimerStall(timer, 15_000, (report) => reports.push(report));
      vi.advanceTimersByTime(40);
      timer.mark('provider-prep');
      vi.advanceTimersByTime(14_000);
      expect(reports).toEqual([]);
      vi.advanceTimersByTime(2_000);
      expect(reports).toEqual([{ totalMs: 15_000, afterPhase: 'provider-prep', phases: { 'provider-prep': 40 } }]);
      vi.advanceTimersByTime(60_000);
      expect(reports).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the most recent mark even when an earlier phase name is revisited', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const timer = startPhaseTimer();
      timer.mark('a');
      timer.mark('b');
      timer.mark('a');
      const reports: Array<{ afterPhase: string | null }> = [];
      watchPhaseTimerStall(timer, 10, (report) => reports.push(report));
      vi.advanceTimersByTime(11);
      expect(reports[0].afterPhase).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent when the spawn finishes first', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const timer = startPhaseTimer();
      const report = vi.fn();
      const stop = watchPhaseTimerStall(timer, 15_000, report);
      vi.advanceTimersByTime(1_000);
      stop();
      vi.advanceTimersByTime(60_000);
      expect(report).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
