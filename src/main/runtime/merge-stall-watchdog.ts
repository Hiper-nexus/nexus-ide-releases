import type {
  MergeQueueEntry,
  MergeQueueStateSnapshot,
} from './merge-queue-contract';

/**
 * Watchdog de merge estagnado NO MESMO processo.
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
 * O merge council tem bound de 10 min (20 min no gate físico empacotado — ver
 * MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS e o comentário do coordinator).
 * 25 min fica acima de todos os bounds legítimos com folga: disparar cedo
 * demais mataria uma validação viva, que é pior do que esperar 5 min a mais.
 */
export const STALLED_MERGE_ATTEMPT_MS = 25 * 60_000;

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
