import type { Handoff } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import { onHandoffSubmitted } from "./idle-delivery";
import { requireProjectDomainStoreRegistry } from "./project-domain-store-registry";

export const HANDOFF_DELIVERY_OUTBOX_RECONCILE_MS = 1_000;

interface HandoffDeliveryOutboxSuite {
  readonly scope: ProjectExecutionScope;
  readonly handoffs: {
    list(filter: {
      readonly includeDelivered: boolean;
    }): readonly Handoff[];
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
 * `handoffs.delivery_state = queued` is the durable delivery outbox.
 *
 * The submit transaction writes that state before any in-memory enqueue or
 * Pet Studio completion callback. A crash/throw therefore leaves recoverable
 * work in SQLite. Reconciliation is safe to repeat: idle-delivery deduplicates
 * queued/pending PTY work and delivery-attempt reservation is a SQLite CAS.
 */
export function reconcilePendingHandoffDeliveryOutbox(
  dependencies: HandoffDeliveryOutboxDependencies = {},
): HandoffDeliveryOutboxResult {
  const suites =
    dependencies.suites ??
    requireProjectDomainStoreRegistry().listSuites();
  const deliver = dependencies.deliver ?? onHandoffSubmitted;
  let attempted = 0;
  let failed = 0;
  for (const suite of suites) {
    let pending: readonly Handoff[];
    try {
      pending = suite.handoffs.list({ includeDelivered: false });
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
        deliver(handoff, suite.scope);
      } catch (error) {
        failed += 1;
        console.warn(
          `[handoff-outbox] delivery callback failed; retained queued handoff ${handoff.id}:`,
          error,
        );
      }
    }
  }
  return { attempted, failed };
}
