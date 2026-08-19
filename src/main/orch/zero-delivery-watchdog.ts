/**
 * Watchdog de zero entrega: missão running, workers presentes, 0 handoffs de
 * worker — o Maestro "dormiu aguardando handoff" e o disco ficou vazio.
 * Poke curto; não depende de morte de processo.
 */

export const ZERO_DELIVERY_POKE_MS = 3 * 60_000;
export const ZERO_DELIVERY_ESCALATE_MS = 8 * 60_000;

export type ZeroDeliveryDecision =
  | { readonly action: 'none' }
  | { readonly action: 'poke'; readonly sinceMs: number }
  | { readonly action: 'escalate'; readonly sinceMs: number };

export function decideZeroDeliveryWatchdog(input: {
  readonly missionStatus: string;
  readonly lane?: string | null;
  readonly workerPanes: number;
  /** Handoffs submetidos por workers (não supervisor/sistema). */
  readonly workerHandoffCount: number;
  readonly orchestratorState?: string | null;
  /** Epoch ms do despacho / início de execução (não arm). */
  readonly executingSinceMs: number | null;
  readonly now: number;
  /** Já houve poke de zero-entrega nesta missão. */
  readonly alreadyPoked: boolean;
}): ZeroDeliveryDecision {
  if (input.missionStatus !== 'running' && input.missionStatus !== 'pending') {
    return { action: 'none' };
  }
  if (input.lane === 'plan' || input.lane === 'consult') {
    return { action: 'none' };
  }
  if (input.workerPanes <= 0) return { action: 'none' };
  if (input.workerHandoffCount > 0) return { action: 'none' };
  if (input.executingSinceMs == null) return { action: 'none' };
  // Maestro busy ainda pode estar despachando — não interromper.
  if (
    input.orchestratorState === 'busy' ||
    input.orchestratorState === 'spawning'
  ) {
    return { action: 'none' };
  }
  const since = input.now - input.executingSinceMs;
  if (since < ZERO_DELIVERY_POKE_MS) return { action: 'none' };
  if (!input.alreadyPoked) {
    return { action: 'poke', sinceMs: since };
  }
  if (since >= ZERO_DELIVERY_ESCALATE_MS) {
    return { action: 'escalate', sinceMs: since };
  }
  return { action: 'none' };
}

export function zeroDeliveryPokeSummary(missionId: string, sinceMs: number): string {
  const minutes = Math.max(1, Math.round(sinceMs / 60_000));
  return (
    `[zero-delivery:${missionId}] Sem handoff nem arquivos após ${minutes}min. ` +
    'O trabalhador não entregou. Se ele perguntou cor/fonte ao operador, isso é ' +
    'bloqueio — reabra com "não pergunte, decida e entregue handoff com arquivos". ' +
    'Peça arquivos disjuntos no MESMO turno (files=) e não encerre sem prova de entrega.'
  );
}

export function zeroDeliveryEscalateSummary(missionId: string): string {
  return (
    `[zero-delivery-escalate:${missionId}] Zero entrega persistente. Declare o ` +
    'worker anterior morto, re-roteie para Claude ou Codex e spawne de novo ' +
    'com o pedido completo — a missão não pode ficar em Trabalhando com disco vazio.'
  );
}
