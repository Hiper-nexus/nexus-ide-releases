import { describe, expect, it } from "vitest";
import {
  MergeAuthorityRevokedError,
  MergeCasError,
  MergeConflictError,
  MergeOperationAbortedError,
  MergeQueuePersistenceError,
  MergeQueueStateError,
  MergeValidationRejectedError,
} from "./merge-queue-contract";
import { RetiredRosterRouteError } from "../../shared/retired-adapter-policy";
import { classifyOperationalFailure } from "./operational-failure-policy";

describe("operational failure policy", () => {
  it.each([
    new Error("reviewer timed out"),
    new Error("pane spawn failed"),
    new Error("route unavailable"),
    new Error("provider exited during boot"),
  ])("keeps technical failure retryable: %s", (error) => {
    expect(classifyOperationalFailure(error)).toBe("retryable");
  });

  it("routes quality rejection to repair without terminally blocking", () => {
    expect(
      classifyOperationalFailure(
        new MergeValidationRejectedError("candidate", ["review:finding"]),
      ),
    ).toBe("repair");
  });

  it("keeps parent merge cancellation retryable", () => {
    expect(
      classifyOperationalFailure(
        new MergeOperationAbortedError(new Error("reconciler stopped")),
      ),
    ).toBe("retryable");
  });

  it("separates transient queue storage failure from invalid durable state", () => {
    expect(
      classifyOperationalFailure(
        new MergeQueuePersistenceError("sqlite busy"),
      ),
    ).toBe("retryable");
    expect(
      classifyOperationalFailure(
        new MergeQueueStateError("active entry disappeared"),
      ),
    ).toBe("terminal");
  });

  it.each([
    new MergeConflictError(),
    new MergeCasError("checkout changed"),
    new MergeAuthorityRevokedError(),
  ])("keeps proven conflict, CAS, and authority failures terminal", (error) => {
    expect(classifyOperationalFailure(error)).toBe("terminal");
  });

  it("classifies a retired sealed provider as terminal for the current revision", () => {
    expect(
      classifyOperationalFailure(
        new RetiredRosterRouteError("omp", "legacy-reviewer"),
      ),
    ).toBe("terminal");
  });
});
