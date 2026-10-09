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

export type EffectOutboxHandlerResult = void | { readonly defer: true };

export type EffectOutboxHandler = (
  entry: EffectOutboxEntry,
  scope: ProjectExecutionScope,
) => Promise<EffectOutboxHandlerResult> | EffectOutboxHandlerResult;

const dispatchCheckpointFlights = new Set<string>();

function dispatchCheckpointKey(
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  commandId: string,
): string {
  return `${scope.projectId}\0${scope.checkoutId}\0${commandId}`;
}

/** Segura o checkpoint até o handler real terminar. O dreno não assenta antes. */
export function retainDispatchCheckpoint(
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  commandId: string,
): () => void {
  const key = dispatchCheckpointKey(scope, commandId);
  dispatchCheckpointFlights.add(key);
  return () => {
    dispatchCheckpointFlights.delete(key);
  };
}

export function dispatchCheckpointInFlight(
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  commandId: string,
): boolean {
  return dispatchCheckpointFlights.has(dispatchCheckpointKey(scope, commandId));
}

function isDeferredEffectSettlement(
  value: unknown,
): value is { readonly defer: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { defer?: unknown }).defer === true
  );
}

/**
 * Registro de handlers por `type`. O coordenador drena pelo registro; quem
 * implementa um tipo de efeito (checkpoint.capture, turn.start…) registra
 * aqui no boot. Tipo sem handler falha de vez (não retenta): um efeito
 * enfileirado à mão sem handler não pode girar para sempre. Handler que
 * lança continua assentando pela classe.
 */
const effectHandlers = new Map<string, EffectOutboxHandler>();

export function registerEffectOutboxHandler(
  type: string,
  handler: EffectOutboxHandler,
): () => void {
  effectHandlers.set(type, handler);
  return () => {
    if (effectHandlers.get(type) === handler) effectHandlers.delete(type);
  };
}

export function registeredEffectHandler(
  type: string,
): EffectOutboxHandler | null {
  return effectHandlers.get(type) ?? null;
}

/**
 * Handler de produção do `checkpoint.capture`. O despacho já gravou o
 * recibo e o efeito juntos; o dreno assenta a obrigação que o gate espera.
 * A captura git do fim de turno continua em `captureWriterHandoffCheckpoint`.
 */
export function registerCheckpointCaptureHandler(): () => void {
  return registerEffectOutboxHandler('checkpoint.capture', (entry, scope) => {
    // A linha nasce antes do handler. Enquanto ele corre, voltar a pending
    // sem assentar: sucesso aqui fecharia a missão no meio da mutação.
    if (dispatchCheckpointInFlight(scope, entry.commandId)) {
      return { defer: true };
    }
    return undefined;
  });
}

export interface EffectOutboxWorkerDeps {
  readonly store: EffectOutboxStore;
  readonly scope: ProjectExecutionScope;
  /** Handler único; se omitido, usa `registerEffectOutboxHandler` por tipo. */
  readonly handler?: EffectOutboxHandler;
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
 * Um passe do worker. Cada linha é claimada uma vez neste passe e só a
 * tentativa daquele claim pode assentar (`attempt_count`). Handler que lança
 * assenta pela classe (process_bound falha; replay_safe retenta com backoff).
 * Enquanto o handler corre, o lease da mesma tentativa é renovado. Se o
 * processo morre, a renovação para e o próximo claim trata o lease vencido.
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
    deps.store.retainHandlerFlight(entry.id);
    const heartbeatMs = Math.max(1, Math.floor(leaseDurationMs / 3));
    let renewalWarned = false;
    const heartbeat = setInterval(() => {
      try {
        const renewed = deps.store.renewLease(
          entry.id,
          deps.workerId,
          entry.attemptCount,
          leaseDurationMs,
        );
        if (!renewed) clearInterval(heartbeat);
        else renewalWarned = false;
      } catch (error) {
        // Uma falha transitória não para o timer: o lease precisa
        // continuar sendo renovado enquanto o handler não assentou.
        if (!renewalWarned) {
          renewalWarned = true;
          console.warn(
            `[effect-outbox] lease renewal failed (${entry.class} ${entry.type} ${entry.id} attempt ${entry.attemptCount})`,
            error,
          );
        }
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      try {
        const handler = deps.handler ?? registeredEffectHandler(entry.type);
        if (!handler) {
          const reason = `effect outbox has no handler for ${entry.type}`;
          const released = deps.store.fail(
            entry.id,
            deps.workerId,
            reason,
            entry.attemptCount,
          );
          if (released) failed += 1;
          else {
            console.warn(
              `[effect-outbox] dropped settle (${entry.class} ${entry.type} ${entry.id} attempt ${entry.attemptCount})`,
            );
          }
          console.warn(
            `[effect-outbox] ${reason} (${entry.class} ${entry.id})`,
          );
          continue;
        }
        const pending = handler(entry, deps.scope);
        const settled = context
          ? await context.wait(Promise.resolve(pending))
          : await pending;
        if (isDeferredEffectSettlement(settled)) {
          const released = deps.store.retry(
            entry.id,
            deps.workerId,
            'effect still in flight',
            0,
            entry.attemptCount,
          );
          if (released) retried += 1;
          else {
            console.warn(
              `[effect-outbox] dropped defer (${entry.class} ${entry.type} ${entry.id} attempt ${entry.attemptCount})`,
            );
          }
          continue;
        }
        if (deps.store.succeed(entry.id, deps.workerId, entry.attemptCount)) {
          succeeded += 1;
        } else {
          console.warn(
            `[effect-outbox] dropped succeed (${entry.class} ${entry.type} ${entry.id} attempt ${entry.attemptCount})`,
          );
        }
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
        const released =
          entry.class === 'replay_safe'
            ? deps.store.retry(
                entry.id,
                deps.workerId,
                reason,
                cancellation ? 0 : retryDelayMs,
                entry.attemptCount,
              )
            : deps.store.fail(entry.id, deps.workerId, reason, entry.attemptCount);
        if (released && !cancellation) {
          if (entry.class === 'replay_safe') retried += 1;
          else failed += 1;
        } else if (!released) {
          console.warn(
            `[effect-outbox] dropped settle (${entry.class} ${entry.type} ${entry.id} attempt ${entry.attemptCount})`,
          );
        }
        if (cancellation) throw cancellation;
        console.warn(
          `[effect-outbox] handler failed (${entry.class} ${entry.type} ${entry.id}):`,
          error,
        );
      }
    } finally {
      clearInterval(heartbeat);
      deps.store.releaseHandlerFlight(entry.id);
    }
  }
  return { claimed, succeeded, failed, retried };
}
