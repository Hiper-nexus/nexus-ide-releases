import type { PeriodicTaskContext } from '../observability/periodic-task';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  EffectOutboxStore,
  type EffectOutboxEntry,
} from './effect-outbox';

/**
 * ORC-01 worker — drena o outbox transacional (porte da política T3
 * `EffectWorker.ts`; casca reescrita em async/await).
 *
 * Claim é por lease. Crash entre claim e succeed é assentado por
 * `reconcileAfterProcessLoss` (ORC-06), não pelo worker. O worker só move
 * `pending → running → settled` enquanto o processo vive e é o dono do lease.
 */

export type EffectOutboxHandler = (
  entry: EffectOutboxEntry,
  scope: ProjectExecutionScope,
) => Promise<void> | void;

export interface EffectOutboxWorkerDeps {
  readonly store: EffectOutboxStore;
  readonly scope: ProjectExecutionScope;
  readonly handler: EffectOutboxHandler;
  readonly workerId: string;
  readonly leaseDurationMs?: number;
  readonly batchSize?: number;
  /** Backoff base para `retry` de replay_safe que falhou transitório. */
  readonly retryDelayMs?: number;
}

export interface EffectOutboxWorkerResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly retried: number;
}

/**
 * Um passe do worker. Seguro de repetir: cada linha é claimada uma vez e
 * assentada exatamente uma vez pelo dono do lease. Handler que lança assenta
 * pela classe (process_bound falha; replay_safe retenta com backoff).
 */
export async function drainEffectOutbox(
  deps: EffectOutboxWorkerDeps,
  context?: PeriodicTaskContext,
): Promise<EffectOutboxWorkerResult> {
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? 16, 64));
  const leaseDurationMs = deps.leaseDurationMs ?? 30_000;
  const retryDelayMs = deps.retryDelayMs ?? 1_000;
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;
  let retried = 0;
  // Um passe não reivindica de novo o que já tentou (retry devolve a pending
  // com backoff; re-pegá-la no mesmo laço viraria spin).
  const attempted = new Set<string>();
  for (let i = 0; i < batchSize; i += 1) {
    await context?.checkpoint();
    const entry = deps.store.claimNext({
      workerId: deps.workerId,
      leaseDurationMs,
      excludeIds: attempted,
    });
    if (!entry) break;
    attempted.add(entry.id);
    claimed += 1;
    try {
      const outcome = deps.handler(entry, deps.scope);
      if (context) await context.wait(Promise.resolve(outcome));
      else await outcome;
      if (deps.store.succeed(entry.id, deps.workerId)) succeeded += 1;
    } catch (error) {
      let cancellation: unknown;
      try {
        context?.assertCurrent();
      } catch (currentError) {
        cancellation = currentError;
      }
      const surfaced = cancellation ?? error;
      const reason =
        surfaced instanceof Error
          ? surfaced.message
          : cancellation
            ? 'effect outbox worker cancelled'
            : 'effect outbox handler failed';
      if (entry.class === 'replay_safe') {
        if (
          deps.store.retry(
            entry.id,
            deps.workerId,
            reason,
            cancellation ? 0 : retryDelayMs,
          ) &&
          !cancellation
        ) {
          retried += 1;
        }
      } else if (
        deps.store.fail(entry.id, deps.workerId, reason) &&
        !cancellation
      ) {
        failed += 1;
      }
      if (cancellation) throw cancellation;
      console.warn(
        `[effect-outbox] handler failed (${entry.class} ${entry.type} ${entry.id}):`,
        error,
      );
    }
  }
  return { claimed, succeeded, failed, retried };
}
