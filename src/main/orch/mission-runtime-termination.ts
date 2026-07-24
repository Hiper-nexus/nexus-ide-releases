// Adapted from stablyai/orca @ c3620f0954ae283b3b71b295a241f6a9596af6aa
// (MIT): physical-exit-before-replacement authority, under Nexus fences.
import { createHash } from 'node:crypto';
import {
  hasCurrentDispatchAuthority,
  missionBlockPatch,
} from '../../shared/mission-intent';
import type {
  Mission,
  MissionPaneSpec,
  MissionRuntimeCloseResult,
} from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getOmpRpcSessionAuthority,
  isOmpRpcSession,
  listOmpRpcSessions,
  terminateOmpRpcSession,
} from '../adapters/omp-rpc-ipc';
import {
  getSessionState,
  listAgentSessions,
  orchTerminateSession,
} from '../pty/pty-manager';
import {
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  requestMissionPaneClose,
} from './pane-registry';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import { sameProjectScope } from './project-scoped-broadcast';

export type MissionRuntimeTerminationReason =
  | 'restart'
  | 'hibernate'
  | 'force-reopen'
  | 'operator-close'
  | 'authority-revoked';

export interface MissionRuntimeTerminationCandidate {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly paneId?: string;
  readonly reason: MissionRuntimeTerminationReason;
  readonly sessionIds: readonly string[];
  readonly fence: string;
}

export interface MissionRuntimeTerminationResult {
  readonly ok: boolean;
  readonly terminatedSessionIds: readonly string[];
  readonly error?: string;
}

export interface MissionRuntimeDemotionResult {
  readonly mission: Mission;
  readonly termination: MissionRuntimeTerminationResult;
}

const TERMINATION_PENDING_MARKER =
  '<!-- nexus:mission-runtime-termination-pending -->';
const TERMINATION_PENDING_CTA = 'Retomar missão';

interface RuntimeTarget {
  readonly paneId: string;
  readonly sessionId: string;
  readonly spec?: MissionPaneSpec;
  readonly workerIncarnationId?: string;
  readonly transport: 'pty' | 'omp';
  readonly orphaned: boolean;
}

function sameScope(
  left: Readonly<ProjectExecutionScope> | undefined,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return Boolean(left && sameProjectScope(left, right));
}

