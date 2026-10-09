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
  for (const suite of registry.listSuites()) {
    await context?.checkpoint();
    if (isUnreconciledEffectOutbox(suite.scope)) continue;
    const store = new EffectOutboxStore(runtimeManager, suite.scope);
    await drainEffectOutbox(
      {
        store,
        scope: suite.scope,
        workerId: 'orchestration-coordinator',
      },
      context,
    );
    // A participant revoked during the awaited drain cannot write retention.
    await context?.checkpoint();
    store.pruneSettled(
      SETTLED_EFFECT_RETENTION_MS,
      EFFECT_OUTBOX_PRUNE_BATCHES_PER_TICK,
    );
    new CommandReceiptStore(runtimeManager,suite.scope).pruneGeneratedSettled({limit:100});
  }
}
