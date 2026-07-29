import type { Handoff } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  onHandoffSubmitted,
  recoverAcceptedSchedulerHandoffDelivery,
} from "./idle-delivery";
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
  readonly recoverAccepted?: (
    handoff: Handoff,
    scope: ProjectExecutionScope,
  ) => unknown;
}

/**
 * Queued and accepted-but-not-consumed handoffs form the durable outbox.
 *
 * The submit transaction writes that state before any in-memory enqueue or
 * Pet Studio completion callback. Accepted scheduler delivery is also replayed
 * after a crash before consumption. Reconciliation is safe to repeat: queued
 * PTY work deduplicates and accepted consumption uses the exact durable CAS.
 */
export function reconcilePendingHandoffDeliveryOutbox(
  dependencies: HandoffDeliveryOutboxDependencies = {},
): HandoffDeliveryOutboxResult {
  const suites =
    dependencies.suites ??
    requireProjectDomainStoreRegistry().listSuites();
  const deliver = dependencies.deliver ?? onHandoffSubmitted;
  const recoverAccepted =
    dependencies.recoverAccepted ??
    recoverAcceptedSchedulerHandoffDelivery;
  let attempted = 0;
  let failed = 0;
  for (const suite of suites) {
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
    for (const handoff of pending) {
      attempted += 1;
      try {
        if (
          handoff.delivered &&
          (handoff.deliveryState === "submitted" ||
            handoff.deliveryState === "acknowledged")
        ) {
          recoverAccepted(handoff, suite.scope);
        } else {
          deliver(handoff, suite.scope);
        }
      } catch (error) {
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
