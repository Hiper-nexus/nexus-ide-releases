import type { PeriodicTaskContext } from '../observability/periodic-task';
import type { Handoff } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { onHandoffSubmitted } from "./idle-delivery";
import { requireProjectDomainStoreRegistry } from "./project-domain-store-registry";

export const HANDOFF_DELIVERY_OUTBOX_RECONCILE_MS = 1_000;

interface HandoffDeliveryOutboxSuite {
  readonly scope: ProjectExecutionScope;
  readonly handoffs: {
    listDeliveryOutboxCandidates(): readonly Handoff[];
  };
}

export interface HandoffDeliveryOutboxResult {
  readonly attempted: number;
  readonly failed: number;
}

interface HandoffDeliveryOutboxDependencies {
  readonly suites?: readonly HandoffDeliveryOutboxSuite[];
  readonly deliver?: (
    handoff: Handoff,
    scope: ProjectExecutionScope,
  ) => unknown;
}

/**
 * Queued and accepted-but-not-consumed handoffs form the durable outbox.
 *
 * The submit transaction writes that state before any in-memory enqueue or
 * Pet Studio completion callback. Accepted scheduler delivery is re-proven
 * after a crash without synthesizing a Maestro ACK; its sealed topology owns
 * final settlement. Reconciliation is safe to repeat and queued PTY work
 * deduplicates by exact mission/session authority.
 */
export async function reconcilePendingHandoffDeliveryOutbox(
  dependencies: HandoffDeliveryOutboxDependencies = {},
  context?: PeriodicTaskContext,
): Promise<HandoffDeliveryOutboxResult> {
  const suites =
    dependencies.suites ??
    requireProjectDomainStoreRegistry().listSuites();
  const deliver = dependencies.deliver ?? onHandoffSubmitted;
  let attempted = 0;
  let failed = 0;
  for (const suite of suites) {
    await context?.checkpoint();
    let pending: readonly Handoff[];
    try {
      pending = suite.handoffs.listDeliveryOutboxCandidates();
    } catch (error) {
      failed += 1;
      console.warn(
        `[handoff-outbox] suite read failed; continuing with other projects ` +
          `(project=${suite.scope.projectId}, checkout=${suite.scope.checkoutId}):`,
        error,
      );
      continue;
    }
    for (const hint of pending) {
      await context?.checkpoint();
      const handoff = suite.handoffs.listDeliveryOutboxCandidates().find((live) => live.id === hint.id);
      if (!handoff) continue;
      attempted += 1;
      try {
        if (
          handoff.delivered &&
          (handoff.deliveryState === "submitted" ||
            handoff.deliveryState === "acknowledged")
        ) {
          // Aceito e aguardando o ACK explícito do Maestro: o caminho
          // cerimonial re-provava a autoridade do scheduler aqui; a Via
          // Rápida não tem dispatch durável a re-provar — nada a refazer.
        } else {
          const delivery = Promise.resolve(deliver(handoff, suite.scope));
          if (context) await context.wait(delivery); else await delivery;
        }
      } catch (error) {
        context?.assertCurrent();
        failed += 1;
        console.warn(
          `[handoff-outbox] delivery reconciliation failed; retained handoff ${handoff.id}:`,
          error,
        );
      }
    }
  }
  return { attempted, failed };
}
