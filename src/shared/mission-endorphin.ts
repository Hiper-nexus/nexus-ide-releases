import type { Mission, MissionStatus } from './orch-types';

/**
 * Batidas de missão — quando celebrar Luz Verde vs só "concluiu".
 */

export type MissionEndorphinKind =
  | 'launched'
  | 'handoff'
  | 'milestone'
  | 'green'
  | 'done'
  | 'failed';

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
  // Lançamento (ou retomada): a frota entrou em campo — pico de dopamina que
  // faltava. Cobre pending/blocked → running.
  if (next.status === 'running' && prev !== 'running') {
    return {
      missionId: next.id,
      title: next.title,
      kind: 'launched',
      kicker: 'Frota em campo',
      label: next.title,
    };
  }
  return null;
}

export interface HandoffEndorphinInput {
  readonly status: string;
  readonly agentName: string;
  readonly summary: string;
}

/** Batida quando um worker entrega um handoff bem-sucedido. */
export function handoffEndorphin(
  input: HandoffEndorphinInput,
): { kind: 'handoff'; kicker: string; label: string } | null {
  if (input.status !== 'success') return null;
  const summary = input.summary.trim();
  return {
    kind: 'handoff',
    kicker: 'Handoff recebido',
    label: summary ? `${input.agentName}: ${summary}` : input.agentName,
  };
}

/** Batida quando um milestone da missão passa a done. */
export function milestoneEndorphin(
  prevStatus: string | undefined,
  milestone: { label: string; status: string },
): { kind: 'milestone'; kicker: string; label: string } | null {
  if (milestone.status !== 'done' || prevStatus === 'done') return null;
  return {
    kind: 'milestone',
    kicker: 'Milestone concluído',
    label: milestone.label,
  };
}
