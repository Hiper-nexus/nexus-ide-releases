import {
  hasTeamReadOnlyFanoutDomain,
  type StandardMissionTopology,
} from "../../shared/mission-topology";
import { decodeTaskScheduleDetail } from "./mission-scheduler-meta";

export type SealedStandardMissionTopology =
  | StandardMissionTopology
  | "invalid";

/**
 * Recovers standard-lane topology from immutable task bytes.
 *
 * A fan-out is authorized only when every sealed task carries the marker. A
 * uniformly unmarked (including legacy) receipt remains delivery, while mixed
 * authority is invalid and must be replanned/reapproved before execution.
 */
export function standardTopologyFromSealedTaskDetails(
  details: readonly string[],
): SealedStandardMissionTopology {
  if (details.length === 0) return "delivery";
  const fanoutTaskCount = details.reduce((count, detail) => {
    const domains =
      decodeTaskScheduleDetail(detail).meta?.ownership.domains ?? [];
    return count + (hasTeamReadOnlyFanoutDomain(domains) ? 1 : 0);
  }, 0);
  if (fanoutTaskCount === 0) return "delivery";
  if (fanoutTaskCount === details.length) return "team-read-only-fanout";
  return "invalid";
}
