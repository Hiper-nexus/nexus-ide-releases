import { createHash } from 'node:crypto';
import type { Squad } from '../../shared/orch-types';

export interface SquadAuthorityAgentSnapshot {
  readonly id: string;
  readonly agentName: string;
  readonly category: string;
  readonly cli: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly allowedTools: readonly string[] | null;
  readonly allowedSkills: readonly string[] | null;
}

export interface SquadAuthoritySnapshot {
  readonly id: string;
  readonly name: string;
  readonly builtin: boolean;
  readonly orchestratorInstructions: string;
  readonly nativeInstructions: string | null;
  readonly runtimeSourceSquadId?: string | null;
  readonly runtimeSourceSquadRevisionHash?: string | null;
  readonly agents: readonly SquadAuthorityAgentSnapshot[];
  readonly hash: string;
}

/** Canonical, immutable authority material used by approval and bootstrap. */
export function snapshotSquadAuthority(squad: Squad): SquadAuthoritySnapshot {
  const value = {
    id: squad.id,
    name: squad.name,
    builtin: squad.builtin,
    orchestratorInstructions: squad.orchestratorInstructions,
    nativeInstructions: squad.nativeInstructions ?? null,
    ...(squad.runtimeSourceSquadId &&
    squad.runtimeSourceSquadRevisionHash
      ? {
          runtimeSourceSquadId: squad.runtimeSourceSquadId,
          runtimeSourceSquadRevisionHash:
            squad.runtimeSourceSquadRevisionHash,
        }
      : {}),
    agents: squad.agents.map((agent) => ({
      id: agent.id,
      agentName: agent.agentName,
      category: agent.category,
      cli: agent.cli,
      model: agent.model ?? null,
      effort: agent.effort ?? null,
      allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
      allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : null,
    })),
  };
  return Object.freeze({
    ...value,
    agents: Object.freeze(
      value.agents.map((agent) =>
        Object.freeze({
          ...agent,
          allowedTools: agent.allowedTools
            ? Object.freeze([...agent.allowedTools])
            : null,
          allowedSkills: agent.allowedSkills
            ? Object.freeze([...agent.allowedSkills])
            : null,
        }),
      ),
    ),
    hash: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  });
}

export function squadAuthorityReviewStrings(
  snapshot: SquadAuthoritySnapshot,
): string[] {
  return [
    snapshot.id,
    snapshot.name,
    String(snapshot.builtin),
    snapshot.orchestratorInstructions,
    snapshot.nativeInstructions ?? '',
    snapshot.runtimeSourceSquadId ?? '',
    snapshot.runtimeSourceSquadRevisionHash ?? '',
    ...snapshot.agents.flatMap((agent) => [
      agent.id,
      agent.agentName,
      agent.category,
      agent.cli,
      agent.model ?? '',
      agent.effort ?? '',
      ...(agent.allowedTools ?? []),
      ...(agent.allowedSkills ?? []),
    ]),
  ];
}
