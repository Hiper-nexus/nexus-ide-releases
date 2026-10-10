import { iteratePeriodicMissionIds } from './mission-store';
import type { PeriodicTaskContext } from '../observability/periodic-task';
// Adapted from stablyai/orca @ c3620f0954ae283b3b71b295a241f6a9596af6aa
// (MIT): physical-exit-before-replacement authority, under Nexus fences.
// Resync check 2026-09-11 against f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92: no
// code ported. Upstream's worktree-teardown.ts grew a structured-agent-session
// sweep, cross-host graph matching, and an `allowUnverifiedStop` Force Delete
// escape hatch (#11960) that WARNS and proceeds instead of throwing when a
// stop can't be proven. This file shares no code with that one — it is a
// from-scratch reimplementation of the same invariant for mission authority,
// not worktree PTY teardown — and porting the escape hatch would weaken
// physical-exit-before-replacement into an advisory check, letting two
// sessions claim authority over the same mission (split-brain). Deliberately
// not ported; see third_party/provenance/orca-f352b6b-runtime-remote.json.
import { createHash } from 'node:crypto';
import { appendMissionVerdict } from '../../shared/mission-block-cause';
import {
  hasCurrentDispatchAuthority,
  hasCurrentApprovedDispatchContract,
  missionBlockPatch,
} from '../../shared/mission-intent';
import {
  leftoverIsolationStillLive,
  persistLeftoverIsolation,
} from '../../shared/mission-leftover-isolation';
import {
  hasAutomaticTechnicalRecovery,
  wasMissionRuntimeClosedByOperator,
  MISSION_RUNTIME_CLOSED_MARKER,
} from '../../shared/mission-recovery-policy';
import type {
  Mission,
  MissionPaneSpec,
  MissionRuntimeCloseResult,
} from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  getSessionState,
  listAgentSessions,
  orchTerminateSession,
  releaseOperatorOpenedAgentSession,
  returnAdoptedAgentSessionToUser,
} from '../pty/pty-manager';
import {
  getAcpDriverSession,
  listAcpDriverAgentSessions,
} from '../acp/acp-harness-driver';
import {
  detachOperatorOpenedPaneMission,
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  requestMissionPaneClose,
} from './pane-registry';
import { returnOperatorOpenedSessionToUser } from './gate';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import { withMissionLifecycleLock } from './mission-lifecycle-lock';
import { sameProjectScope } from './project-scoped-broadcast';
import { emitMissionEvent } from './mission-event-emit';
import { sanitizeMissionOrchestratorExitOutput } from './mission-orchestrator-exit-policy';
import { readSessionOutput } from './pane-session-output';

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

/**
 * F-231: o pane aberto pelo operador dentro da missão (`operatorOpened`) é
 * participante visível ao Maestro, mas a máquina da missão nunca o encerra —
 * no teardown ele volta à mão do operador em vez de morrer. Três espelhos
 * podem carregar a marca (linha persistida, autoridade do pane, ficha do PTY);
 * qualquer um basta — a marca é Main-authored em todos.
 */
function targetIsOperatorOpened(target: RuntimeTarget): boolean {
  if (target.spec?.operatorOpened === true) return true;
  if (getPaneRuntimeAuthorityBySession(target.sessionId)?.operatorOpened === true) {
    return true;
  }
  return (
    listAgentSessions().find(
      (session) => session.sessionId === target.sessionId,
    )?.operatorOpened === true
  );
}

/**
 * Devolução à mão do operador (mesmo efeito de `returnOperatorHandFromEndedMission`
 * para o líder adotado): a ficha do PTY e o contexto do gate voltam a `user`
 * irrestrito e o meta do pane perde o vínculo com a missão, então as próximas
 * passadas de inventário e a varredura de órfãos não o selecionam mais.
 */
