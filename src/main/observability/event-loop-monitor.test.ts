import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_LOOP_TRACE_MAX_MS,
  EVENT_LOOP_TRACE_P99_MS,
  eventLoopTraceReason,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  summarizeEventLoopWindow,
  type EventLoopSummary,
} from './event-loop-monitor';

const ns = (ms: number) => ms * 1e6;

interface Window {
  count: number;
  p50: number;
  p99: number;
  max: number;
  mean: number;
}

/** Histograma falso com os números em ms já somados à resolução (como o Node mede). */
function fakeHistogram(initial: Window) {
  let current = initial;
  const histogram = {
    get count() {
      return current.count;
    },
    get max() {
      return ns(current.max);
    },
    get mean() {
      return ns(current.mean);
    },
    percentile: (p: number) => ns(p >= 99 ? current.p99 : current.p50),
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
  };
  return {
    histogram: histogram as unknown as IntervalHistogram & typeof histogram,
    set: (next: Window) => {
      current = next;
    },
  };
}

function summary(overrides: Partial<EventLoopSummary>): EventLoopSummary {
  return {
    windowMs: 30_000,
    samples: 1_500,
    p50Ms: 1,
    p99Ms: 2,
    maxMs: 3,
    meanMs: 1,
    liveAgents: 0,
    at: 0,
    ...overrides,
  };
}

afterEach(async () => {
  await stopEventLoopMonitor();
  vi.useRealTimers();
});

describe('summarizeEventLoopWindow', () => {
  it('converte ns → ms descontando a resolução (o Node mede o intervalo inteiro)', () => {
    const { histogram } = fakeHistogram({ count: 1_500, p50: 21.04, p99: 135.5, max: 715.65, mean: 23.2 });
    expect(
      summarizeEventLoopWindow({ histogram, resolutionMs: 20, windowMs: 30_012.4, liveAgents: 3, at: 99 }),
    ).toEqual({
      windowMs: 30_012,
      samples: 1_500,
      p50Ms: 1,
      p99Ms: 115.5,
      maxMs: 695.7,
      meanMs: 3.2,
      liveAgents: 3,
      at: 99,
    });
  });

  it('nunca reporta atraso negativo e devolve null sem amostra', () => {
    const quiet = fakeHistogram({ count: 10, p50: 19.9, p99: 19.9, max: 19.9, mean: 19.9 });
    expect(
      summarizeEventLoopWindow({ histogram: quiet.histogram, resolutionMs: 20, windowMs: 1, liveAgents: 0, at: 0 }),
    ).toMatchObject({ p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 });
    const empty = fakeHistogram({ count: 0, p50: 0, p99: 0, max: 0, mean: 0 });
    expect(
      summarizeEventLoopWindow({ histogram: empty.histogram, resolutionMs: 20, windowMs: 1, liveAgents: 0, at: 0 }),
    ).toBeNull();
  });
});

describe('eventLoopTraceReason (não encher o trace)', () => {
  it('main ociosa e saudável não vai para o trace', () => {
    expect(eventLoopTraceReason(summary({}))).toBeNull();
  });

  it('agente vivo é atividade relevante', () => {
    expect(eventLoopTraceReason(summary({ liveAgents: 1 }))).toBe('activity');
  });

  it('p99 alto ou um bloqueio isolado grande vão mesmo sem agente — e vencem "activity"', () => {
    expect(eventLoopTraceReason(summary({ p99Ms: EVENT_LOOP_TRACE_P99_MS }))).toBe('lag');
    expect(eventLoopTraceReason(summary({ maxMs: EVENT_LOOP_TRACE_MAX_MS, liveAgents: 4 }))).toBe('lag');
    expect(eventLoopTraceReason(summary({ p99Ms: EVENT_LOOP_TRACE_P99_MS - 1, maxMs: EVENT_LOOP_TRACE_MAX_MS - 1 }))).toBeNull();
  });
});

