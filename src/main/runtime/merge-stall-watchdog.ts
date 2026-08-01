import type {
  MergeQueueEntry,
  MergeQueueIntegrationState,
  MergeQueueStateSnapshot,
} from './merge-queue-contract';

/**
 * Watchdog de merge estagnado NO MESMO processo.
 *
 * Design destilado do in-flight deadline da fila de eventos do block/buzz
 * (Apache-2.0) — `EventQueue.in_flight_deadline` em
 * crates/buzz-acp/src/queue.rs (cópia local de referência usada na destilação:
 * scratchpad/buzz-repo/crates/buzz-acp/src/queue.rs). A regra de ouro portada:
 * NADA fica in-flight para sempre — toda entrada em processamento carrega um
 * deadline derivado do timeout da operação + buffer (buzz: max_turn + 100s), e
 * um tick que encontra deadline vencido NÃO a deixa lá: move para dead-letter
 * com erro acionável e libera os recursos presos.
 *
 * A recovery do merge queue cobre interrupção por REINÍCIO; a regra documentada
 * em merge-queue.ts ("never interrupts a local operation still owned by this
 * queue instance") faz `reconcileIfIdle` desistir enquanto a instância viva
 * tiver um tail registrado. Quando o próprio processo abandona o merge (promise
 * solta, erro engolido, git que não voltou), a entrada não tem lease nem
 * heartbeat — flagrado ao vivo em 31/07/2026: `candidate-validating` parado
 * 22,7 min com `blocked: null`, nenhum processo de validação existindo e o
 * driver tickando 91 vezes com applied=0. A missão espera para sempre, sem erro
 * nenhum para mostrar.
 *
 * A idade é o único sinal disponível: uma entrada ativa cujo `updatedAt` não
 * anda há mais tempo que o MAIOR bound legítimo de validação está provadamente
 * abandonada — validações saudáveis transicionam de status (e portanto tocam
 * `updatedAt`) dentro do bound.
 */

/**
 * Maior bound legítimo de uma validação de candidato viva: o merge council
 * roda como participante do scheduler e o timeout real dessa operação é
 * MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS = 21 min
 * (src/main/orch/orchestration-coordinator.ts — ele próprio dimensionado para
 * não preemptar o bound de 20 min do council no gate físico empacotado).
 *
 * O valor é espelhado aqui em vez de importado: importar o coordinator criaria
 * um ciclo runtime→orch→runtime cuja avaliação parcial deixaria a constante
 * indefinida (e o deadline NaN — que faria TODA entrada parecer estagnada).
 * orchestration-coordinator.test.ts trava o espelho contra drift.
 */
export const MERGE_VALIDATION_UPPER_BOUND_MS = 21 * 60_000;

/**
 * Folga além do timeout da operação, no espírito do buzz
 * (deadline = max_turn + 100s de buffer; o deadline NUNCA é menor que o
 * timeout): cobre o custo fora da validação em si — merge-tree, worktree add,
 * persistência CAS — entre dois toques em `updatedAt`. Disparar cedo demais
 * mataria uma validação viva, que é pior do que esperar alguns minutos a mais.
 */
export const STALL_DEADLINE_BUFFER_MS = 4 * 60_000;

/** Deadline efetivo: timeout real da validação + buffer (25 min). */
export const STALLED_MERGE_ATTEMPT_MS =
  MERGE_VALIDATION_UPPER_BOUND_MS + STALL_DEADLINE_BUFFER_MS;

const ACTIVE_MERGE_STATUSES: ReadonlySet<MergeQueueEntry['status']> = new Set([
  'candidate-validating',
  'integrating',
  'post-validating',
  'finalizing',
]);

/**
 * Entrada ativa provadamente estagnada, ou null. Puro de propósito: a decisão
 * de idade é a parte que precisa de teste; derrubar o tail e reconciliar são
 * mecânica já coberta pela recovery.
 */
export function findStalledActiveMergeEntry(
  snapshot: Pick<MergeQueueStateSnapshot, 'activeTaskKey' | 'entries'>,
  nowMs: number,
  stalledForMs: number = STALLED_MERGE_ATTEMPT_MS,
): MergeQueueEntry | null {
  if (!snapshot.activeTaskKey) return null;
  const entry = snapshot.entries.find(
    (candidate) => candidate.taskKey === snapshot.activeTaskKey,
  );
  if (!entry) return null;
  if (!ACTIVE_MERGE_STATUSES.has(entry.status)) return null;
  const updatedAt = entry.updatedAt;
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  if (nowMs - updatedAt < stalledForMs) return null;
  return entry;
}

/**
 * Contexto passado à recovery quando o gatilho é o watchdog (e não um
 * reinício). Faz o dead-letter trocar o texto genérico de interrupção por um
 * reason acionável: o que a tentativa estava fazendo, há quanto tempo estava
 * parada e o que destrava a fila.
 */
export interface MergeReconcileStallContext {
  /** Idade da entrada (now - updatedAt) quando o watchdog disparou, em ms. */
  readonly stalledForMs: number;
}

/**
 * Reason acionável do dead-letter de merge estagnado. O buzz loga o expiry com
 * channel, eventos perdidos e deadline; aqui o equivalente vai para o bloqueio
 * durável (que o produto apresenta como falha com CTA), não só para o log.
 */
export function stalledMergeReason(
  entry: Pick<MergeQueueEntry, 'attempt' | 'status'>,
  integrationState: MergeQueueIntegrationState,
  disposition: 'retryable' | 'terminal',
  stalledForMs: number,
): string {
  const stalledMinutes = Math.max(1, Math.round(stalledForMs / 60_000));
  const operatorAction =
    disposition === 'retryable'
      ? 'O retry automático do scheduler pode reprocessar esta task sem ' +
        'wizard; a fila volta a processar as demais entradas.'
      : 'A task foi marcada como failed; use o fluxo de retomar/retry da ' +
        'missão com nova evidência para destravar a fila.';
  return (
    `merge attempt ${entry.attempt} estagnado há ${stalledMinutes} min em ` +
    `${entry.status} no mesmo processo — o watchdog de deadline descartou a ` +
    `tentativa abandonada (estado de integração: ${integrationState}). ` +
    operatorAction
  );
}