function releaseOperatorOpenedTarget(
  missionId: string,
  target: RuntimeTarget,
): void {
  returnOperatorOpenedSessionToUser(target.sessionId, missionId);
  if (!releaseOperatorOpenedAgentSession(target.sessionId, missionId)) {
    // A released manual hand loses operatorOpened in the PTY. Its subsequent
    // adoption carries the exact promoted-user/mission proof instead.
    returnAdoptedAgentSessionToUser(target.sessionId, missionId);
  }
  detachOperatorOpenedPaneMission(target.paneId, missionId);
}

interface RuntimeTarget {
  readonly paneId: string;
  readonly sessionId: string;
  readonly spec?: MissionPaneSpec;
  readonly role?: 'orchestrator' | 'worker' | 'user';
  readonly adapterId?: string;
  readonly agentName?: string;
  readonly workerIncarnationId?: string;
  readonly orphaned: boolean;
}

function physicalSessionIsLive(sessionId: string): boolean {
  return (
    getAcpDriverSession(sessionId) !== null ||
    getSessionState(sessionId) !== null
  );
}

export function missionHasLivePhysicalSession(
  scope: ProjectExecutionScope,
  missionId: string,
): boolean {
  return [...listAgentSessions(), ...listAcpDriverAgentSessions()].some(
    (session) =>
      session.missionId === missionId && sameScope(session.scope, scope),
  );
}

const FINAL_SCREEN_TAIL_MAX_BYTES = 4 * 1024;

/**
 * F-244: última tela do pane antes de matar a sessão. O Quadro da missão
 * bloqueada mostra o que cada pane estava fazendo quando morreu — sem isso o
 * operador via terminais mortos e nenhuma pista. Best-effort: nunca atrasa
 * nem impede a terminação; sessão sem buffer não gera evento.
 */
function emitFinalPaneScreen(
  scope: ProjectExecutionScope,
  missionId: string,
  target: RuntimeTarget,
): void {
  try {
    const raw = readSessionOutput(target.sessionId, 80);
    if (!raw.trim()) return;
    let tail = sanitizeMissionOrchestratorExitOutput(raw);
    if (Buffer.byteLength(tail, 'utf8') > FINAL_SCREEN_TAIL_MAX_BYTES) {
      tail =
        Buffer.from(tail, 'utf8')
          .subarray(0, FINAL_SCREEN_TAIL_MAX_BYTES)
          .toString('utf8') + '…';
    }
    emitMissionEvent(scope, {
      missionId,
      runId: 'pane-final-screen',
      type: 'custom',
      origin: 'main',
      idempotencyKey: `pane_final_screen:${target.sessionId}`,
      payload: {
        kind: 'pane-final-screen',
        paneId: target.paneId,
        sessionId: target.sessionId,
        role: target.role ?? target.spec?.role ?? null,
        adapterId: target.adapterId ?? target.spec?.adapterId ?? null,
        agentName: target.agentName ?? target.spec?.agentName ?? null,
        tail,
      },
    });
  } catch {
    // Sessão já morrendo / journal indisponível: nunca compete com o teardown.
  }
}

