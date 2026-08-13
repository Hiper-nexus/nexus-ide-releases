import { createHash } from 'node:crypto';
import { sharedAgentAuthFamily } from '../../shared/agent-auth-family';
import type { ProjectExecutionScope } from '../../shared/types';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import type {
  MissionRuntimeDemotionResult,
  MissionRuntimeTerminationCandidate,
} from './mission-runtime-termination';

export interface ExclusiveOrchestratorReplacementEntry {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly scope: ProjectExecutionScope;
  readonly sessionIds: readonly string[];
  readonly runtimeFence: string;
}

export interface ExclusiveOrchestratorReplacementCandidate {
  readonly incomingMissionId: string;
  readonly authFamily: string | null;
  readonly entries: readonly ExclusiveOrchestratorReplacementEntry[];
  /** Seals every old mission, physical session and runtime termination fence. */
  readonly fence: string;
}

export interface ExclusiveOrchestratorReplacementDeps {
  listAgentSessions(): readonly OwnedAgentSessionInfo[];
  storesForScope(scope: ProjectExecutionScope): ProjectDomainStoreSuite;
  prepareTermination(
    input: Parameters<
      typeof import('./mission-runtime-termination').prepareMissionRuntimeTermination
    >[0],
  ): MissionRuntimeTerminationCandidate;
  settleDemotion(input: {
    readonly scope: ProjectExecutionScope;
    readonly suite: ProjectDomainStoreSuite;
    readonly demotedMission: Parameters<
      typeof import('./mission-runtime-termination').settleMissionRuntimeDemotion
    >[0]['demotedMission'];
  }): Promise<MissionRuntimeDemotionResult>;
}

function replacementFence(input: {
  readonly incomingMissionId: string;
  readonly authFamily: string | null;
  readonly entries: readonly ExclusiveOrchestratorReplacementEntry[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        incomingMissionId: input.incomingMissionId,
        authFamily: input.authFamily,
        entries: input.entries.map((entry) => ({
          missionId: entry.missionId,
          sessionIds: entry.sessionIds,
          runtimeFence: entry.runtimeFence,
        })),
      }),
    )
    .digest('hex');
}

/**
 * Concurrent missions each keep their own Maestro. The previous exclusive
 * replacement stole mission A's live orchestrator when B started — that is
 * the operator-visible "segunda missão mata a primeira". Inventory stays
 * empty on purpose: never demote or terminate another mission here.
 */
export function prepareExclusiveOrchestratorReplacement(
  input: {
    readonly incomingMissionId: string;
    readonly incomingAdapterId: string;
  },
  _deps?: ExclusiveOrchestratorReplacementDeps,
): ExclusiveOrchestratorReplacementCandidate {
  const authFamily = sharedAgentAuthFamily(input.incomingAdapterId);
  const entries = Object.freeze(
    [] as ExclusiveOrchestratorReplacementEntry[],
  );
  return Object.freeze({
    incomingMissionId: input.incomingMissionId,
    authFamily,
    entries,
    fence: replacementFence({
      incomingMissionId: input.incomingMissionId,
      authFamily,
      entries,
    }),
  });
}

/**
 * Kept as a no-op so a stale native-dialog fence cannot revive demotion.
 * Physical spawn still refuses a second Maestro for the SAME mission until
 * that process exits; a different mission is never in this inventory.
 */
export async function applyExclusiveOrchestratorReplacement(
  input: {
    readonly incomingMissionId: string;
    readonly incomingAdapterId: string;
    readonly expectedFence: string;
  },
  deps?: ExclusiveOrchestratorReplacementDeps,
): Promise<readonly string[]> {
  const candidate = prepareExclusiveOrchestratorReplacement(input, deps);
  if (candidate.fence !== input.expectedFence) {
    throw new Error(
      'exclusive orchestrator runtime changed while mission approval was open',
    );
  }
  if (candidate.entries.length > 0) {
    throw new Error(
      'exclusive orchestrator replacement must not demote another mission',
    );
  }
  return Object.freeze([]);
}

export function exclusiveReplacementDialogSummary(
  _candidate: ExclusiveOrchestratorReplacementCandidate,
): string | null {
  return null;
}
