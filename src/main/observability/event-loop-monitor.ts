/**
 * F-764 (A.3): atraso do event-loop do main como métrica contínua.
 *
 * O travamento de 03/10 foi uma fila de mensagens de PTY em que cada uma
 * custava ~300 ms — antes de virar 90 s de main parada, o loop já vinha
 * engasgando, e nada registrava isso. `perf_hooks.monitorEventLoopDelay`
 * amostra o atraso de um timer de `RESOLUTION_MS`; a cada janela de 30 s o
 * resumo (p50/p99/max) vai:
 *  - para o watchdog da main thread, SEMPRE (a linha de travamento do
 *    `main-hang.ndjson` sai com o último resumo — o "como estava antes");
 *  - para o `main.trace.ndjson`, só quando interessa: agentes vivos (missão
 *    rodando) ou atraso perceptível (p99 ≥ 100 ms, ou um bloqueio isolado
 *    ≥ 250 ms que o p99 diluiria). Main ociosa e saudável não escreve nada.
 *
 * O histograma do Node guarda o INTERVALO entre ticks (~resolução em
 * repouso); o resumo desconta a resolução para reportar atraso de verdade.
 * Ponto cego conhecido: o primeiro tick depois de `reset()` não registra
 * (~20 ms por janela). Um bloqueio que comece exatamente aí ainda aparece em
 * `windowMs`, que é a duração MEDIDA da janela (o timer de 30 s também atrasa).
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { trace } from './main-trace';

export const EVENT_LOOP_WINDOW_MS = 30_000;
export const EVENT_LOOP_RESOLUTION_MS = 20;
/** p99 a partir disso já é engasgo perceptível na UI. */
export const EVENT_LOOP_TRACE_P99_MS = 100;
/** Um único bloqueio desse tamanho vira linha mesmo sem agente vivo. */
export const EVENT_LOOP_TRACE_MAX_MS = 250;

export interface EventLoopSummary {
  /** Duração medida da janela (cresce quando o próprio timer atrasou). */
  readonly windowMs: number;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  /** Panes de agente vivos no fim da janela. */
  readonly liveAgents: number;
  readonly at: number;
}

type HistogramView = Pick<IntervalHistogram, 'count' | 'max' | 'mean' | 'percentile'>;

function lagMs(valueNs: number, resolutionMs: number): number {
  if (!Number.isFinite(valueNs) || valueNs <= 0) return 0;
  return Math.max(0, Math.round((valueNs / 1e6 - resolutionMs) * 10) / 10);
}

/** Resumo de uma janela; `null` quando o histograma não tem amostra. */
export function summarizeEventLoopWindow(input: {
  readonly histogram: HistogramView;
  readonly resolutionMs: number;
  readonly windowMs: number;
  readonly liveAgents: number;
  readonly at: number;
}): EventLoopSummary | null {
  const { histogram, resolutionMs } = input;
  const samples = histogram.count;
  if (!Number.isFinite(samples) || samples <= 0) return null;
  return {
    windowMs: Math.max(0, Math.round(input.windowMs)),
    samples,
    p50Ms: lagMs(histogram.percentile(50), resolutionMs),
    p99Ms: lagMs(histogram.percentile(99), resolutionMs),
    maxMs: lagMs(histogram.max, resolutionMs),
    meanMs: lagMs(histogram.mean, resolutionMs),
    liveAgents: input.liveAgents,
    at: input.at,
  };
}

/** Por que a janela vai para o trace (`null` = não vai). */
export function eventLoopTraceReason(
  summary: EventLoopSummary,
): 'lag' | 'activity' | null {
  if (
    summary.p99Ms >= EVENT_LOOP_TRACE_P99_MS ||
    summary.maxMs >= EVENT_LOOP_TRACE_MAX_MS
  ) {
    return 'lag';
  }
  return summary.liveAgents > 0 ? 'activity' : null;
}

export interface EventLoopMonitorHandle {
  /** Último resumo fechado (ou `null` antes da primeira janela). */
  latest(): EventLoopSummary | null;
  stop(): void;
}

export interface EventLoopMonitorOptions {
  /** Contagem de panes de agente vivos ("atividade relevante"). */
  readonly liveAgents?: () => number;
  /** Recebe TODO resumo, gravado no trace ou não (watchdog da main thread). */
  readonly onSummary?: (summary: EventLoopSummary) => void;
  readonly windowMs?: number;
  readonly resolutionMs?: number;
  /** Testes: histograma e relógio falsos, sink do trace. */
  readonly createHistogram?: (resolutionMs: number) => IntervalHistogram;
  readonly now?: () => number;
  readonly traceSink?: (event: Record<string, unknown>) => void;
}

let active: EventLoopMonitorHandle | null = null;

/**
 * Liga o monitor (idempotente: um por processo). Best-effort: sem
 * `perf_hooks` utilizável, devolve um handle mudo — métrica nunca derruba o
 * boot.
 */
export function startEventLoopMonitor(
  options: EventLoopMonitorOptions = {},
): EventLoopMonitorHandle {
  if (active) return active;
  const windowMs = options.windowMs ?? EVENT_LOOP_WINDOW_MS;
  const resolutionMs = options.resolutionMs ?? EVENT_LOOP_RESOLUTION_MS;
  const now = options.now ?? (() => Date.now());
  const sink = options.traceSink ?? trace;
  let histogram: IntervalHistogram;
  try {
    histogram = (options.createHistogram ??
      ((resolution: number) => monitorEventLoopDelay({ resolution })))(resolutionMs);
    histogram.enable();
  } catch (error) {
    console.warn('[event-loop] monitor indisponível:', error);
    return { latest: () => null, stop: () => undefined };
  }
  let latest: EventLoopSummary | null = null;
  let windowStartedAt = now();

  const tick = (): void => {
    const at = now();
    let liveAgents = 0;
    try {
      liveAgents = options.liveAgents?.() ?? 0;
    } catch {
      // Contagem é contexto; sem ela o resumo sai com 0.
    }
    const summary = summarizeEventLoopWindow({
      histogram,
      resolutionMs,
      windowMs: at - windowStartedAt,
      liveAgents,
      at,
    });
    histogram.reset();
    windowStartedAt = at;
    if (!summary) return;
    latest = summary;
    try {
      options.onSummary?.(summary);
    } catch {
      // Consumidor com defeito não para a medição.
    }
    const reason = eventLoopTraceReason(summary);
    if (!reason) return;
    // `at` fica de fora: o trace carimba a linha sozinho.
    sink({
      kind: 'main-event-loop',
      reason,
      windowMs: summary.windowMs,
      samples: summary.samples,
      p50Ms: summary.p50Ms,
      p99Ms: summary.p99Ms,
      maxMs: summary.maxMs,
      meanMs: summary.meanMs,
      liveAgents: summary.liveAgents,
    });
  };

  const timer = setInterval(tick, windowMs);
  timer.unref?.();
  const handle: EventLoopMonitorHandle = {
    latest: () => latest,
    stop: () => {
      clearInterval(timer);
      try {
        histogram.disable();
      } catch {
        // Já desligado.
      }
      if (active === handle) active = null;
    },
  };
  active = handle;
  return handle;
}

export function stopEventLoopMonitor(): void {
  active?.stop();
}