describe('startEventLoopMonitor', () => {
  it('fecha uma janela a cada 30 s: resumo sempre ao watchdog, trace só quando interessa', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const fake = fakeHistogram({ count: 1_500, p50: 21, p99: 22, max: 25, mean: 21 });
    let liveAgents = 0;
    const onSummary = vi.fn();
    const traceSink = vi.fn();
    const handle = startEventLoopMonitor({
      createHistogram: () => fake.histogram,
      liveAgents: () => liveAgents,
      onSummary,
      traceSink,
    });
    expect(fake.histogram.enable).toHaveBeenCalledTimes(1);

    // Janela 1: ociosa, sem agente → resumo vai ao watchdog, trace fica limpo.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(onSummary.mock.calls[0]?.[0]).toMatchObject({ windowMs: 30_000, p99Ms: 2, liveAgents: 0 });
    expect(traceSink).not.toHaveBeenCalled();
    expect(fake.histogram.reset).toHaveBeenCalledTimes(1);

    // Janela 2: missão rodando → linha de atividade.
    liveAgents = 2;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(traceSink).toHaveBeenLastCalledWith({
      kind: 'main-event-loop',
      reason: 'activity',
      windowMs: 30_000,
      samples: 1_500,
      p50Ms: 1,
      p99Ms: 2,
      maxMs: 5,
      meanMs: 1,
      liveAgents: 2,
    });

    // Janela 3: um bloqueio de ~1,8 s → linha de atraso.
    liveAgents = 0;
    fake.set({ count: 1_400, p50: 21, p99: 24, max: 1_820, mean: 22 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(traceSink).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'lag', maxMs: 1_800 }));
    expect(handle.latest()).toMatchObject({ maxMs: 1_800 });

    // Janela sem amostra (loop preso a janela inteira): nada inventado.
    fake.set({ count: 0, p50: 0, p99: 0, max: 0, mean: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onSummary).toHaveBeenCalledTimes(3);

    // Idempotente enquanto ativo; stop desliga o histograma e o relógio.
    expect(startEventLoopMonitor({ createHistogram: () => fake.histogram })).toBe(handle);
    handle.stop();
    expect(fake.histogram.disable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onSummary).toHaveBeenCalledTimes(3);
  });

  it('consumidor com defeito não para a medição', async () => {
    vi.useFakeTimers({ now: 0 });
    const fake = fakeHistogram({ count: 10, p50: 21, p99: 22, max: 23, mean: 21 });
    const traceSink = vi.fn();
    startEventLoopMonitor({
      createHistogram: () => fake.histogram,
      liveAgents: () => {
        throw new Error('registry fora do ar');
      },
      onSummary: () => {
        throw new Error('watchdog saiu');
      },
      traceSink,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.histogram.reset).toHaveBeenCalledTimes(2);
  });

  it('com o perf_hooks real, um bloqueio de 350 ms da main aparece como atraso', async () => {
    const summaries: EventLoopSummary[] = [];
    const traceSink = vi.fn();
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    try {
      // Prove native sampling before starting the 400 ms summary window.
      // A 60 ms sleep proves neither readiness nor room for the 350 ms block:
      // 60 + 350 crosses reset(), and a cold histogram can miss the block.
      await vi.waitFor(() => expect(histogram.count).toBeGreaterThanOrEqual(2), { timeout: 1_000, interval: 10 });
      startEventLoopMonitor({
        windowMs: 400, resolutionMs: 10, createHistogram: () => histogram,
        onSummary: (s) => summaries.push(s), traceSink,
      }); // enable() is idempotent: the same real histogram stays warm.
      const until = Date.now() + 350;
      while (Date.now() < until) {
        // trava a main de propósito, uma única vez
      }
      await vi.waitFor(() => expect(summaries.length).toBeGreaterThan(0), { timeout: 4_000, interval: 20 });
      // Assert the first window, not a later unrelated stall that happens to pass.
      expect(summaries[0].maxMs).toBeGreaterThanOrEqual(300);
      expect(traceSink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'main-event-loop', reason: 'lag' }));
    } finally {
      await stopEventLoopMonitor();
      histogram.disable(); // Also closes a histogram whose readiness timed out.
    }
  });
});
