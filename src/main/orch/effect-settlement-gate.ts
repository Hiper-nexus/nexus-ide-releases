/**
 * Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied).
 * Upstream reference: apps/server/src/orchestration-v2/RunFinalizationService.ts.
 * Nexus changes: Pure Nexus blocking-effect predicate used by completion consumers; checkpoint/handoff names and synchronous views are Nexus contracts, not an upstream run-finalizer port.
 */
/**
 * ORC-02 — turno terminal ≠ efeitos assentados (política T3
 * `RunFinalizationService` / `feature-lifecycles.md` @ 26285ab).
 *
 * O evento de Stop/handoff NÃO marca settled enquanto `checkpoint.capture`
 * ou `handoff.deliver` estiver pending/running no outbox. O sucesso do efeito
 * assenta. Sem isso a prova de conclusão fecha o passo com entrega ou
 * snapshot ainda pending — missão parece travada ou "pronta" cedo.
 *
 * Módulo PURO: recebe o estado já lido, não toca banco nem relógio.
 */

export type SettlementEffectStatus = 'pending' | 'running';

/** Tipos cujo assentamento bloqueia o fim do turno (T3). */
export const BLOCKING_SETTLEMENT_EFFECT_TYPES = [
  'checkpoint.capture',
  'handoff.deliver',
] as const;

export type BlockingSettlementEffectType =
  (typeof BLOCKING_SETTLEMENT_EFFECT_TYPES)[number];

export interface SettlementEffectView {
  readonly type: string;
  readonly status: string;
  readonly threadId?: string;
  readonly commandId?: string;
}

export interface SettlementGateResult {
  readonly settled: boolean;
  readonly blocking: readonly SettlementEffectView[];
  readonly reason?: string;
}

function isBlockingType(type: string): type is BlockingSettlementEffectType {
  return (BLOCKING_SETTLEMENT_EFFECT_TYPES as readonly string[]).includes(type);
}

function isUnsettledStatus(status: string): status is SettlementEffectStatus {
  return status === 'pending' || status === 'running';
}

/**
 * Verdadeiro quando algum efeito bloqueador do `threadId` ainda não assentou.
 * Sem `threadId`, qualquer efeito bloqueador conta.
 */
export function hasUnsettledBlockingEffects(
  effects: readonly SettlementEffectView[],
  threadId?: string,
): boolean {
  return effects.some(
    (effect) =>
      isBlockingType(effect.type) &&
      isUnsettledStatus(effect.status) &&
      (threadId === undefined || effect.threadId === threadId),
  );
}

/**
 * O turno pode ser marcado settled? Só quando nenhum efeito bloqueador
 * resta pending/running. `succeeded`/`failed`/`cancelled` assentam.
 */
export function canMarkTurnSettled(
  effects: readonly SettlementEffectView[],
  threadId?: string,
): SettlementGateResult {
  const blocking = effects.filter(
    (effect) =>
      isBlockingType(effect.type) &&
      isUnsettledStatus(effect.status) &&
      (threadId === undefined || effect.threadId === threadId),
  );
  if (blocking.length === 0) {
    return { settled: true, blocking: [] };
  }
  return {
    settled: false,
    blocking,
    reason:
      `turno terminal com ${blocking.length} efeito(s) não assentado(s): ` +
      blocking.map((effect) => `${effect.type}=${effect.status}`).join(', '),
  };
}

/**
 * Política T3 `cancelUnsettled`: ao cancelar efeitos de um thread (fim de
 * missão, rollback), quais tipos bloqueadores ainda estão abertos.
 */
export function unsettledBlockingEffectIds(
  effects: readonly (SettlementEffectView & { readonly id: string })[],
  threadId: string,
): string[] {
  return effects
    .filter(
      (effect) =>
        effect.threadId === threadId &&
        isBlockingType(effect.type) &&
        isUnsettledStatus(effect.status),
    )
    .map((effect) => effect.id);
}
