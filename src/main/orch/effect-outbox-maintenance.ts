import type { PeriodicTaskContext } from '../observability/periodic-task';
import {
  EffectOutboxStore,
  SETTLED_EFFECT_RETENTION_MS,
  isUnreconciledEffectOutbox,
} from './effect-outbox';
import { drainEffectOutbox } from './effect-outbox-worker';
import { requireProjectDomainStoreRegistry } from './project-domain-store-registry';

/** Um lote de 500 por tick. O resto espera o próximo passe. */
const EFFECT_OUTBOX_PRUNE_BATCHES_PER_TICK = 1;

/**
 * Dreno de produção e poda dos efeitos já assentados. O coordinator chama
 * isto no relógio periódico. Recibos com operationId do chamador ficam;
 * só some o id gerado pelo despacho.
 */
export async function maintainEffectOutboxes(
  context?: PeriodicTaskContext,
): Promise<void> {
  const registry = requireProjectDomainStoreRegistry();
  const runtimeManager = registry.runtimeManager();
  for (const suite of registry.listSuites()) {
    await context?.checkpoint();
    if (isUnreconciledEffectOutbox(suite.scope)) continue;
    try {
      const store = new EffectOutboxStore(runtimeManager, suite.scope);
      await drainEffectOutbox(
        {
          store,
          scope: suite.scope,
          workerId: 'orchestration-coordinator',
        },
        context,
      );
      store.pruneSettled(
        SETTLED_EFFECT_RETENTION_MS,
        EFFECT_OUTBOX_PRUNE_BATCHES_PER_TICK,
      );
    } catch (error) {
      if (context?.signal.aborted) throw error;
      try {
        context?.assertCurrent();
      } catch (cancellation) {
        throw cancellation;
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[effect-outbox] manutenção do escopo ${suite.scope.projectId}/${suite.scope.checkoutId} falhou: ${detail}`,
      );
    }
  }
}
