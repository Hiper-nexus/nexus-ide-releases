import type { PeriodicTaskContext } from '../observability/periodic-task';
import {
  EffectOutboxStore,
  SETTLED_EFFECT_RETENTION_MS,
  isUnreconciledEffectOutbox,
} from './effect-outbox';
import { CommandReceiptStore } from './command-receipts';
import { drainEffectOutbox } from './effect-outbox-worker';
import { requireProjectDomainStoreRegistry } from './project-domain-store-registry';

/** Um lote de 500 por tick. O resto espera o próximo passe. */
const EFFECT_OUTBOX_PRUNE_BATCHES_PER_TICK = 1;

/**
 * Dreno de produção e poda dos efeitos já assentados. O coordinator chama
 * isto no relógio periódico. Efeito físico só assenta pelo verifier registrado;
 * receipt retention separada preserva bindings explícitos/unknown e exige
 * sequência real e estado conhecido. Nenhum corpo de resultado é lido.
 */
export async function maintainEffectOutboxes(
  context?: PeriodicTaskContext,
): Promise<void> {
  const registry = requireProjectDomainStoreRegistry();
  const runtimeManager = registry.runtimeManager();
  const assertCurrent = (): void => {
    context?.assertCurrent();
    if (requireProjectDomainStoreRegistry() !== registry) {
      throw new Error('effect_outbox_maintenance_epoch_replaced');
    }
  };
  const publicId = (id: string): string => /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : 'invalid';
  for (const suite of registry.listSuites()) {
    await context?.checkpoint();
    assertCurrent();
    if (isUnreconciledEffectOutbox(suite.scope)) continue;
    try {
      const store = new EffectOutboxStore(runtimeManager, suite.scope);
      await drainEffectOutbox(
        { store, scope: suite.scope, workerId: 'orchestration-coordinator' },
        context,
      );
      // A revoked/replaced participant cannot write retention after its drain.
      await context?.checkpoint();
      assertCurrent();
      store.pruneSettled(SETTLED_EFFECT_RETENTION_MS, EFFECT_OUTBOX_PRUNE_BATCHES_PER_TICK);
      new CommandReceiptStore(runtimeManager, suite.scope).pruneGeneratedSettled({limit:100});
    } catch {
      // Global lifecycle loss is not a scope failure and must stop the pass.
      assertCurrent();
      // Preserve failed scope state. Its next pass can retry without starving
      // healthy suites or logging a corrupt payload/error/credential body.
      console.warn('[effect-outbox] scope-maintenance-failed', {
        projectId: publicId(suite.scope.projectId),
        checkoutId: publicId(suite.scope.checkoutId),
      });
    }
  }
}
