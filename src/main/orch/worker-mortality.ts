/**
 * Mortalidade de worker por (missão, adapter) — campanha 0.50 (A1/A2).
 *
 * No modelo PULL o Maestro escolhe quando spawnar workers; quando um adapter
 * entrega workers que morrem sem produzir NADA (missão real: 13 de 20 panes
 * sem um único turno; um pane respawnado 6×), o Maestro não tem o dado e
 * repete o mesmo spawn para sempre. O circuit breaker (doutrina Orca PR
 * #13927, DISPATCH_CIRCUIT_BREAK_FAILURES=3): a 3 mortes sem entrega do
 * MESMO adapter na MESMA missão, o spawn de worker dele é recusado com
 * motivo acionável — o Maestro escolhe outro agente do roster. Prova de
 * vida (entrega) zera a contagem; o orquestrador NUNCA é recusado por aqui.
 */

import {
  logWriterCircuitBreak,
  recordWriterConnectFailure,
  clearWriterConnectFailures,
  tripWriterCircuit,
} from './writer-circuit-breaker';
import {
  writerCircuitBreakEvent,
  writerCircuitBreakers,
} from './writer-circuit-break';


/** Mortes sem entrega que cortam o circuito (régua do Orca #13927 = 3;
 * docs da campanha 0.50 prometiam ≤3 e a régua 10 notava tarde demais —
 * missão real: 13/20 panes mortos antes de alguém perceber). */
export const WORKER_MORTALITY_CIRCUIT_BREAK = 3;

export function shouldTripWorkerMortalityBreaker(
  deathsWithoutDelivery: number,
): boolean {
  return deathsWithoutDelivery >= WORKER_MORTALITY_CIRCUIT_BREAK;
}

const deathsByMissionAdapter = new Map<string, number>();

function key(missionId: string, adapterId: string): string {
  return `${missionId}:${adapterId}`;
}


/** Handoff mínimo para provar que o pane entregou (session ou nome). */
export type WorkerDeliveryHandoff = {
  readonly sessionId?: string | null;
  readonly fromAgent?: string | null;
};

/** Pane mínimo usado pelo classificador de mortalidade. */
export type WorkerDeliveryPane = {
  readonly sessionId?: string | null;
  readonly agentName?: string | null;
  readonly title?: string | null;
};

function normalizeAgentLabel(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Exit pós-entrega NÃO é mortalidade. AGY/OpenCode one-shot (`--print` / `run`)
 * somem depois do handoff e o snapshot pode perder sessionId; o fromAgent
 * (Frontend, Reviewer) ainda casa com agentName/title do pane.
 * Autores sintéticos `nexus-*` não contam — supervisor zero-delivery não é
 * prova de vida do worker.
 */
export function workerPaneHasDelivery(
  pane: WorkerDeliveryPane,
  handoffs: readonly WorkerDeliveryHandoff[],
): boolean {
  const sessionId = pane.sessionId?.trim() ?? '';
  const names = new Set(
    [pane.agentName, pane.title]
      .map((value) => normalizeAgentLabel(value))
      .filter((value) => value.length > 0),
  );
  return handoffs.some((handoff) => {
    const from = normalizeAgentLabel(handoff.fromAgent);
    if (from.startsWith('nexus-')) return false;
    if (sessionId.length > 0 && handoff.sessionId === sessionId) return true;
    return from.length > 0 && names.has(from);
  });
}

function writerKey(missionId: string, adapterId: string) {
  return {
    missionId,
    adapterId,
    role: 'worker',
  } as const;
}

/**
 * F-918: nem todo pane `exited` sem entrega é a CLI morrendo sozinha. Morte
 * causada por reinício/shutdown do app (o pane aparece como `exited` no boot
 * seguinte sem que nenhum exit tenha sido observado neste processo) e pane
 * fechado por pedido (orquestrador/operador/guardian, via `nexus_pane_close`
 * ou dispensa na UI) NÃO alimentam o breaker — só a CLI que saiu sozinha.
 */
export interface SpontaneousWorkerDeathInput {
  readonly state: 'exited' | 'hibernated';
  /** O exit do PTY foi observado neste processo (tap de exit). */
  readonly exitObserved?: boolean;
  /** F-231: mão do operador — nunca mortalidade. */
  readonly operatorOpened?: boolean;
  /** Fechado por `requestPaneClose` (pedido, não morte espontânea). */
  readonly deliberatelyClosed?: boolean;
  /** Dispensado pelo operador na UI (× no grid). */
  readonly operatorDismissed?: boolean;
}

export function isSpontaneousWorkerDeath(
  input: SpontaneousWorkerDeathInput,
): boolean {
  if (input.operatorOpened === true) return false;
  if (input.deliberatelyClosed === true) return false;
  if (input.operatorDismissed === true) return false;
  // Hibernado mantém o comportamento histórico (conta); só o `exited`
  // exige exit observado — é ele que o reinício do app forja sem prova.
  if (input.state === 'hibernated') return true;
  return input.exitObserved === true;
}

export function recordWorkerDeathWithoutDelivery(
  missionId: string,
  adapterId: string,
): number {
  const k = key(missionId, adapterId);
  const next = (deathsByMissionAdapter.get(k) ?? 0) + 1;
  deathsByMissionAdapter.set(k, next);
  const circuit = writerKey(missionId, adapterId);
  writerCircuitBreakers.recordConnectFailure(circuit);
  recordWriterConnectFailure(circuit);
  if (shouldTripWorkerMortalityBreaker(next) && next === WORKER_MORTALITY_CIRCUIT_BREAK) {
    // Trip explícito: a régua de mortalidade (3) é menor que a de connect
    // failures (10) — sem isto, o adapter morto continuava sentando.
    writerCircuitBreakers.trip(circuit);
    tripWriterCircuit(circuit);
    logWriterCircuitBreak({
      adapterId,
      attempts: next,
      role: 'worker',
      missionId,
    });
    console.warn(
      writerCircuitBreakEvent({
        key: circuit,
        failures: next,
        action: 'skip-silent',
      }).kind,
      `adapter=${adapterId} attempts=${next} mission=${missionId}`,
    );
  }
  return next;
}

export function recordAdapterProofOfLife(
  missionId: string,
  adapterId: string,
): void {
  deathsByMissionAdapter.delete(key(missionId, adapterId));
  const circuit = writerKey(missionId, adapterId);
  writerCircuitBreakers.recordConnectSuccess(circuit);
  clearWriterConnectFailures(circuit);
}

export function workerMortalityCount(
  missionId: string,
  adapterId: string,
): number {
  return deathsByMissionAdapter.get(key(missionId, adapterId)) ?? 0;
}

export function resetMissionWorkerMortality(missionId: string): void {
  for (const k of [...deathsByMissionAdapter.keys()]) {
    const sep = k.lastIndexOf(':');
    const m = sep < 0 ? k : k.slice(0, sep);
    if (m === missionId) deathsByMissionAdapter.delete(k);
  }
}

export function workerMortalityBreakerMessage(
  adapterId: string,
  deaths: number,
): string {
  return (
    `writer_circuit_break: circuit breaker de mortalidade: ${deaths} workers ` +
    `do adapter "${adapterId}" morreram sem entregar NADA nesta missão. O ` +
    `spawn de worker deste adapter está recusado — delegue para outro ` +
    `agente do roster (equivalente ao reroute) e siga o plano.`
  );
}
