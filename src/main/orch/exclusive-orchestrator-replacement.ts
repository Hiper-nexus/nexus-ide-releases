import { createHash } from 'node:crypto';
import { sharedAgentAuthFamily } from '../../shared/agent-auth-family';
import { appendMissionVerdict } from '../../shared/mission-block-cause';
import { missionBlockPatch } from '../../shared/mission-blocking';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  listAgentSessions,
  type OwnedAgentSessionInfo,
} from '../pty/pty-manager';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import {
  prepareMissionRuntimeTermination,
  settleMissionRuntimeDemotion,
  type MissionRuntimeDemotionResult,
  type MissionRuntimeTerminationCandidate,
} from './mission-runtime-termination';
import {
  missionLifecycleKey,
  withMissionLifecycleLock,
} from './mission-lifecycle-lock';

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
    input: Parameters<typeof prepareMissionRuntimeTermination>[0],
  ): MissionRuntimeTerminationCandidate;
  settleDemotion(input: {
    readonly scope: ProjectExecutionScope;
    readonly suite: ProjectDomainStoreSuite;
    readonly demotedMission: Parameters<
      typeof settleMissionRuntimeDemotion
    >[0]['demotedMission'];
  }): Promise<MissionRuntimeDemotionResult>;
}

const productionDeps: ExclusiveOrchestratorReplacementDeps = {
  listAgentSessions,
  storesForScope: getProjectDomainStores,
  prepareTermination: prepareMissionRuntimeTermination,
  settleDemotion: settleMissionRuntimeDemotion,
};

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
          lifecycleKey: missionLifecycleKey(entry.scope, entry.missionId),
          sessionIds: entry.sessionIds,
          runtimeFence: entry.runtimeFence,
        })),
      }),
    )
    .digest('hex');
}

function withExclusiveReplacementLocks<T>(
  entries: readonly ExclusiveOrchestratorReplacementEntry[],
  operation: () => Promise<T>,
  index = 0,
): Promise<T> {
  const entry = entries[index];
  if (!entry) return operation();
  return withMissionLifecycleLock(entry.scope, entry.missionId, () =>
    withExclusiveReplacementLocks(entries, operation, index + 1),
  );
}

/**
 * Resolve every live main-owned Maestro that shares an exclusive provider
 * login with the incoming mission. Renderer panes are intentionally ignored:
 * this inventory remains exact when a window is stale, hidden or gone.
 */
export function prepareExclusiveOrchestratorReplacement(
  input: {
    readonly incomingMissionId: string;
    readonly incomingAdapterId: string;
  },
  deps: ExclusiveOrchestratorReplacementDeps = productionDeps,
): ExclusiveOrchestratorReplacementCandidate {
  const authFamily = sharedAgentAuthFamily(input.incomingAdapterId);
  const groups = new Map<
    string,
    {
      readonly missionId: string;
      readonly scope: ProjectExecutionScope;
      readonly physicalSessionIds: Set<string>;
    }
  >();

  if (authFamily) {
    for (const session of deps.listAgentSessions()) {
      if (
        session.role !== 'orchestrator' ||
        sharedAgentAuthFamily(session.adapterId) !== authFamily ||
        session.missionId === input.incomingMissionId
      ) {
        continue;
      }
      if (!session.missionId) {
        throw new Error(
          `exclusive auth family ${authFamily} has live orchestrator ` +
            `${session.sessionId} without mission authority; close it explicitly`,
        );
      }
      const key = missionLifecycleKey(session.scope, session.missionId);
      let group = groups.get(key);
      if (!group) {
        group = {
          missionId: session.missionId,
          scope: Object.freeze({ ...session.scope }),
          physicalSessionIds: new Set<string>(),
        };
        groups.set(key, group);
      }
      group.physicalSessionIds.add(session.sessionId);
    }
  }

  const entries = [...groups.values()]
    .map((group): ExclusiveOrchestratorReplacementEntry => {
      const suite = deps.storesForScope(group.scope);
      const runtime = deps.prepareTermination({
        scope: group.scope,
        suite,
        missionId: group.missionId,
        reason: 'authority-revoked',
      });
      for (const sessionId of group.physicalSessionIds) {
        if (!runtime.sessionIds.includes(sessionId)) {
          throw new Error(
            `exclusive orchestrator ${sessionId} is not bound to the ` +
              `authoritative runtime of mission ${group.missionId}`,
          );
        }
      }
      return Object.freeze({
        missionId: group.missionId,
        missionTitle: runtime.missionTitle,
        scope: group.scope,
        sessionIds: Object.freeze([...runtime.sessionIds].sort()),
        runtimeFence: runtime.fence,
      });
    })
    .sort((left, right) => {
      return missionLifecycleKey(left.scope, left.missionId).localeCompare(
        missionLifecycleKey(right.scope, right.missionId),
      );
    });

  return Object.freeze({
    incomingMissionId: input.incomingMissionId,
    authFamily,
    entries: Object.freeze(entries),
    fence: replacementFence({
      incomingMissionId: input.incomingMissionId,
      authFamily,
      entries,
    }),
  });
}

