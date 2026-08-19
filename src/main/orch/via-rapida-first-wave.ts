/**
 * First-wave da Via Rápida: no mesmo turno do Maestro, o Main abre o leque
 * de writers. Missão grande (20 stories) → ~7 assentos. Só CLI com
 * AuthReadiness=present senta — LongCat sem chave não tosta.
 */
import type { SquadAgent } from '../../shared/orch-types';
import {
  canSeat,
  classifySeatAuth,
  seatFailureHint,
  type SeatAuthReadiness,
  type SeatAuthInput,
} from '../adapters/seat-auth-readiness';
import { MAX_LIVE_PANES_SOFT } from '../../shared/pane-limits';

export const LARGE_MISSION_STORY_THRESHOLD = 6;
export const FIRST_WAVE_WRITER_SEATS = 7;

export type FirstWaveSeat = {
  readonly agent: SquadAgent;
  readonly title: string;
  readonly seatIndex: number;
  readonly storyTitle: string | null;
};

export function isLargeMissionPlan(storyCount: number): boolean {
  return storyCount >= LARGE_MISSION_STORY_THRESHOLD;
}

export function targetFirstWaveWriterSeats(storyCount: number): number {
  if (storyCount <= 0) return 0;
  const softCap = Math.max(1, MAX_LIVE_PANES_SOFT - 1);
  if (isLargeMissionPlan(storyCount)) {
    return Math.min(storyCount, FIRST_WAVE_WRITER_SEATS, softCap);
  }
  return Math.min(storyCount, softCap);
}

export function writableRosterAgents(
  agents: readonly SquadAgent[],
): SquadAgent[] {
  const writers = agents.filter(
    (agent) =>
      agent.category === 'executor' ||
      agent.category === 'scout' ||
      agent.category === 'architect',
  );
  if (writers.length > 0) return writers;
  return agents.filter((agent) => agent.category !== 'orchestrator');
}

export function filterPresentWriterAgents(
  agents: readonly SquadAgent[],
  classify: (agent: SquadAgent) => SeatAuthReadiness = (agent) =>
    classifySeatAuth({
      adapterId: agent.cli,
      authStrategy: (agent as { authStrategy?: string }).authStrategy,
      hasKey: (agent as { hasKey?: boolean }).hasKey,
    }),
): SquadAgent[] {
  return writableRosterAgents(agents).filter((agent) => canSeat(classify(agent)));
}

export function expandFirstWaveSeats(
  writers: readonly SquadAgent[],
  targetSeats: number,
  storyTitles: readonly string[] = [],
): readonly FirstWaveSeat[] {
  if (writers.length === 0 || targetSeats <= 0) return Object.freeze([]);
  const seats: FirstWaveSeat[] = [];
  for (let index = 0; index < targetSeats; index += 1) {
    const agent = writers[index % writers.length]!;
    const copy = Math.floor(index / writers.length);
    seats.push(
      Object.freeze({
        agent,
        title: copy === 0 ? agent.agentName : `${agent.agentName} · ${copy + 1}`,
        seatIndex: index,
        storyTitle: storyTitles[index] ?? null,
      }),
    );
  }
  return Object.freeze(seats);
}

export function planFirstWaveSeats(input: {
  readonly storyCount: number;
  readonly storyTitles?: readonly string[];
  readonly agents: readonly SquadAgent[];
  readonly classifySeat?: (agent: SquadAgent) => SeatAuthReadiness;
  readonly liveWritableWorkers?: number;
  /** CLI already at writer_circuit_break / mortality 3 — do not remint. */
  readonly blockedAdapterIds?: readonly string[];
}): {
  readonly targetSeats: number;
  readonly presentWriters: readonly SquadAgent[];
  readonly seats: readonly FirstWaveSeat[];
  readonly skippedNoCredential: readonly string[];
} {
  const target = Math.max(
    0,
    targetFirstWaveWriterSeats(input.storyCount) - (input.liveWritableWorkers ?? 0),
  );
  const allWriters = writableRosterAgents(input.agents);
  const blocked = new Set(
    (input.blockedAdapterIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  const present = filterPresentWriterAgents(
    input.agents,
    input.classifySeat,
  ).filter((agent) => !blocked.has(agent.cli));
  const skipped = allWriters
    .filter((agent) => !present.some((row) => row.id === agent.id))
    .map((agent) => agent.cli);
  return {
    targetSeats: target,
    presentWriters: present,
    seats: expandFirstWaveSeats(present, target, input.storyTitles ?? []),
    skippedNoCredential: [...new Set(skipped)],
  };
}

export function firstWaveSilentSkipHint(input: SeatAuthInput): string {
  return seatFailureHint({
    readiness: classifySeatAuth(input),
    explicitCivilianPick: false,
  });
}
