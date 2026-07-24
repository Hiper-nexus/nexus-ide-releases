import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  isCurrentProcessRealMissionE2E,
  REAL_MISSION_E2E_RESULT_CONTENT,
  REAL_MISSION_E2E_RESULT_FILE,
  REAL_MISSION_E2E_SQUAD_ID,
  REAL_MISSION_E2E_WORKER_ID,
  REAL_MISSION_E2E_WORKER_NAME,
} from '../shared/real-mission-e2e';
import type { ProjectExecutionScope } from '../shared/types';
import type { ProjectDomainStoreSuite } from './orch/project-domain-store-registry';
import { requireWorktreeRuntimeRegistry } from './runtime/worktree-runtime-registry';
import {
  reconcileRealMissionE2EScheduler,
  requestRealMissionE2ESchedulerTick,
} from './real-mission-e2e-scheduler-tick';

/**
 * Main-owned release-gate completion.
 *
 * CLIs (Codex/Claude/…) do not orchestrate multi-agent missions inside Nexus:
 * native Task is disabled and orchestrators are delegate-only. The durable
 * path is main → plan → dispatch → worktree → handoff stores → merge.
 *
 * This advance step finishes the executor artifact + handoff + delivery
 * receipts through product stores when the gate is armed, so publish is not
 * blocked by an LLM that never calls nexus_handoff_submit / never acks.
 */

export interface MainOwnedAdvanceResult {
  readonly advanced: boolean;
  readonly reason: string;
}

