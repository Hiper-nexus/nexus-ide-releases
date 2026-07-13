import type { FailoverEvent } from '../../shared/account-types';

/**
 * Pure same- vs cross-account decision for failover respawn mode.
 * Never let display labels override an explicit crossAccount flag or account ids.
 */
export function isSameAccountFailover(
  event: Pick<
    FailoverEvent,
    | 'crossAccount'
    | 'fromAccountId'
    | 'toAccountId'
    | 'fromAccountLabel'
    | 'toAccountLabel'
  >,
): boolean {
  if (event.crossAccount === true) return false;
  if (event.crossAccount === false) return true;
  if (event.fromAccountId != null && event.toAccountId != null) {
    return event.fromAccountId === event.toAccountId;
  }
  // Last resort only when main omitted ids and the flag (should be rare).
  return Boolean(
    event.fromAccountLabel &&
      event.toAccountLabel &&
      event.fromAccountLabel === event.toAccountLabel,
  );
}

export interface ContinuityMissionInput {
  paneId: string;
  /** paneId → missionId from orch-store. */
  paneMissions: Readonly<Record<string, string>>;
  missions: ReadonlyArray<{ id: string; title: string; status: string }>;
  /** Optional mission id from main FailoverEvent. */
  eventMissionId?: string;
}

/**
 * Prefer the failing pane's bound mission, then main event, then open missions.
 */
export function resolveContinuityMission(input: ContinuityMissionInput): {
  missionId?: string;
  openWorkHint?: string;
} {
  const bound = input.paneMissions[input.paneId];
  const missionId = bound ?? input.eventMissionId;
  const byId = new Map(input.missions.map((m) => [m.id, m]));
  const primary = missionId ? byId.get(missionId) : undefined;
  const open = input.missions
    .filter((m) => m.status === 'running' || m.status === 'blocked')
    .slice(0, 3);
  const hints: string[] = [];
  if (primary) {
    hints.push(`${primary.id}${primary.title ? `: ${primary.title}` : ''}`);
  }
  for (const m of open) {
    if (m.id === primary?.id) continue;
    hints.push(`${m.id}${m.title ? `: ${m.title}` : ''}`);
    if (hints.length >= 3) break;
  }
  return {
    missionId: primary?.id ?? missionId,
    openWorkHint: hints.length > 0 ? hints.join('; ') : undefined,
  };
}
