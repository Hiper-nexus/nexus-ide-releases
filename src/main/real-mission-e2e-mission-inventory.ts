import type { Mission } from "../shared/orch-types";
import type { RealMissionE2EEvidence } from "../shared/real-mission-e2e";

type MissionInventoryProof = RealMissionE2EEvidence["missionInventory"];
type MissionIdentity = Pick<Mission, "id">;

function normalizedMissionIds(
  missions: readonly MissionIdentity[],
): string[] {
  return [...new Set(missions.map((mission) => mission.id))].sort();
}

/**
 * Main-owned, monotonic inventory fence for the packaged release mission.
 *
 * `observedMissionIds` is a union, not merely the final store snapshot, so a
 * second mission cannot be created and removed between candidate and publish.
 * Every store change is captured synchronously by the caller and the final
 * snapshot is read again while producing evidence.
 */
export class RealMissionE2EMissionInventoryFence {
  readonly #observedMissionIds = new Set<string>();
  #selectedMissionId: string | null = null;
  #finalMissionIds: string[] = [];
  #violated = false;

  observe(missions: readonly MissionIdentity[]): boolean {
    const ids = normalizedMissionIds(missions);
    this.#finalMissionIds = ids;
    for (const id of ids) this.#observedMissionIds.add(id);

    if (
      this.#selectedMissionId !== null &&
      (ids.length !== 1 || ids[0] !== this.#selectedMissionId)
    ) {
      this.#violated = true;
    } else if (this.#selectedMissionId === null && ids.length > 1) {
      this.#violated = true;
    }
    return !this.#violated;
  }

  select(
    missionId: string,
    missions: readonly MissionIdentity[],
  ): boolean {
    if (
      this.#selectedMissionId !== null &&
      this.#selectedMissionId !== missionId
    ) {
      this.#violated = true;
    }
    this.#selectedMissionId = missionId;
    return this.observe(missions);
  }

  proof(missions: readonly MissionIdentity[]): MissionInventoryProof {
    this.observe(missions);
    const observedMissionIds = [...this.#observedMissionIds].sort();
    const finalMissionIds = [...this.#finalMissionIds];
    const exactSingleProductMission =
      !this.#violated &&
      this.#selectedMissionId !== null &&
      observedMissionIds.length === 1 &&
      observedMissionIds[0] === this.#selectedMissionId &&
      finalMissionIds.length === 1 &&
      finalMissionIds[0] === this.#selectedMissionId;
    return {
      evidenceOrigin: "main-owned-mission-store-inventory",
      selectedMissionId: this.#selectedMissionId,
      observedMissionCount: observedMissionIds.length,
      observedMissionIds,
      finalMissionCount: finalMissionIds.length,
      finalMissionIds,
      exactSingleProductMission,
    };
  }
}
