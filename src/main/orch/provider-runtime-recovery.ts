import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { EffectOutboxStore } from './effect-outbox';
import { CommandReceiptStore } from './command-receipts';

/**
 * ORC-06 — reconciliação de boot do runtime do provider (porte da política T3
 * `EffectOutbox.reconcileAfterProcessLoss` + `ProviderRuntimeRecoveryService`
 * @ 26285ab; casca reescrita em better-sqlite).
 *
 * Um passe que terminaliza run não-terminal órfão, preserva filho app-owned
 * e separa efeito morto de efeito reexecutável:
 * - PROCESS_BOUND em `pending`/`running` → `cancelled` (não reexecuta —
 *   pane duplicado). Detalhe: "Cancelled because the server process ended
 *   before the effect completed."
 * - REPLAY_SAFE em `running` → `pending` (reentra). Detalhe: "Requeued after
 *   the previous server process ended."
 * - REPLAY_SAFE em `pending` já é reexecutável e fica.
 * - command_receipts com sequence 0 permanecem (marca honesta de "não
 *   assentado"; o T3 faz o mesmo de propósito).
 * - handoff-delivery-outbox NÃO é tocado (primeiro corte ORC-01).
 * - pane `operatorOpened` (filho app-owned) e worker de missão viva NUNCA
 *   são terminalizados por este passe (não vivem no effect_outbox).
 */

export interface ProviderRuntimeRecoveryDeps {
  readonly scope: ProjectExecutionScope;
  readonly runtimeManager: ProjectRuntimeManager;
  readonly now?: () => number;
}

export interface ProviderRuntimeRecoveryResult {
  /** PROCESS_BOUND pending/running → cancelled. */
  readonly cancelledEffects: number;
  /** REPLAY_SAFE running → pending. */
  readonly requeuedEffects: number;
  /** Recibos com sequence 0 (não assentados). */
  readonly unsettledReceipts: number;
}

export function reconcileProviderRuntimeAtBoot(
  deps: ProviderRuntimeRecoveryDeps,
): ProviderRuntimeRecoveryResult {
  const outbox = new EffectOutboxStore(deps.runtimeManager, deps.scope, {
    now: deps.now,
  });
  const receipts = new CommandReceiptStore(deps.runtimeManager, deps.scope, {
    now: deps.now,
  });
  const settled = outbox.reconcileAfterProcessLoss();
  const unsettledReceipts = receipts.listUnsettled().length;
  return {
    cancelledEffects: settled.cancelled,
    requeuedEffects: settled.requeued,
    unsettledReceipts,
  };
}

/**
 * Passe multi-escopo. Um escopo que lança não silencia os demais.
 */
export function reconcileProviderRuntimesAtBoot(
  runtimeManager: ProjectRuntimeManager,
  scopes: readonly ProjectExecutionScope[],
): ProviderRuntimeRecoveryResult {
  let cancelledEffects = 0;
  let requeuedEffects = 0;
  let unsettledReceipts = 0;
  for (const scope of scopes) {
    try {
      const result = reconcileProviderRuntimeAtBoot({
        scope,
        runtimeManager,
      });
      cancelledEffects += result.cancelledEffects;
      requeuedEffects += result.requeuedEffects;
      unsettledReceipts += result.unsettledReceipts;
    } catch (error) {
      console.warn(
        `[provider-runtime-recovery] scope reconcile failed ` +
          `(project=${scope.projectId}, checkout=${scope.checkoutId}):`,
        error,
      );
    }
  }
  return { cancelledEffects, requeuedEffects, unsettledReceipts };
}
