// Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied)
// Referência (T3 Code, MIT): só o método de
// packages/client-runtime/src/operations/commands.performance.test.ts (teto
// numérico com o histórico ao lado, e o CI falha quando passa) — num teste do Nexus para o
// agendador de saída de terminal do renderer, contando escritas no xterm e
// drenos agendados em vez de bytes de RPC.

/**
 * QLT-01 — orçamento de trabalho do agendador de saída de terminal.
 *
 * Contagem determinística, nunca relógio: timers e `performance.now` são
 * falsos, então o corte de 8 ms por dreno nunca dispara e o número de
 * escritas depende só da lógica. Como mudar um teto: docs/perf-budgets.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTerminalOutputSchedulerDebugSnapshot,
  resetTerminalOutputSchedulerForTests,
  setTerminalOutputSchedulerDebug,
  writeTerminalOutput,
  type TerminalOutputSink,
} from './terminal-output-scheduler';
import { terminalOutputPolicy } from './terminal-render-policy';

/**
 * Tetos. Valor medido no commit que criou o orçamento entre parênteses.
 *
 * - burstWritesPerPane (1): uma rajada de chunks pequenos vira UMA escrita
 *   por pane — o dreno junta os chunks enfileirados até 16 KB e o pane focado
 *   de agente coalesce o quadro da TUI. Sem isso, 120 chunks = 120 escritas
 *   (e 120 parses do xterm) por pane.
 * - burstScheduledDrains (5): um único timer de dreno compartilhado pela
 *   grade; cada chunk novo NÃO rearma o timer.
 * - streamMaxWritesPerPane (31): 60 quadros em ~1 s viram no máximo 31
 *   escritas num pane (o focado coalesce o quadro da TUI; os de fundo esperam
 *   a janela de 50 ms e drenam juntos).
 * - streamTotalWrites (242): escritas da grade inteira no mesmo fluxo
 *   (8 panes × 60 quadros = 480 chunks).
 * - streamScheduledDrains (181): drenos agendados no mesmo fluxo.
 */
const BUDGET = {
  burstWritesPerPane: 1,
  burstScheduledDrains: 5,
  streamMaxWritesPerPane: 31,
  streamTotalWrites: 242,
  streamScheduledDrains: 181,
} as const;

const PANES = 8;
const CHUNKS_PER_PANE = 120;
const FRAMES = 60;
const FRAME_MS = 16;

type CountingSink = TerminalOutputSink & { writes: number; written: string };

function createSink(): CountingSink {
  const sink: CountingSink = {
    writes: 0,
    written: '',
    write(data: string) {
      sink.writes += 1;
      sink.written += data;
    },
  };
  return sink;
}

/** Um tick de status de TUI de agente: volta o cursor e redesenha a linha. */
function statusTick(pane: number, tick: number): string {
  return `\r\x1b[2K\x1b[38;5;${(pane * 7 + tick) % 255}m✻ Working… (${tick}s · esc to interrupt)\x1b[0m`;
}

/** Grade com 8 agentes visíveis; o pane 0 está focado. Política real do host. */
function policyFor(pane: number) {
  return terminalOutputPolicy({
    kind: 'cli-agent',
    isFocused: pane === 0,
    isPaneVisible: true,
    isDocumentVisible: true,
    isGridReady: true,
    performanceMode: 'adaptive',
  });
}

function measure(sinks: CountingSink[], expected: string[]) {
  const snapshot = getTerminalOutputSchedulerDebugSnapshot();
  // Orçamento só vale se a saída chegou inteira e na ordem.
  sinks.forEach((sink, pane) => expect(sink.written).toBe(expected[pane]));
  return {
    maxWritesPerPane: Math.max(...sinks.map((sink) => sink.writes)),
    totalWrites: sinks.reduce((sum, sink) => sum + sink.writes, 0),
    scheduledDrains: snapshot.scheduledDrainCount,
  };
}

describe('orçamento do agendador de saída de terminal (QLT-01)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    resetTerminalOutputSchedulerForTests();
    setTerminalOutputSchedulerDebug(true);
  });

  afterEach(() => {
    setTerminalOutputSchedulerDebug(false);
    resetTerminalOutputSchedulerForTests();
    vi.useRealTimers();
  });

  it(`rajada: ${PANES} agentes × ${CHUNKS_PER_PANE} chunks cabem em ${BUDGET.burstWritesPerPane} escrita por pane`, () => {
    const sinks = Array.from({ length: PANES }, createSink);
    const expected = sinks.map(() => '');
    for (let tick = 0; tick < CHUNKS_PER_PANE; tick += 1) {
      for (let pane = 0; pane < PANES; pane += 1) {
        const data = statusTick(pane, tick);
        expected[pane] += data;
        writeTerminalOutput(sinks[pane]!, data, policyFor(pane));
      }
    }
    vi.runAllTimers();

    const work = measure(sinks, expected);
    console.info('[perf-budget] terminal-output burst', JSON.stringify(work));
    expect(work.maxWritesPerPane).toBeLessThanOrEqual(BUDGET.burstWritesPerPane);
    expect(work.scheduledDrains).toBeLessThanOrEqual(BUDGET.burstScheduledDrains);
  });

  it(`fluxo de ${FRAMES} quadros a cada ${FRAME_MS} ms: no máximo ${BUDGET.streamMaxWritesPerPane} escritas por pane`, () => {
    const sinks = Array.from({ length: PANES }, createSink);
    const expected = sinks.map(() => '');
    for (let frame = 0; frame < FRAMES; frame += 1) {
      for (let pane = 0; pane < PANES; pane += 1) {
        const data = statusTick(pane, frame);
        expected[pane] += data;
        writeTerminalOutput(sinks[pane]!, data, policyFor(pane));
      }
      vi.advanceTimersByTime(FRAME_MS);
    }
    vi.runAllTimers();

    const work = measure(sinks, expected);
    // Medição registrada no log do CI para quem for ajustar o teto.
    console.info('[perf-budget] terminal-output stream', JSON.stringify(work));
    expect(work.maxWritesPerPane).toBeLessThanOrEqual(BUDGET.streamMaxWritesPerPane);
    expect(work.totalWrites).toBeLessThanOrEqual(BUDGET.streamTotalWrites);
    expect(work.scheduledDrains).toBeLessThanOrEqual(BUDGET.streamScheduledDrains);
  });
});
