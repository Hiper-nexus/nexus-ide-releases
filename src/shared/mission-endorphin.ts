import type { Mission, MissionStatus } from './orch-types';

/**
 * Batidas de missão — quando celebrar Luz Verde vs só "concluiu".
 */

export type MissionEndorphinKind = 'green' | 'done' | 'failed';

export interface MissionEndorphinEvent {
  readonly missionId: string;
  readonly title: string;
  readonly kind: MissionEndorphinKind;
  readonly kicker: string;
  readonly label: string;
}

/** Missão done com pelo menos uma evidência em milestone = Luz Verde. */
export function isMissionGreen(mission: Mission): boolean {
  if (mission.status !== 'done') return false;
  return mission.milestones.some((m) => m.evidenceIds.length > 0);
}

export function missionEndorphinForTransition(
  prev: MissionStatus | undefined,
  next: Mission,
): MissionEndorphinEvent | null {
  if (!prev || prev === next.status) return null;
  if (next.status === 'failed' && prev !== 'failed') {
    return {
      missionId: next.id,
      title: next.title,
      kind: 'failed',
      kicker: 'Missão falhou',
      label: next.title,
    };
  }
  if (next.status === 'done' && prev !== 'done') {
    const green = isMissionGreen(next);
    return {
      missionId: next.id,
      title: next.title,
      kind: green ? 'green' : 'done',
      kicker: green ? 'Luz Verde' : 'Missão concluída',
      label: next.title,
    };
  }
  return null;
}
