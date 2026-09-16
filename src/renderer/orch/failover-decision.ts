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
 * O MAIN diz a que missão o pane pertence (FailoverEvent); o índice local
 * (`paneMissions`) é espelho e pode estar atrasado. A ordem é do principal para
 * o derivado: seguir o espelho primeiro mandava a continuidade para a missão
 * errada sempre que os dois discordassem. Sem nenhum dos dois, cai nas missões
 * abertas.
 */
export function resolveContinuityMission(input: ContinuityMissionInput): {
  missionId?: string;
  openWorkHint?: string;
} {
  const missionId = input.eventMissionId ?? input.paneMissions[input.paneId];
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
