import {
  hasTeamReadOnlyFanoutDomain,
  type StandardMissionTopology,
} from "../../shared/mission-topology";
import { hasWavePackDomain } from "../../shared/mission-wave-pack";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";

export type SealedStandardMissionTopology =
  | StandardMissionTopology
  | "invalid";

/**
 * Recovers standard-lane topology from immutable task bytes.
 *
 * A fan-out / Pack graph is authorized only when every sealed task carries
 * one consistent marker. A uniformly unmarked (including legacy) receipt
 * remains delivery, while mixed authority is invalid and must be
 * replanned/reapproved before execution.
 */
export function standardTopologyFromSealedTaskDetails(
  details: readonly string[],
): SealedStandardMissionTopology {
  if (details.length === 0) return "delivery";
  let fanoutTaskCount = 0;
  let wavePackTaskCount = 0;
  for (const detail of details) {
    const domains =
      decodeTaskScheduleDetail(detail).meta?.ownership.domains ?? [];
    if (hasTeamReadOnlyFanoutDomain(domains)) fanoutTaskCount += 1;
    if (hasWavePackDomain(domains)) wavePackTaskCount += 1;
  }
  if (fanoutTaskCount === 0 && wavePackTaskCount === 0) return "delivery";
  if (wavePackTaskCount === details.length && fanoutTaskCount === 0) {
    return "wave-pack";
  }
  if (fanoutTaskCount === details.length && wavePackTaskCount === 0) {
    return "team-read-only-fanout";
  }
  return "invalid";
}