function runtimeTargets(input: {
  readonly scope: ProjectExecutionScope;
  readonly mission: Mission;
  readonly panes: readonly MissionPaneSpec[];
  readonly paneId?: string;
  readonly expectedSessionId?: string;
}): RuntimeTarget[] {
  const specs = input.panes.filter(
    (pane) =>
      pane.missionId === input.mission.id &&
      (!input.paneId || pane.paneId === input.paneId),
  );
  if (input.paneId && specs.length !== 1) {
    throw new Error('exact persisted mission pane is unavailable');
  }
  const targets = new Map<string, RuntimeTarget>();
  const addPhysical = (physical: {
    readonly sessionId: string;
    readonly paneId?: string;
    readonly missionId?: string;
    readonly role: 'orchestrator' | 'worker' | 'user';
    readonly workerIncarnationId?: string;
    readonly scope: Readonly<ProjectExecutionScope>;
    readonly transport: 'pty' | 'omp';
  }): void => {
    if (
      physical.missionId !== input.mission.id ||
      !sameScope(physical.scope, input.scope)
    ) {
      return;
    }
    // Mission-bound and in scope: from here a silent skip would let a live
    // process survive a "closed" mission. Never drop it quietly.
    if (!physical.paneId) {
      throw new Error(
        `mission session ${physical.sessionId} is live without a pane ` +
          'binding; physical exit cannot be proven',
      );
    }
    if (input.paneId && physical.paneId !== input.paneId) return;
    const matching = specs.filter(
      (spec) =>
        spec.paneId === physical.paneId &&
        spec.role === physical.role &&
        spec.workerIncarnationId === physical.workerIncarnationId &&
        (!spec.scope || sameScope(spec.scope, input.scope)),
    );
    if (matching.length > 1) {
      throw new Error('duplicate persisted mission pane authority');
    }
    const authority = getPaneRuntimeAuthorityBySession(physical.sessionId);
    const exactAuthority =
      !authority ||
      (authority.missionId === physical.missionId &&
        authority.paneId === physical.paneId &&
        authority.role === physical.role &&
        authority.workerIncarnationId === physical.workerIncarnationId &&
        sameScope(authority.scope, input.scope));
    const previous = targets.get(physical.sessionId);
    if (
      previous &&
      (previous.paneId !== physical.paneId ||
        previous.transport !== physical.transport)
    ) {
      throw new Error('physical mission session identity is ambiguous');
    }
    targets.set(physical.sessionId, {
      paneId: physical.paneId,
      sessionId: physical.sessionId,
      ...(matching[0] && exactAuthority ? { spec: matching[0] } : {}),
      ...(physical.workerIncarnationId
        ? { workerIncarnationId: physical.workerIncarnationId }
        : {}),
      transport: physical.transport,
      orphaned: matching.length !== 1 || !exactAuthority,
    });
  };

  // Physical inventories are the source of truth. Detached/headless workers
  // remain visible here even when the renderer mirror lost their pane.
  for (const agent of listAgentSessions()) {
    addPhysical({
      sessionId: agent.sessionId,
      paneId: agent.paneId,
      missionId: agent.missionId,
      role: agent.role,
      workerIncarnationId: agent.workerIncarnationId,
      scope: agent.scope,
      transport: 'pty',
    });
  }
  for (const session of listOmpRpcSessions()) {
    if (session.kind !== 'mission' || session.state === 'exited') continue;
    const authority = getOmpRpcSessionAuthority(session.sessionId);
    if (!authority) continue;
    addPhysical({
      sessionId: authority.sessionId,
      paneId: authority.paneId,
      missionId: authority.missionId,
      role: authority.role,
      workerIncarnationId: authority.workerIncarnationId,
      scope: authority.scope,
      transport: 'omp',
    });
  }

  // Legacy/main-owned sessions can predate the complete inventories. Accept
  // only a trusted pane authority; renderer snapshot metadata alone is never
  // sufficient to select a process for termination.
  const snapshotSessionIds = new Set(
    listPaneSnapshots()
      .filter(
        (snapshot) =>
          snapshot.missionId === input.mission.id &&
          snapshot.sessionId &&
          sameScope(snapshot.scope, input.scope),
      )
      .map((snapshot) => snapshot.sessionId as string),
  );
  if (input.mission.orchestratorSessionId) {
    snapshotSessionIds.add(input.mission.orchestratorSessionId);
  }
  for (const sessionId of snapshotSessionIds) {
    if (targets.has(sessionId)) continue;
    const physicalLive =
      getSessionState(sessionId) !== null || isOmpRpcSession(sessionId);
    // A durable pointer to an already-dead process closes cleanly: there is
    // no runtime left to prove anything about.
    if (!physicalLive) continue;
    const authority = getPaneRuntimeAuthorityBySession(sessionId);
    if (!authority || !authority.role || !authority.scope) {
      // The mission still points at a LIVE process that no pane authority can
      // attribute. Reporting a clean exit here would strand that process and
      // erase the only durable pointer to it — deny instead.
      throw new Error(
        `mission session ${sessionId} is live without pane authority; ` +
          'physical exit cannot be proven',
      );
    }
    addPhysical({
      sessionId,
      paneId: authority.paneId,
      missionId: authority.missionId,
      role: authority.role,
      workerIncarnationId: authority.workerIncarnationId,
      scope: authority.scope,
      transport: isOmpRpcSession(sessionId) ? 'omp' : 'pty',
    });
  }

  const result = [...targets.values()].sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId),
  );
  if (
    input.expectedSessionId &&
    (result.length !== 1 ||
      result[0]?.sessionId !== input.expectedSessionId)
  ) {
    throw new Error('mission pane session changed before termination');
  }
  return result;
}

function terminationFence(input: {
  readonly mission: Mission;
  readonly paneId?: string;
  readonly reason: MissionRuntimeTerminationReason;
  readonly targets: readonly RuntimeTarget[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        missionId: input.mission.id,
        missionUpdatedAt: input.mission.updatedAt,
        intentVersion: input.mission.intentVersion ?? 0,
        paneId: input.paneId ?? null,
        reason: input.reason,
        sessions: input.targets.map((target) => ({
          paneId: target.paneId,
          sessionId: target.sessionId,
          workerIncarnationId: target.workerIncarnationId ?? null,
          transport: target.transport,
          orphaned: target.orphaned,
        })),
      }),
    )
    .digest('hex');
}

export function prepareMissionRuntimeTermination(input: {
  readonly scope: ProjectExecutionScope;
  readonly suite: ProjectDomainStoreSuite;
  readonly missionId: string;
  readonly paneId?: string;
  readonly expectedSessionId?: string;
  readonly reason: MissionRuntimeTerminationReason;
}): MissionRuntimeTerminationCandidate {
  const mission = input.suite.missions.get(input.missionId);
  if (!mission) throw new Error('mission not found');
  const targets = runtimeTargets({
    scope: input.scope,
    mission,
    panes: input.suite.missionPanes.list(mission.id),
    paneId: input.paneId,
    expectedSessionId: input.expectedSessionId,
  });
  return Object.freeze({
    missionId: mission.id,
    missionTitle: mission.title,
    paneId: input.paneId,
    reason: input.reason,
    sessionIds: Object.freeze(targets.map((target) => target.sessionId)),
    fence: terminationFence({
      mission,
      paneId: input.paneId,
      reason: input.reason,
      targets,
    }),
  });
}