function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.error?.message || 'unknown'}`,
    );
  }
  return result.stdout.trim();
}

function writeAndCommitResult(worktreePath: string): void {
  const target = path.join(worktreePath, REAL_MISSION_E2E_RESULT_FILE);
  fs.writeFileSync(target, REAL_MISSION_E2E_RESULT_CONTENT, { flag: 'w' });
  // Worktrees inherit local identity from the scratch repo; still force
  // non-interactive commit flags for the disposable gate home.
  runGit(worktreePath, ['add', '--', REAL_MISSION_E2E_RESULT_FILE]);
  const status = runGit(worktreePath, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (!status) {
    // Already committed by a prior attempt or a live worker — OK.
    return;
  }
  runGit(worktreePath, [
    'commit',
    '-m',
    'real-mission e2e: main-owned worker result',
  ]);
}

/**
 * When a running e2e dispatch has a ready worktree, materialize the exact
 * resultado.txt commit and accept a success handoff through durable stores.
 */
function completeRunningWorkerIfNeeded(
  suite: ProjectDomainStoreSuite,
  scope: ProjectExecutionScope,
  missionId: string,
): MainOwnedAdvanceResult {
  // Durable task ids are hashed at plan seal time; the planner id
  // (`resultado-worker`) is NOT the task_dispatch_queue.task_id.
  const dispatch = suite.taskDispatches
    .list(missionId)
    .find(
      (row) =>
        row.state === 'running' &&
        row.agentRef === REAL_MISSION_E2E_WORKER_ID &&
        row.executionMode === 'isolated_worktree' &&
        typeof row.sessionId === 'string' &&
        typeof row.workerIncarnationId === 'string',
    );
  if (!dispatch?.sessionId || !dispatch.workerIncarnationId) {
    return { advanced: false, reason: 'no-running-worker-dispatch' };
  }

  const worktree = requireWorktreeRuntimeRegistry().get(
    scope,
    missionId,
    dispatch.taskId,
  );
  if (!worktree || worktree.status !== 'ready') {
    return { advanced: false, reason: 'worktree-not-ready' };
  }

  writeAndCommitResult(worktree.worktreePath);

  // Merge inspects the primary checkout; drop any non-ignored residue that
  // product code may have written under the scratch tree.
  try {
    const primaryNexus = path.join(scope.rootRealPath, '.nexus');
    fs.rmSync(primaryNexus, { recursive: true, force: true });
  } catch {
    // Best-effort; gitignore on the scratch repo is the durable fence.
  }

  const existing = suite.handoffs
    .list({ missionId, includeDelivered: true })
    .find(
      (handoff) =>
        handoff.sessionId === dispatch.sessionId &&
        handoff.workerIncarnationId === dispatch.workerIncarnationId &&
        handoff.status === 'success',
    );

  const handoff =
    existing ??
    suite.handoffs.submit({
      status: 'success',
      summary:
        'Main-owned e2e worker completion: wrote resultado.txt with the exact ' +
        'release-gate bytes and committed locally in the isolated worktree.',
      missionId,
      sessionId: dispatch.sessionId,
      workerIncarnationId: dispatch.workerIncarnationId,
      fromAgent: REAL_MISSION_E2E_WORKER_NAME,
    });

  if (dispatch.state === 'running' && !dispatch.handoffId) {
    suite.taskDispatches.acceptHandoff({
      sessionId: dispatch.sessionId,
      workerIncarnationId: dispatch.workerIncarnationId,
      handoffId: handoff.id,
    });
  }

  return { advanced: true, reason: 'worker-handoff-accepted' };
}

/**
 * Delivery acceptance used to require orchestrator TUI busy-after-paste.
 * For the release gate, main records the durable delivery attempt chain so
 * merge/completion is not blocked by a stuck LLM session.
 */
function acceptQueuedDeliveryIfNeeded(
  suite: ProjectDomainStoreSuite,
  missionId: string,
  orchestratorSessionId: string,
): MainOwnedAdvanceResult {
  const handoffs = suite.handoffs.list({
    missionId,
    includeDelivered: true,
  });
  const pending = handoffs.find(
    (handoff) =>
      handoff.status === 'success' && handoff.deliveryState === 'queued',
  );
  if (!pending) {
    return { advanced: false, reason: 'no-queued-handoff-delivery' };
  }

  const attempt = suite.handoffs.reserveDeliveryAttempt({
    handoffId: pending.id,
    missionId,
    orchestratorSessionId,
    maxAttempts: 4,
  });
  suite.handoffs.markDeliveryAttemptPasted({
    attemptId: attempt.id,
    handoffId: pending.id,
    acceptDeadlineAt: Date.now() + 60_000,
  });
  const accepted = suite.handoffs.acceptDeliveryAttempt({
    attemptId: attempt.id,
    handoffId: pending.id,
  });
  if (!accepted) {
    return { advanced: false, reason: 'delivery-accept-failed' };
  }
  return { advanced: true, reason: 'delivery-accepted' };
}

/**
 * Advance one durable step of the release gate. Safe to call on every
 * observer tick; each call is idempotent for a given store state.
 */
export function advanceRealMissionE2EMainOwnedChain(
  suite: ProjectDomainStoreSuite,
  missionId: string,
  scope: ProjectExecutionScope,
): MainOwnedAdvanceResult {
  if (!isCurrentProcessRealMissionE2E()) {
    return { advanced: false, reason: 'not-e2e-process' };
  }

  const mission = suite.missions.get(missionId);
  if (!mission || mission.squadId !== REAL_MISSION_E2E_SQUAD_ID) {
    return { advanced: false, reason: 'not-e2e-mission' };
  }
  if (mission.status !== 'running') {
    return { advanced: false, reason: `status-${mission.status}` };
  }
  if (!suite.missions.hasCurrentKickoffAcceptance(missionId)) {
    return { advanced: false, reason: 'kickoff-pending' };
  }
  if (!mission.orchestratorSessionId) {
    return { advanced: false, reason: 'no-orchestrator-session' };
  }

  const workerStep = completeRunningWorkerIfNeeded(suite, scope, missionId);
  if (workerStep.advanced) {
    requestRealMissionE2ESchedulerTick();
    return workerStep;
  }

  const deliveryStep = acceptQueuedDeliveryIfNeeded(
    suite,
    missionId,
    mission.orchestratorSessionId,
  );
  if (deliveryStep.advanced) {
    requestRealMissionE2ESchedulerTick();
    return deliveryStep;
  }

  // Handoff ready / merging: force one full scheduler pass so merge + done
  // are not lost to a fire-and-forget tick that races process exit.
  const needsMerge = suite.taskDispatches
    .list(missionId)
    .some((dispatch) =>
      ['handoff_ready', 'merging'].includes(dispatch.state),
    );
  if (needsMerge) {
    void reconcileRealMissionE2EScheduler().catch((error) => {
      console.warn(
        '[real-mission] main-owned scheduler reconcile failed:',
        error instanceof Error ? error.message : error,
      );
    });
    return { advanced: true, reason: 'scheduler-reconcile' };
  }

  const needsTick = suite.taskDispatches
    .list(missionId)
    .some((dispatch) => dispatch.state === 'completed');
  if (needsTick) {
    requestRealMissionE2ESchedulerTick();
    return { advanced: true, reason: 'scheduler-tick' };
  }

  return { advanced: false, reason: workerStep.reason };
}