async function terminatePhysicalSession(sessionId: string): Promise<boolean> {
  const acp = getAcpDriverSession(sessionId);
  if (acp) {
    try {
      await acp.shutdown();
      return getAcpDriverSession(sessionId) === null;
    } catch {
      return false;
    }
  }
  return orchTerminateSession(sessionId, { origin: 'mission-termination' });
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
  readonly reason?: MissionRuntimeTerminationReason;
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
    readonly adapterId?: string;
    readonly agentName?: string;
    readonly workerIncarnationId?: string;
    readonly scope: Readonly<ProjectExecutionScope>;
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
      previous.paneId !== physical.paneId
    ) {
      throw new Error('physical mission session identity is ambiguous');
    }
    targets.set(physical.sessionId, {
      paneId: physical.paneId,
      sessionId: physical.sessionId,
      role: physical.role,
      ...(physical.adapterId ? { adapterId: physical.adapterId } : {}),
      ...(physical.agentName ? { agentName: physical.agentName } : {}),
      ...(matching[0] && exactAuthority ? { spec: matching[0] } : {}),
      ...(physical.workerIncarnationId
        ? { workerIncarnationId: physical.workerIncarnationId }
        : {}),
      orphaned: matching.length !== 1 || !exactAuthority,
    });
  };

  // Physical inventories are the source of truth. Detached/headless workers
  // remain visible here even when the renderer mirror lost their pane.
  for (const agent of [
    ...listAgentSessions(),
    ...listAcpDriverAgentSessions(),
  ]) {
    addPhysical({
      sessionId: agent.sessionId,
      paneId: agent.paneId,
      missionId: agent.missionId,
      role: agent.role,
      adapterId: agent.adapterId,
      agentName: agent.agentName,
      workerIncarnationId: agent.workerIncarnationId,
      scope: agent.scope,
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
    const physicalLive = physicalSessionIsLive(sessionId);
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
  // Blocking pauses dispatch, not the conversation needed to recover it.
  // Only the exact persisted coordinator from this approved revision stays;
  // workers, orphans, completed missions and explicit teardown remain strict.
  if (
    input.reason === 'authority-revoked' &&
    input.mission.status === 'blocked' &&
    (input.mission.intentState === 'blocked_technical' || input.mission.intentState === 'blocked_user') &&
    hasCurrentApprovedDispatchContract(input.mission) &&
    !wasMissionRuntimeClosedByOperator(input.mission)
  ) {
    return result.filter((target) => !(
      target.role === 'orchestrator' &&
      target.sessionId === input.mission.orchestratorSessionId &&
      !target.orphaned
    ));
  }
  return result;
}

function orphanRuntimeInventory(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
}): {
  readonly targets: readonly RuntimeTarget[];
  readonly paneIds: readonly string[];
} {
  const targets = new Map<string, RuntimeTarget>();
  const paneIds = new Set<string>();
  const add = (target: {
    readonly sessionId: string;
    readonly paneId?: string;
    readonly missionId?: string;
    readonly role: 'orchestrator' | 'worker' | 'user';
    readonly adapterId?: string;
    readonly agentName?: string;
    readonly workerIncarnationId?: string;
    readonly scope: Readonly<ProjectExecutionScope>;
  }): void => {
    if (
      target.missionId !== input.missionId ||
      !sameScope(target.scope, input.scope)
    ) {
      return;
    }
    if (!target.paneId) {
      throw new Error(
        `orphan mission session ${target.sessionId} is live without a pane binding`,
      );
    }
    const previous = targets.get(target.sessionId);
    if (
      previous &&
      (previous.paneId !== target.paneId ||
        previous.workerIncarnationId !== target.workerIncarnationId)
    ) {
      throw new Error('orphan mission runtime identity is ambiguous');
    }
    paneIds.add(target.paneId);
    targets.set(target.sessionId, {
      paneId: target.paneId,
      sessionId: target.sessionId,
      role: target.role,
      ...(target.adapterId ? { adapterId: target.adapterId } : {}),
      ...(target.agentName ? { agentName: target.agentName } : {}),
      ...(target.workerIncarnationId
        ? { workerIncarnationId: target.workerIncarnationId }
        : {}),
      orphaned: true,
    });
  };

  // This complete main-owned PTY inventory is sufficient authority for
  // mission+scope selection even after the durable mission row disappeared.
  for (const agent of [
    ...listAgentSessions(),
    ...listAcpDriverAgentSessions(),
  ]) add(agent);

  // Preserve visual leaves even when their PTY already exited. A live legacy
  // snapshot absent from the agent inventory is admitted only through its
  // exact pane-runtime authority.
  for (const snapshot of listPaneSnapshots()) {
    if (
      snapshot.missionId !== input.missionId ||
      !sameScope(snapshot.scope, input.scope)
    ) {
      continue;
    }
    paneIds.add(snapshot.paneId);
    if (
      !snapshot.sessionId ||
      targets.has(snapshot.sessionId) ||
      !physicalSessionIsLive(snapshot.sessionId)
    ) {
      continue;
    }
    const authority = getPaneRuntimeAuthorityBySession(snapshot.sessionId);
    if (
      !authority ||
      !authority.role ||
      !authority.scope ||
      authority.missionId !== input.missionId ||
      authority.paneId !== snapshot.paneId ||
      authority.role !== snapshot.role ||
      authority.workerIncarnationId !== snapshot.workerIncarnationId ||
      !sameScope(authority.scope, input.scope)
    ) {
      throw new Error(
        `orphan mission session ${snapshot.sessionId} has no exact pane authority`,
      );
    }
    add({
      sessionId: snapshot.sessionId,
      paneId: authority.paneId,
      missionId: authority.missionId,
      role: authority.role,
      workerIncarnationId: authority.workerIncarnationId,
      scope: authority.scope,
    });
  }

  return {
    targets: Object.freeze(
      [...targets.values()].sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId),
      ),
    ),
    paneIds: Object.freeze([...paneIds].sort()),
  };
}

