/**
 * F-1002: orçamento dos spawns AUTOMÁTICOS de um pane cujo nascimento foi
 * recusado. Remontagem do React, replay da apresentação Main-owned e a espera
 * headless (waitForSession) re-armavam o spawn a cada sync; uma recusa
 * determinística do Main (ex.: a cerca do spawn persistido) virava um laço sem
 * fim — 49 tentativas de ~1 ms no "Claude · operador" em 07/10.
 *
 * Regra: no máximo AUTOMATIC_SPAWN_MAX_FAILURES falhas seguidas, com espera
 * crescente entre as tentativas automáticas. Esgotado, só uma ação explícita
 * do operador (Reiniciar, Retomar, fechar o pane) zera o orçamento. Sucesso
 * também zera.
 */

export const AUTOMATIC_SPAWN_MAX_FAILURES = 3;
/** Espera antes da 2ª e da 3ª tentativa automática. */
export const AUTOMATIC_SPAWN_BACKOFF_MS = [5_000, 30_000] as const;

export type AutomaticSpawnDecision = 'allow' | 'backoff' | 'exhausted';

interface SpawnFailureRecord {
  failures: number;
  lastFailureAt: number;
  lastError: string;
}

const failuresByPane = new Map<string, SpawnFailureRecord>();

export function automaticSpawnDecision(
  paneId: string,
  now: number,
): AutomaticSpawnDecision {
  const record = failuresByPane.get(paneId);
  if (!record) return 'allow';
  if (record.failures >= AUTOMATIC_SPAWN_MAX_FAILURES) return 'exhausted';
  const backoffMs =
    AUTOMATIC_SPAWN_BACKOFF_MS[
      Math.min(record.failures - 1, AUTOMATIC_SPAWN_BACKOFF_MS.length - 1)
    ];
  return now - record.lastFailureAt >= backoffMs ? 'allow' : 'backoff';
}

export interface SpawnFailureOutcome {
  /** Mesmo motivo da falha anterior: o pane já mostrou esta linha. */
  readonly repeated: boolean;
  /** Esta falha esgotou o orçamento — o aviso final sai uma vez, aqui. */
  readonly exhaustedNow: boolean;
  readonly failures: number;
}

export function recordAutomaticSpawnFailure(
  paneId: string,
  error: string,
  now: number,
): SpawnFailureOutcome {
  const previous = failuresByPane.get(paneId);
  const failures = (previous?.failures ?? 0) + 1;
  failuresByPane.set(paneId, { failures, lastFailureAt: now, lastError: error });
  return {
    repeated: previous?.lastError === error,
    exhaustedNow: failures === AUTOMATIC_SPAWN_MAX_FAILURES,
    failures,
  };
}

export function resetAutomaticSpawnBudget(paneId: string): void {
  failuresByPane.delete(paneId);
}

/** Aviso único no pane quando o Nexus para de tentar sozinho. */
export function automaticSpawnExhaustedNotice(error: string): string {
  return (
    `[nexus] o pane não abriu em ${AUTOMATIC_SPAWN_MAX_FAILURES} tentativas e o ` +
    `Nexus parou de tentar sozinho. Motivo: ${error}. Para resolver: use ` +
    'Reiniciar para tentar de novo agora; se o motivo continuar, feche este ' +
    'pane e abra outro pelo + Pane.'
  );
}
