import { describe, expect, it } from "vitest";

import { RealMissionE2EMissionInventoryFence } from "./real-mission-e2e-mission-inventory";

const mission = (id: string) => ({ id });

describe("RealMissionE2EMissionInventoryFence", () => {
  it("proves one selected mission from the observed union and final snapshot", () => {
    const fence = new RealMissionE2EMissionInventoryFence();

    expect(fence.observe([])).toBe(true);
    expect(fence.observe([mission("mission-a")])).toBe(true);
    expect(fence.select("mission-a", [mission("mission-a")])).toBe(true);

    expect(fence.proof([mission("mission-a")])).toEqual({
      evidenceOrigin: "main-owned-mission-store-inventory",
      selectedMissionId: "mission-a",
      observedMissionCount: 1,
      observedMissionIds: ["mission-a"],
      finalMissionCount: 1,
      finalMissionIds: ["mission-a"],
      exactSingleProductMission: true,
    });
  });

  it("permanently rejects a second mission even when it is removed before finish", () => {
    const fence = new RealMissionE2EMissionInventoryFence();
    expect(fence.select("mission-a", [mission("mission-a")])).toBe(true);

    expect(
      fence.observe([mission("mission-a"), mission("mission-b")]),
    ).toBe(false);
    expect(fence.observe([mission("mission-a")])).toBe(false);

    expect(fence.proof([mission("mission-a")])).toMatchObject({
      observedMissionCount: 2,
      observedMissionIds: ["mission-a", "mission-b"],
      finalMissionCount: 1,
      finalMissionIds: ["mission-a"],
      exactSingleProductMission: false,
    });
  });

  it("rejects replacing or removing the selected mission", () => {
    for (const finalMissions of [[], [mission("mission-b")]]) {
      const fence = new RealMissionE2EMissionInventoryFence();
      expect(fence.select("mission-a", [mission("mission-a")])).toBe(true);
      expect(fence.observe(finalMissions)).toBe(false);
      expect(fence.proof(finalMissions).exactSingleProductMission).toBe(false);
    }
  });
});