/**
 * Reconciles panes whose durable mission row was already removed.
 *
 * Selection never falls back to paneId alone: only physical/snapshot
 * authorities bound to the exact mission and project scope may be terminated.
 * Once physical absence is proven, renderer collapse is best-effort because
 * the invoking renderer also removes its exact mission leaves locally.
 */
export async function closeOrphanedMissionRuntime(input: {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
}): Promise<MissionRuntimeTerminationResult> {
  const terminated = new Set<string>();
  const paneIds = new Set<string>();
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const inventory = orphanRuntimeInventory(input);
      for (const paneId of inventory.paneIds) paneIds.add(paneId);
      const pending = inventory.targets.filter(
        (target) => physicalSessionIsLive(target.sessionId),
      );
      if (pending.length === 0) break;
      for (const target of pending) {
        if (targetIsOperatorOpened(target)) {
          // F-231: o pane é do operador — devolve a mão, não mata.
          releaseOperatorOpenedTarget(input.missionId, target);
          terminated.add(target.sessionId);
          continue;
        }
        emitFinalPaneScreen(input.scope, input.missionId, target);
        if (!(await terminatePhysicalSession(target.sessionId))) {
          return {
            ok: false,
            terminatedSessionIds: [...terminated].sort(),
            error:
              `orphan mission session ${target.sessionId} did not produce ` +
              'physical exit proof',
          };
        }
        terminated.add(target.sessionId);
      }
    }
    const remaining = orphanRuntimeInventory(input).targets.filter(
      (target) => physicalSessionIsLive(target.sessionId),
    );
    if (remaining.length > 0) {
      return {
        ok: false,
        terminatedSessionIds: [...terminated].sort(),
        error: 'late orphan mission runtime kept appearing during teardown',
      };
    }
    for (const paneId of [...paneIds].sort()) {
      const exactPaneStillExists = listPaneSnapshots().some(
        (pane) =>
          pane.paneId === paneId &&
          pane.missionId === input.missionId &&
          sameScope(pane.scope, input.scope),
      );
      if (!exactPaneStillExists) continue;
      await requestMissionPaneClose({
        paneId,
        missionId: input.missionId,
        scope: input.scope,
      });
    }
    return {
      ok: true,
      terminatedSessionIds: [...terminated].sort(),
    };
  } catch (error) {
    return {
      ok: false,
      terminatedSessionIds: [...terminated].sort(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    reason: input.reason,
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
      reason: input.reason,
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
      if (targetIsOperatorOpened(target)) {
        // F-231: sobrevive ao fim da missão — volta à mão do operador e o
        // pane NÃO entra no conjunto de colapso nem na lista de tela final.
        releaseOperatorOpenedTarget(mission.id, target);
        terminated.add(target.sessionId);
        continue;
      }
      panesToCollapse.add(target.paneId);
      emitFinalPaneScreen(input.scope, mission.id, target);
      const exited = await terminatePhysicalSession(target.sessionId);
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
        reason: input.reason,
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
        reason: input.reason,
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
  readonly reason?: 'authority-revoked' | 'operator-close';
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
      reason: input.reason ?? 'authority-revoked',
      // Panes ficam (06/08): fechar o último pane invoca o HomeDeck e EJETA o
      // operador com o scrollback junto. A sessão morre com prova física; o
      // pane preserva transcript e controle, e o card diz o porquê + Retomar.
      collapsePanes: false,
    });
  } catch (error) {
    termination = {
      ok: false,
      terminatedSessionIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (termination.ok) {
    const current = input.suite.missions.get(input.demotedMission.id);
    if (current?.orchestratorSessionId && physicalSessionIsLive(current.orchestratorSessionId)) {
      // A blocked coordinator is intentionally retained for recovery. Losing
      // its durable pointer would make the next reconciliation kill it.
      return { mission: current, termination };
    }
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
  const pendingState =
    input.demotedMission.status === 'failed'
      ? {
          status: 'failed' as const,
          ...(input.demotedMission.intentState
            ? { intentState: input.demotedMission.intentState }
            : {}),
        }
      : missionBlockPatch(
          input.demotedMission.intentState === 'blocked_user'
            ? 'user'
            : 'technical',
        );
  const pending = input.suite.missions.update(current.id, {
    ...pendingState,
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
    persistLeftoverIsolation(input.suite.missions, current.id, 'encerrar') ??
    ((current.status === 'blocked' || current.status === 'failed') &&
    !hasAutomaticTechnicalRecovery(current)
      ? current
      : input.suite.missions.update(current.id, {
          ...missionBlockPatch('user'),
          description: appendMissionVerdict(
            current.description,
            MISSION_RUNTIME_CLOSED_MARKER,
            '[NEXUS_RUNTIME_CLOSED]',
            'Execução encerrada pelo operador; histórico e receipts preservados.',
          ),
        }));
  if (!blocked) {
    return {
      ok: false,
      terminatedSessionIds: [],
      error: 'A missão desapareceu durante o encerramento.',
    };
  }
  if (leftoverIsolationStillLive(blocked)) {
    return {
      ok: false,
      mission: blocked,
      terminatedSessionIds: [],
      error: 'Encerrar não persistiu leftover não-running no SQLite.',
    };
  }
  const settled = await settleMissionRuntimeDemotion({
    scope: input.scope,
    suite: input.suite,
    demotedMission: blocked,
    reason: 'operator-close',
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
  context?: PeriodicTaskContext,
): Promise<MissionRuntimeTerminationResult[]> {
  const results: MissionRuntimeTerminationResult[] = [];
  for await (const missionId of iteratePeriodicMissionIds(suite.missions, context)) {
    await context?.checkpoint();
    const result = await withMissionLifecycleLock(
      scope,
      missionId,
      async (): Promise<MissionRuntimeTerminationResult | null> => {
        context?.assertCurrent();
        // The list() result is only a wake-up hint. Re-authorize after waiting
        // for the same mutex used by resume/bootstrap so an approved runtime
        // that won the lock cannot be killed from a stale blocked snapshot.
        const current = suite.missions.get(missionId);
        if (!current || hasCurrentDispatchAuthority(current)) return null;
        let targets: RuntimeTarget[];
        try {
          targets = runtimeTargets({
            reason: 'authority-revoked',
            scope,
            mission: current,
            panes: suite.missionPanes.list(current.id),
          });
        } catch (error) {
          return {
            ok: false,
            terminatedSessionIds: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (targets.length === 0) return null;
        return terminateMissionRuntime({
          scope,
          suite,
          missionId,
          reason: 'authority-revoked',
          // Mesma doutrina da demoção: sessão não-autorizada morre com prova,
          // mas o pane (e o scrollback) permanecem com o operador.
          collapsePanes: false,
        });
      },
    );
    if (result) results.push(result);
  }
  return results;
}
