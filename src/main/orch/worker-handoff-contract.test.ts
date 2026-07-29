import { describe, expect, it, vi } from "vitest";

vi.mock("../persistence/settings-store", () => ({
  getOrchSettings: () => ({
    seniorMode: false,
    designPro: false,
    leanCode: false,
  }),
}));

import { LEGACY_MARKER } from "./legacy-handoff";
import { withHandoffContract } from "./worker-handoff-contract";

describe("worker handoff transport contract", () => {
  it("routes AGY 1.1 through the physical PTY stream instead of fake MCP", () => {
    const prompt = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp: "agy" },
    });

    expect(prompt).toContain(LEGACY_MARKER);
    expect(prompt).toContain('"status":"success"');
    expect(prompt).not.toContain("chamando a tool nexus_handoff_submit");
  });

  it("keeps physically usable MCP adapters on nexus_handoff_submit", () => {
    const prompt = withHandoffContract("Corrija o fluxo da missão.", {
      quirks: { mcpAutoload: false, nexusMcp: "opencode" },
    });

    expect(prompt).toContain("chamando a tool nexus_handoff_submit");
    expect(prompt).not.toContain(LEGACY_MARKER);
  });
});
