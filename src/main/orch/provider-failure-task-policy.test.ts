import { describe, expect, it } from "vitest";
import { decideProviderFailureTaskPolicy } from "./provider-failure-task-policy";

describe("provider failure task policy", () => {
  it("waives a root guided advisory without consumers on short-window hits", () => {
    for (const guidedTaskKind of ["advisory", "isolated-advisory"] as const) {
      for (const hitKind of ["rate-limit", "auth", "transient"] as const) {
        expect(
          decideProviderFailureTaskPolicy({
            guidedTaskKind,
            dependsOn: [],
            consumers: [],
            hitKind,
          }),
        ).toEqual({ decision: "waive" });
      }
    }
  });

  it("never waives executor/implementation, review, quality-gate or non-guided tasks", () => {
    for (const guidedTaskKind of [
      "implementation",
      "independent-review",
      "quality-gate",
      null,
    ] as const) {
      const decision = decideProviderFailureTaskPolicy({
        guidedTaskKind,
        dependsOn: [],
        consumers: [],
        hitKind: "rate-limit",
      });
      expect(decision.decision).toBe("retry-required");
      expect(decision).toHaveProperty("reason");
    }
  });

  it("never waives on quota hits (long usage window)", () => {
    expect(
      decideProviderFailureTaskPolicy({
        guidedTaskKind: "advisory",
        dependsOn: [],
        consumers: [],
        hitKind: "quota",
      }).decision,
    ).toBe("retry-required");
  });

  it("refuses an advisory that is not a sealed-plan root", () => {
    const decision = decideProviderFailureTaskPolicy({
      guidedTaskKind: "advisory",
      dependsOn: ["task-producer"],
      consumers: [],
      hitKind: "rate-limit",
    });
    expect(decision.decision).toBe("not-eligible");
  });

  it("refuses an advisory with dependent consumers in the sealed plan", () => {
    const decision = decideProviderFailureTaskPolicy({
      guidedTaskKind: "isolated-advisory",
      dependsOn: [],
      consumers: ["task-consumer"],
      hitKind: "auth",
    });
    expect(decision.decision).toBe("not-eligible");
    expect(decision).toHaveProperty(
      "reason",
      expect.stringContaining("task-consumer"),
    );
  });
});
