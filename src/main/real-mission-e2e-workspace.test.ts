import { describe, expect, it } from "vitest";

import { BUILTIN_ADAPTERS } from "../adapters/builtin";
import { adapterSchema } from "../shared/adapter-types";
import { isHarnessAdvisorAdapter } from "./real-mission-e2e-workspace";

describe("real mission advisor adapter validation", () => {
  it("accepts AGY through its observable PTY handoff route without fake MCP", () => {
    const agy = adapterSchema.parse(
      BUILTIN_ADAPTERS.find(
        (adapter) => (adapter as { id?: unknown }).id === "agy",
      ),
    );

    expect(agy.quirks.nexusMcp).toBe("none");
    expect(isHarnessAdvisorAdapter("agy", agy)).toBe(true);
  });
});