export async function terminateMissionRuntime(input: {
  readonly scope: ProjectExecutionScope;
  readonly suite: ProjectDomainStoreSuite;
  readonly missionId: string;
  readonly paneId?: string;
  readonly expectedSessionId?: string;
  readonly reason: MissionRuntimeTerminationReason;
  readonly expectedFence?: string;
  readonly collapsePanes?: boolean;
}): Promise<MissionRuntimeTerminationResult> {
  let mission: Mission;
  let targets: RuntimeTarget[];
  try {
    const found = input.suite.missions.get(input.missionId);
    if (!found) throw new Error('mission not found');
    mission = found;
    targets = runtimeTargets({
      scope: input.scope,
      mission,
      panes: input.suite.missionPanes.list(mission.id),
      paneId: input.paneId,
      expectedSessionId: input.expectedSessionId,
    });
    if (
      input.expectedFence &&
      terminationFence({
        mission,
        paneId: input.paneId,
        reason: input.reason,
        targets,
      }) !== input.expectedFence
    ) {
      throw new Error('mission runtime changed while confirmation was open');
    }
  } catch (error) {
    return {
      ok: false,
      terminatedSessionIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const terminated = new Set<string>();
  const panesToCollapse = new Set<string>();
  let pass = 0;
  while (pass < 3) {
    pass += 1;
    const pending = targets.filter(
      (target) => !terminated.has(target.sessionId),
    );
    if (pending.length === 0) break;
    for (const target of pending) {
      panesToCollapse.add(target.paneId);
      const exited =
        target.transport === 'omp'
          ? await terminateOmpRpcSession(target.sessionId)
          : await orchTerminateSession(target.sessionId);
      if (!exited) {
        return {
          ok: false,
          terminatedSessionIds: [...terminated].sort(),
          error:
            `mission session ${target.sessionId} did not produce physical ` +
            'exit proof; replacement remains denied',
        };
      }
      terminated.add(target.sessionId);

      // A renderer ACK or recovery child can arrive while the previous
      // process is exiting. Re-read the complete physical inventories after
      // every await so a late mission-bound runtime cannot escape teardown.
      const currentMission = input.suite.missions.get(input.missionId);
      if (!currentMission) {
        return {
          ok: false,
          terminatedSessionIds: [...terminated].sort(),
          error: 'mission disappeared during runtime termination',
        };
      }
      targets = runtimeTargets({
        scope: input.scope,
        mission: currentMission,
        panes: input.suite.missionPanes.list(currentMission.id),
        paneId: input.paneId,
      });
      for (const late of targets) panesToCollapse.add(late.paneId);
    }
  }

  const currentMission = input.suite.missions.get(input.missionId);
  const remaining = currentMission
    ? runtimeTargets({
        scope: input.scope,
        mission: currentMission,
        panes: input.suite.missionPanes.list(currentMission.id),
        paneId: input.paneId,
      }).filter((target) => !terminated.has(target.sessionId))
    : [];
  if (remaining.length > 0) {
    return {
      ok: false,
      terminatedSessionIds: [...terminated].sort(),
      error:
        'late mission runtime kept appearing during teardown; ' +
        'replacement remains denied',
    };
  }

  if (input.collapsePanes) {
    for (const paneId of [...panesToCollapse].sort()) {
      if (
        !listPaneSnapshots().some(
          (pane) =>
            pane.paneId === paneId &&
            pane.missionId === input.missionId &&
            sameScope(pane.scope, input.scope),
        )
      ) {
        continue;
      }
      if (
        !(await requestMissionPaneClose({
          paneId,
          missionId: input.missionId,
          scope: input.scope,
        }))
      ) {
        return {
          ok: false,
          terminatedSessionIds: [...terminated].sort(),
          error:
            `mission pane ${paneId} could not be collapsed under main authority`,
        };
      }
    }
  }
  return { ok: true, terminatedSessionIds: [...terminated].sort() };
}

/**
 * Complete the physical side of an already-authorized lifecycle demotion.
 *
 * The durable blocked/failed write happens first so provider authority is
 * revoked before any await. A missing physical-exit proof is therefore not an
 * IPC rollback: it becomes an explicit technical block while the exact pane
 * and session bindings remain available to the reconciler.
 */
export async function settleMissionRuntimeDemotion(input: {
  readonly scope: ProjectExecutionScope;
  readonly suite: ProjectDomainStoreSuite;
  readonly demotedMission: Mission;
}): Promise<MissionRuntimeDemotionResult> {
  if (
    input.demotedMission.status !== 'blocked' &&
    input.demotedMission.status !== 'failed'
  ) {
    throw new Error('mission runtime demotion requires blocked/failed state');
  }

  let termination: MissionRuntimeTerminationResult;
  try {
    termination = await terminateMissionRuntime({
      scope: input.scope,
      suite: input.suite,
      missionId: input.demotedMission.id,
      reason: 'authority-revoked',
      collapsePanes: true,
    });
  } catch (error) {
    termination = {
      ok: false,
      terminatedSessionIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (termination.ok) {
    const mission =
      input.demotedMission.orchestratorSessionId === undefined
        ? input.demotedMission
        : input.suite.missions.setOrchestratorSession(
            input.demotedMission.id,
            null,
          );
    if (!mission) {
      throw new Error('mission disappeared while clearing orchestrator session');
    }
    return { mission, termination };
  }

  const current = input.suite.missions.get(input.demotedMission.id);
  if (!current) throw new Error('mission disappeared during runtime demotion');
  if (current.status === 'done') {
    throw new Error('mission completed while runtime termination was pending');
  }
  const detail = (termination.error ?? 'prova de saída física indisponível')
    .trim()
    .slice(0, 4_096);
  const note =
    `${TERMINATION_PENDING_MARKER}\n## Encerramento físico pendente\n` +
    `${detail}. O Nexus preservou a identidade durável do runtime e bloqueou ` +
    `nova execução. CTA: ${TERMINATION_PENDING_CTA}.`;
  const description = current.description.includes(TERMINATION_PENDING_MARKER)
    ? current.description
    : [current.description.trim(), note]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 65_536);
  const pending = input.suite.missions.update(current.id, {
    ...missionBlockPatch('technical'),
    description,
  });
  if (!pending) {
    throw new Error('mission disappeared while persisting termination state');
  }
  return { mission: pending, termination };
}

/**
 * Operator close for a durable mission. Unlike deletion, this preserves every
 * mission row/receipt and is valid even when the mission is already blocked.
 * The operation is idempotent when no physical runtime remains.
 */
export async function closeMissionRuntimePreservingHistory(input: {
  readonly scope: ProjectExecutionScope;
  readonly suite: ProjectDomainStoreSuite;
  readonly missionId: string;
}): Promise<MissionRuntimeCloseResult> {
  const current = input.suite.missions.get(input.missionId);
  if (!current) {
    return {
      ok: false,
      terminatedSessionIds: [],
      error: 'Missão não encontrada.',
    };
  }
  if (current.status === 'done') {
    return {
      ok: false,
      mission: current,
      terminatedSessionIds: [],
      error: 'Missão concluída não possui execução encerrável.',
    };
  }
  const blocked =
    current.status === 'blocked' || current.status === 'failed'
      ? current
      : input.suite.missions.block(current.id, 'user');
  if (!blocked) {
    return {
      ok: false,
      terminatedSessionIds: [],
      error: 'A missão desapareceu durante o encerramento.',
    };
  }
  const settled = await settleMissionRuntimeDemotion({
    scope: input.scope,
    suite: input.suite,
    demotedMission: blocked,
  });
  return settled.termination.ok
    ? {
        ok: true,
        mission: settled.mission,
        terminatedSessionIds: settled.termination.terminatedSessionIds,
      }
    : {
        ok: false,
        mission: settled.mission,
        terminatedSessionIds: settled.termination.terminatedSessionIds,
        error: settled.termination.error,
      };
}

/**
 * Transition/trailing fence: losing current dispatch authority always owns
 * the physical teardown. This is safe to run repeatedly and closes a session
 * that appeared after the original blocked/failed transaction.
 */
export async function terminateUnauthorizedMissionRuntimes(
  scope: ProjectExecutionScope,
  suite: ProjectDomainStoreSuite,
): Promise<MissionRuntimeTerminationResult[]> {
  const results: MissionRuntimeTerminationResult[] = [];
  for (const mission of suite.missions.list()) {
    if (hasCurrentDispatchAuthority(mission)) continue;
    let targets: RuntimeTarget[];
    try {
      targets = runtimeTargets({
        scope,
        mission,
        panes: suite.missionPanes.list(mission.id),
      });
    } catch (error) {
      results.push({
        ok: false,
        terminatedSessionIds: [],
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (targets.length === 0) continue;
    results.push(
      await terminateMissionRuntime({
        scope,
        suite,
        missionId: mission.id,
        reason: 'authority-revoked',
        collapsePanes: true,
      }),
    );
  }
  return results;
}
