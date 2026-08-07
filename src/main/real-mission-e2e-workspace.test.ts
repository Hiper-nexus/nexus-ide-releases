import { describe, expect, it } from "vitest";

import { BUILTIN_ADAPTERS } from "../adapters/builtin";
import { adapterSchema } from "../shared/adapter-types";
import { isHarnessAdvisorAdapter } from "./real-mission-e2e-workspace";

describe("real mission advisor adapter validation", () => {
  function builtin(id: string) {
    return adapterSchema.parse(
      BUILTIN_ADAPTERS.find(
        (adapter) => (adapter as { id?: unknown }).id === id,
      ),
    );
  }

  it("accepts AGY through its authenticated mission shim without fake MCP", () => {
    const agy = builtin("agy");

    expect(agy.quirks.nexusMcp).toBe("none");
    expect(isHarnessAdvisorAdapter("agy", agy)).toBe(true);
  });

  it("keeps MCP mandatory for every advisor other than AGY", () => {
    const opencode = builtin("opencode");
    if (opencode.kind !== "cli-pty") {
      throw new Error("OpenCode builtin must be cli-pty");
    }

    expect(
      isHarnessAdvisorAdapter("opencode", {
        ...opencode,
        quirks: {
          ...opencode.quirks,
          nexusMcp: "none",
        },
      }),
    ).toBe(false);
  });

  it("rejects AGY when its adapter advertises a nonexistent MCP route", () => {
    const agy = builtin("agy");
    if (agy.kind !== "cli-pty") {
      throw new Error("AGY builtin must be cli-pty");
    }

    expect(
      isHarnessAdvisorAdapter("agy", {
        ...agy,
        quirks: {
          ...agy.quirks,
          nexusMcp: "agy",
        },
      }),
    ).toBe(false);
  });
});
