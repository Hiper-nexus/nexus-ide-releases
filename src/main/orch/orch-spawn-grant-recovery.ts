/**
 * Civilian recovery for orchestration spawn grants.
 *
 * A 20-story mission keeps issuing workers for minutes. The original
 * one-shot orchspawn token is often already consumed (first PTY succeeded)
 * or TTL'd (late remount / extra worker) while the mission is still
 * running. Fail-closed is correct for forged tokens; it is wrong to stall
 * a live civilian mission behind "use Reiniciar".
 */

export const ORCH_SPAWN_GRANT_TTL_MS = 15 * 60_000;
export const ORCH_SPAWN_GRANT_TOMBSTONE_TTL_MS = 30 * 60_000;

export type LiveCivilianMissionStatus =
  | "pending"
  | "running"
  | "blocked"
  | "done"
  | "failed";

export type OrchSpawnGrantRecoveryAction =
  | "already-spawned"
  | "remint"
  | "fail-closed";

export function isLiveCivilianMissionStatus(
  status: LiveCivilianMissionStatus | null | undefined,
): boolean {
  return (
    status === "pending" || status === "running" || status === "blocked"
  );
}

/**
 * Decide what a late/expired orchspawn token should do.
 *
 * - Live pane session → no-op success (do not spawn a second process).
 * - Live mission + we issued this grant (tombstone) → remint and continue.
 * - Forged / no tombstone / mission gone → fail closed.
 */
export function decideOrchSpawnGrantRecovery(input: {
  readonly requestId: string | undefined;
  readonly missionStatus: LiveCivilianMissionStatus | null;
  readonly paneHasLiveSession: boolean;
  readonly hasGrantTombstone: boolean;
}): OrchSpawnGrantRecoveryAction {
  if (!input.requestId?.startsWith("orchspawn-")) return "fail-closed";
  if (input.paneHasLiveSession && isLiveCivilianMissionStatus(input.missionStatus)) {
    return "already-spawned";
  }
  if (
    isLiveCivilianMissionStatus(input.missionStatus) &&
    input.hasGrantTombstone
  ) {
    return "remint";
  }
  return "fail-closed";
}

export function missionHasRecentWorkerSuccessHandoff(
  handoffs: readonly {
    readonly missionId?: string;
    readonly status: string;
    readonly createdAt?: number;
    readonly submittedAt?: number;
  }[],
  missionId: string,
  now: number = Date.now(),
  windowMs: number = 10 * 60_000,
): boolean {
  return handoffs.some((handoff) => {
    if (handoff.missionId !== missionId) return false;
    if (handoff.status !== "success") return false;
    const at = handoff.submittedAt ?? handoff.createdAt ?? 0;
    return now - at <= windowMs;
  });
}

export function missionHasWorkersDelivering(
  handoffs: readonly {
    readonly missionId?: string;
    readonly status: string;
    readonly delivered?: boolean;
  }[],
  missionId: string,
): boolean {
  return handoffs.some(
    (handoff) =>
      handoff.missionId === missionId &&
      (handoff.status === "success" || handoff.status === "blocked") &&
      handoff.delivered !== true,
  );
}

export function shouldSuppressCoordinatorPause(input: {
  readonly recentWorkerSuccessHandoff: boolean;
  readonly workersDelivering: boolean;
}): boolean {
  return input.recentWorkerSuccessHandoff || input.workersDelivering;
}