/**
 * Apply exactly the replacement inventory shown in the native start dialog.
 * Old dispatch authority is revoked before awaiting physical tree exit. The
 * incoming mission is not approved by this function; the caller may do so
 * only after this proof succeeds.
 */
export async function applyExclusiveOrchestratorReplacement(
  input: {
    readonly incomingMissionId: string;
    readonly incomingAdapterId: string;
    readonly expectedFence: string;
  },
  deps: ExclusiveOrchestratorReplacementDeps = productionDeps,
): Promise<readonly string[]> {
  const candidate = prepareExclusiveOrchestratorReplacement(input, deps);
  if (candidate.fence !== input.expectedFence) {
    throw new Error(
      'exclusive orchestrator runtime changed while mission approval was open',
    );
  }

  return withExclusiveReplacementLocks(candidate.entries, async () => {
    // The dialog fence is checked once more only after every affected mission
    // lock is held. A Retomar/rebind that won any lock invalidates the whole
    // replacement before the first durable demotion.
    const lockedCandidate = prepareExclusiveOrchestratorReplacement(
      input,
      deps,
    );
    if (lockedCandidate.fence !== input.expectedFence) {
      throw new Error(
        'exclusive orchestrator runtime changed before locked replacement',
      );
    }

    const terminated = new Set<string>();
    for (const entry of lockedCandidate.entries) {
      const suite = deps.storesForScope(entry.scope);
      const current = suite.missions.get(entry.missionId);
      if (!current) {
        throw new Error(
          `exclusive orchestrator mission ${entry.missionId} disappeared`,
        );
      }
      if (current.status === 'done') {
        throw new Error(
          `completed mission ${entry.missionId} still has a live orchestrator`,
        );
      }
      const demoted =
        current.status === 'blocked' || current.status === 'failed'
          ? current
          : suite.missions.update(entry.missionId, {
              ...missionBlockPatch('user'),
              description: appendMissionVerdict(
                current.description,
                '<!-- nexus:exclusive-orchestrator-replacement -->',
                '[NEXUS_EXCLUSIVE_ORCHESTRATOR_REPLACED]',
                'O orquestrador exclusivo foi assumido por outra missão/instância; retome para reabrir o Maestro.',
              ),
            });
      if (!demoted) {
        throw new Error(
          `exclusive orchestrator mission ${entry.missionId} could not be blocked`,
        );
      }
      const settled = await deps.settleDemotion({
        scope: entry.scope,
        suite,
        demotedMission: demoted,
      });
      if (!settled.termination.ok) {
        throw new Error(
          settled.termination.error ??
            `physical exit was not proven for mission ${entry.missionId}`,
        );
      }
      for (const sessionId of settled.termination.terminatedSessionIds) {
        terminated.add(sessionId);
      }
    }

    const remaining = prepareExclusiveOrchestratorReplacement(input, deps);
    if (remaining.entries.length > 0) {
      throw new Error(
        'an exclusive orchestrator remained live after physical termination',
      );
    }
    return Object.freeze([...terminated].sort());
  });
}

export function exclusiveReplacementDialogSummary(
  candidate: ExclusiveOrchestratorReplacementCandidate,
): string | null {
  if (candidate.entries.length === 0) return null;
  const names = candidate.entries
    .slice(0, 3)
    .map(
      (entry) =>
        `${entry.missionTitle} (${entry.sessionIds.length} sessão(ões))`,
    )
    .join(' · ');
  const overflow = candidate.entries.length - Math.min(3, candidate.entries.length);
  return (
    `substitui ${candidate.entries.length} missão(ões) da mesma autenticação ` +
    `somente após saída física: ${names}` +
    (overflow > 0 ? ` · +${overflow}` : '')
  );
}
