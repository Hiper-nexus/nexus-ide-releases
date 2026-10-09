/**
 * Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62.
 * Copyright (c) 2026 T3 Tools Inc. — MIT License.
 * See third_party/licenses/t3code-MIT.txt.
 * Upstream references: apps/server/src/orchestration-v2/EffectOutbox.ts, apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts.
 * Nexus changes: Uses upstream process-loss classification/error detail policy through Nexus scoped stores; coordinates recovery fail-closed and keeps unsettled receipts. No provider runtime/session reconstruction is ported.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  blockUnreconciledEffectOutbox,
  clearUnreconciledEffectOutbox,
  EffectOutboxStore,
} from './effect-outbox';
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

export class ProviderRuntimeRecoveryError extends Error {
  readonly failedScopes: readonly {
    projectId: string;
    checkoutId: string;
  }[];

  constructor(
    failedScopes: readonly Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>[],
  ) {
    super(
      `provider runtime reconcile failed for ${failedScopes.length} scope(s)`,
    );
    this.name = 'ProviderRuntimeRecoveryError';
    this.failedScopes = failedScopes.map((scope) => ({
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    }));
  }
}

const reconciledThisProcess = new Set<string>();

function reconciledScopeKey(
  runtimeManager: ProjectRuntimeManager,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): string {
  return `${runtimeManager.baseDirectory}\0${scope.projectId}\0${scope.checkoutId}`;
}

export function reconcileProviderRuntimeAtBoot(
  deps: ProviderRuntimeRecoveryDeps,
): ProviderRuntimeRecoveryResult {
  const key = reconciledScopeKey(deps.runtimeManager, deps.scope);
  if (reconciledThisProcess.has(key)) {
    return { cancelledEffects: 0, requeuedEffects: 0, unsettledReceipts: 0 };
  }
  try {
    const outbox = new EffectOutboxStore(deps.runtimeManager, deps.scope, {
      now: deps.now,
    });
    const receipts = new CommandReceiptStore(deps.runtimeManager, deps.scope, {
      now: deps.now,
    });
    const settled = outbox.reconcileAfterProcessLoss();
    const unsettledReceipts = receipts.countUnsettled();
    clearUnreconciledEffectOutbox(deps.scope);
    reconciledThisProcess.add(key);
    return {
      cancelledEffects: settled.cancelled,
      requeuedEffects: settled.requeued,
      unsettledReceipts,
    };
  } catch (error) {
    blockUnreconciledEffectOutbox(deps.scope);
    throw error;
  }
}

/**
 * Passe multi-escopo. Um escopo que lança não interrompe os demais, mas o
 * agregado não volta como sucesso: o escopo que não reconciliou fica
 * bloqueado para `claimNext` e o erro lista quais falharam.
 */
export function reconcileProviderRuntimesAtBoot(
  runtimeManager: ProjectRuntimeManager,
  scopes: readonly ProjectExecutionScope[],
): ProviderRuntimeRecoveryResult {
  let cancelledEffects = 0;
  let requeuedEffects = 0;
  let unsettledReceipts = 0;
  const failedScopes: { projectId: string; checkoutId: string }[] = [];
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
      failedScopes.push({
        projectId: scope.projectId,
        checkoutId: scope.checkoutId,
      });
      console.warn(
        `[provider-runtime-recovery] scope reconcile failed ` +
          `(project=${scope.projectId}, checkout=${scope.checkoutId}):`,
        error,
      );
    }
  }
  if (failedScopes.length > 0) {
    throw new ProviderRuntimeRecoveryError(failedScopes);
  }
  return { cancelledEffects, requeuedEffects, unsettledReceipts };
}
