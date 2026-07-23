import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import type { WebContents } from 'electron';

import { WINDOW_CHANNELS } from '../shared/channels';
import {
  REAL_MISSION_E2E_CHANNELS,
  REAL_MISSION_E2E_CTA,
  REAL_MISSION_E2E_EVIDENCE_FILE,
  REAL_MISSION_E2E_ORCHESTRATOR_ID,
  REAL_MISSION_E2E_ORCHESTRATOR_NAME,
  REAL_MISSION_E2E_RESULT_CONTENT,
  REAL_MISSION_E2E_RESULT_FILE,
  REAL_MISSION_E2E_SQUAD_ID,
  REAL_MISSION_E2E_TIMEOUT_MS,
  REAL_MISSION_E2E_WORKER_ID,
  REAL_MISSION_E2E_WORKER_NAME,
  isCurrentProcessRealMissionE2E,
  isExclusiveRealMissionE2E,
  isRealMissionE2ERendererFailureSignal,
  isRealMissionE2EPreApprovalMission,
  parseRealMissionE2EEvidence,
  realMissionE2EObservePayloadSchema,
  realMissionE2EPrepareFixturePayloadSchema,
  type RealMissionE2EEvidence,
} from '../shared/real-mission-e2e';
import { requireRendererWorkspaceScope } from './persistence/renderer-workspace-scope';
import { grantWorkspacePathFromTrustedMain } from './persistence/workspace-store';
import { getAdapter } from './adapters/adapter-registry';
import {
  getAgentSessionInfo,
  tapSessionData,
  tapSessionExit,
  tapSessionState,
} from './pty/pty-manager';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './orch/project-domain-store-registry';
import { missionKickoffFailureReasonFromDescription } from './orch/mission-kickoff';
import { initOrchestration } from './orch/orch-ipc';
import { getSquad } from './orch/squad-store';
import {
  isExactRealMissionE2ESquadFixture,
  persistRealMissionE2ESquadFixture,
} from './real-mission-e2e-fixture';
import { sealRealMissionE2EPlanIfNeeded } from './real-mission-e2e-plan';
import { advanceRealMissionE2EMainOwnedChain } from './real-mission-e2e-main-owned';
import { stageRealMissionCodexTrust } from './real-mission-codex-trust';

const DONE_SETTLE_MS = 20_000;
const OBSERVE_INTERVAL_MS = 500;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

type FailureCode = NonNullable<RealMissionE2EEvidence['failure']>['code'];

export function createRealMissionPrematureExitHandlers(options: {
  readonly isSettled: () => boolean;
  readonly finish: (failureCode: FailureCode) => void;
}): {
  readonly beforeQuit: () => void;
  readonly ownerDestroyed: () => void;
  readonly rendererGone: () => void;
} {
  const close = (failureCode: FailureCode) => {
    if (!options.isSettled()) options.finish(failureCode);
  };
  return {
    beforeQuit: () => close('app-error'),
    ownerDestroyed: () => close('renderer-failed'),
    rendererGone: () => close('renderer-failed'),
  };
}

interface ScratchRepository {
  readonly workspacePath: string;
  readonly initialHeadSha: string;
}

interface KickoffCapture {
  sessionId: string | null;
  idleAt: number | null;
  busyAt: number | null;
  ptyDataAt: number | null;
  ptyChunkSha256: string | null;
}

interface PhysicalPtyCapture {
  readonly role: 'orchestrator' | 'worker';
  readonly workerIncarnationId: string | null;
  readonly spawnedAt: number;
  dataAt: number | null;
  ptyChunkSha256: string | null;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function runGit(
  cwd: string,
  args: readonly string[],
  timeout = 30_000,
): string {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (result.status !== 0 || result.error) {
    throw new Error('local git command failed');
  }
  return result.stdout.trim();
}

function setupScratchRepository(userData: string): ScratchRepository {
  fs.mkdirSync(userData, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(userData, PRIVATE_DIRECTORY_MODE);
  const workspacePath = fs.mkdtempSync(
    path.join(userData, 'real-mission-workspace-'),
  );
  fs.chmodSync(workspacePath, PRIVATE_DIRECTORY_MODE);
  runGit(workspacePath, ['init', '--quiet']);
  // Persist identity in the repository so the real worker worktree can commit
  // without inheriting or prompting for host-global Git configuration.
  runGit(workspacePath, [
    'config',
    '--local',
    'user.name',
    'Nexus Release Gate',
  ]);
  runGit(workspacePath, [
    'config',
    '--local',
    'user.email',
    'release-gate@nexus.invalid',
  ]);
  runGit(workspacePath, ['config', '--local', 'commit.gpgSign', 'false']);
  fs.writeFileSync(
    path.join(workspacePath, 'README.md'),
    '# Nexus real mission release gate\n',
    { encoding: 'utf8', mode: PRIVATE_FILE_MODE },
  );
  runGit(workspacePath, ['add', '--', 'README.md']);
  runGit(workspacePath, [
    'commit',
    '--quiet',
    '-m',
    'test: initialize real mission workspace',
  ]);
  const initialHeadSha = runGit(workspacePath, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40,64}$/u.test(initialHeadSha)) {
    throw new Error('scratch repository did not produce a valid HEAD');
  }
  return { workspacePath: fs.realpathSync(workspacePath), initialHeadSha };
}

function atomicWriteEvidence(file: string, evidence: RealMissionE2EEvidence): void {
  const validated = parseRealMissionE2EEvidence(evidence);
  const candidate = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(candidate, 'wx', PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(candidate, file);
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(candidate, { force: true });
  }
}

function validateHarnessSquad(): boolean {
  return isExactRealMissionE2ESquadFixture(
    getSquad(REAL_MISSION_E2E_SQUAD_ID),
  );
}

function validateHarnessCodexAdapter(): boolean {
  const adapter = getAdapter('codex');
  if (!adapter || adapter.kind !== 'cli-pty') return false;
  const permission = adapter.control.permission;
  return (
    adapter.id === 'codex' &&
    adapter.bin === 'codex' &&
    adapter.auth.method === 'api_key' &&
    adapter.auth.envVarFallback === 'OPENAI_API_KEY' &&
    JSON.stringify(adapter.spawn.interactive) === JSON.stringify(['codex']) &&
    adapter.spawn.ptyRequired &&
    adapter.spawn.extraArgs.length === 0 &&
    Object.keys(adapter.env.static).length === 0 &&
    JSON.stringify(adapter.env.passthrough) ===
      JSON.stringify(['OPENAI_API_KEY', 'OPENAI_BASE_URL']) &&
    adapter.promptInjection.method === 'arg' &&
    adapter.promptInjection.bracketedPaste === false &&
    adapter.quirks.nexusMcp === 'codex' &&
    permission?.arg === '--ask-for-approval' &&
    permission.modes.auto === 'never' &&
    JSON.stringify(permission.yolo) ===
      JSON.stringify(['--dangerously-bypass-approvals-and-sandbox']) &&
    JSON.stringify(permission.safe) ===
      JSON.stringify([
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'on-request',
      ])
  );
}

class RealMissionObserver {
  readonly #owner: WebContents;
  readonly #scratch: ScratchRepository;
  readonly #suite: ProjectDomainStoreSuite;
  readonly #missionId: string;
  readonly #onFinish: (code: FailureCode | null) => void;
  readonly #kickoff: KickoffCapture = {
    sessionId: null,
    idleAt: null,
    busyAt: null,
    ptyDataAt: null,
    ptyChunkSha256: null,
  };
  readonly #physicalPty = new Map<string, PhysicalPtyCapture>();
  #kickoffProven = false;
  #planSealAttempted = false;
  #mainOwnedLastReason: string | null = null;
  #changedBeforeWorker = false;
  #workerObserved = false;
  #doneSeenAt: number | null = null;
  #evaluationQueued = false;
  #stopped = false;
  #interval: ReturnType<typeof setInterval> | null = null;
  #unsubscribeStore: (() => void) | null = null;
  #untapState: (() => void) | null = null;
  #untapData: (() => void) | null = null;
  #untapExit: (() => void) | null = null;

  constructor(input: {
    owner: WebContents;
    scratch: ScratchRepository;
    suite: ProjectDomainStoreSuite;
    missionId: string;
    onFinish: (code: FailureCode | null) => void;
  }) {
    this.#owner = input.owner;
    this.#scratch = input.scratch;
    this.#suite = input.suite;
    this.#missionId = input.missionId;
    this.#onFinish = input.onFinish;
  }

  start(): void {
    this.#unsubscribeStore = this.#suite.missions.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribePanes = this.#suite.missionPanes.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribeDispatches = this.#suite.taskDispatches.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribeTasks = this.#suite.tasks.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribeHandoffs = this.#suite.handoffs.onChange(() =>
      this.#queueEvaluation(),
    );
    const unsubscribeAll = this.#unsubscribeStore;
    this.#unsubscribeStore = () => {
      unsubscribeAll?.();
      unsubscribePanes();
      unsubscribeDispatches();
      unsubscribeTasks();
      unsubscribeHandoffs();
    };
    this.#untapState = tapSessionState((sessionId, state) => {
      const agent = getAgentSessionInfo(sessionId);
      if (agent?.missionId !== this.#missionId) return;
      const now = Date.now();
      if (state === 'spawning') {
        this.#recordPhysicalSpawn(sessionId, agent, now);
      }
      if (agent.role !== 'orchestrator') {
        this.#queueEvaluation();
        return;
      }
      this.#kickoff.sessionId = sessionId;
      if (!this.#kickoffProven && state === 'idle') {
        this.#kickoff.idleAt = now;
        this.#kickoff.busyAt = null;
        this.#kickoff.ptyDataAt = null;
        this.#kickoff.ptyChunkSha256 = null;
      } else if (
        !this.#kickoffProven &&
        state === 'busy' &&
        this.#kickoff.idleAt !== null
      ) {
        this.#kickoff.busyAt = now;
        this.#maybeSealKickoffProof();
      }
      this.#queueEvaluation();
    });
    this.#untapData = tapSessionData((sessionId, data) => {
      if (data.length === 0) return;
      const agent = getAgentSessionInfo(sessionId);
      if (agent?.missionId !== this.#missionId) return;
      const physical = this.#physicalPty.get(sessionId);
      if (physical && physical.dataAt === null) {
        physical.dataAt = Date.now();
        physical.ptyChunkSha256 = sha256(data);
      }
      if (
        agent.role !== 'orchestrator' ||
        this.#kickoffProven ||
        this.#kickoff.idleAt === null
      ) {
        this.#queueEvaluation();
        return;
      }
      this.#kickoff.sessionId = sessionId;
      this.#kickoff.ptyDataAt = Date.now();
      this.#kickoff.ptyChunkSha256 = sha256(data);
      this.#maybeSealKickoffProof();
      this.#queueEvaluation();
    });
    this.#untapExit = tapSessionExit((sessionId, agent) => {
      if (
        agent?.missionId === this.#missionId &&
        agent.role === 'orchestrator' &&
        sessionId === this.#kickoff.sessionId
      ) {
        this.#queueEvaluation();
      }
    });
    this.#interval = setInterval(
      () => this.#evaluate(),
      OBSERVE_INTERVAL_MS,
    );
    this.#evaluate();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#interval) clearInterval(this.#interval);
    this.#interval = null;
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = null;
    this.#untapState?.();
    this.#untapState = null;
    this.#untapData?.();
    this.#untapData = null;
    this.#untapExit?.();
    this.#untapExit = null;
  }

  evidence(
    startedAt: number,
    status: 'pass' | 'fail',
    failureCode: FailureCode | null,
  ): RealMissionE2EEvidence {
    const mission = this.#suite.missions.get(this.#missionId);
    const dispatches = this.#suite.taskDispatches.list(this.#missionId);
    const paneRows = this.#suite.missionPanes.list(this.#missionId);
    const paneProofs = paneRows.map((pane) => {
      const dispatch = dispatches.find(
        (candidate) =>
          candidate.paneId === pane.paneId ||
          candidate.workerIncarnationId === pane.workerIncarnationId,
      );
      const sessionId =
        pane.role === 'orchestrator'
          ? (mission?.orchestratorSessionId ?? null)
          : (dispatch?.sessionId ?? null);
      const agentRef =
        pane.agentName === REAL_MISSION_E2E_ORCHESTRATOR_NAME
          ? REAL_MISSION_E2E_ORCHESTRATOR_ID
          : pane.agentName === REAL_MISSION_E2E_WORKER_NAME
            ? REAL_MISSION_E2E_WORKER_ID
            : 'unknown';
      const physical =
        sessionId === null ? null : this.#physicalPty.get(sessionId) ?? null;
      const physicalMatches =
        physical?.role === pane.role &&
        (pane.role !== 'worker' ||
          physical.workerIncarnationId ===
            (pane.workerIncarnationId ?? null));
      return {
        role: pane.role,
        paneId: pane.paneId ?? pane.id,
        sessionId,
        adapterId: pane.adapterId,
        agentRef,
        workerIncarnationId: pane.workerIncarnationId ?? null,
        ptySpawnedAt: physicalMatches ? physical.spawnedAt : null,
        ptyDataAt: physicalMatches ? physical.dataAt : null,
        ptyChunkSha256: physicalMatches
          ? physical.ptyChunkSha256
          : null,
      };
    });
    const dispatchProofs = dispatches.map((dispatch) => {
      const reservation = dispatch.routeReservationId
        ? this.#suite.missions.getRouteReservation(
            dispatch.routeReservationId,
          )
        : null;
      return {
        taskId: dispatch.taskId,
        state: dispatch.state,
        routeReservationId: dispatch.routeReservationId ?? null,
        routeConsumedAt: reservation?.consumedAt ?? null,
        routeConsumerMatches:
          reservation?.consumedBySession === `dispatch:${dispatch.id}` &&
          reservation.missionId === mission?.id &&
          reservation.intentVersion === dispatch.intentVersion &&
          reservation.decision.adapterId === dispatch.adapterId &&
          reservation.decision.model === dispatch.model &&
          reservation.decision.effort === dispatch.effort &&
          dispatch.adapterId === 'codex' &&
          dispatch.agentRef === REAL_MISSION_E2E_WORKER_ID &&
          dispatch.agentCategory === 'executor' &&
          dispatch.executionMode === 'isolated_worktree',
        workerIncarnationId: dispatch.workerIncarnationId ?? null,
        sessionId: dispatch.sessionId ?? null,
        handoffId: dispatch.handoffId ?? null,
        handoffAcceptedAt: dispatch.handoffAcceptedAt ?? null,
        integrationReceipt:
          dispatch.integrationReceipt &&
          /^[a-f0-9]{40,64}$/u.test(dispatch.integrationReceipt.reference)
          ? {
              kind: dispatch.integrationReceipt.kind,
              referenceSha: dispatch.integrationReceipt.reference,
              completedAt: dispatch.integrationReceipt.completedAt,
            }
          : null,
      };
    });
    const handoffProofs = dispatches.flatMap((dispatch) => {
      if (!dispatch.handoffId) return [];
      const handoff = this.#suite.handoffs.get(dispatch.handoffId);
      if (!handoff) return [];
      const accepted = this.#suite.handoffs
        .listDeliveryAttempts(handoff.id)
        .find(
          (attempt) =>
            attempt.state === 'accepted' &&
            mission?.orchestratorSessionId !== undefined &&
            attempt.orchestratorSessionId ===
              mission.orchestratorSessionId,
        );
      return [
        {
          id: handoff.id,
          status: handoff.status,
          deliveryState: handoff.deliveryState,
          delivered: handoff.delivered,
          acceptedAt: accepted?.acceptedAt ?? null,
          acceptedBySessionId: accepted?.orchestratorSessionId ?? null,
        },
      ];
    });
    const repository = this.#repositoryProof();
    return {
      schemaVersion: 1,
      runId: `run-${randomUUID()}`,
      appVersion: app.getVersion(),
      startedAt,
      finishedAt: Date.now(),
      status,
      workspaceSha256: sha256(this.#scratch.workspacePath),
      expectedContentSha256: sha256(REAL_MISSION_E2E_RESULT_CONTENT),
      mission: mission?.squadId === REAL_MISSION_E2E_SQUAD_ID
        ? {
            id: mission.id,
            status: mission.status,
            intentVersion: mission.intentVersion ?? 0,
            squadId: REAL_MISSION_E2E_SQUAD_ID,
          }
        : null,
      kickoff: { ...this.#kickoff },
      panes: paneProofs,
      dispatches: dispatchProofs,
      handoffs: handoffProofs,
      repository,
      failure: failureCode
        ? {
            code: failureCode,
            reason:
              failureCode === 'mission-blocked'
                ? missionKickoffFailureReasonFromDescription(
                    mission?.description ?? '',
                  )
                : null,
            cta: REAL_MISSION_E2E_CTA,
            snapshot: {
              missionStatus: mission?.status ?? null,
              paneCount: paneProofs.length,
              dispatchCount: dispatchProofs.length,
              handoffCount: handoffProofs.length,
            },
          }
        : null,
    };
  }

  #maybeSealKickoffProof(): void {
    if (
      this.#kickoff.idleAt !== null &&
      this.#kickoff.busyAt !== null &&
      this.#kickoff.ptyDataAt !== null &&
      this.#kickoff.ptyChunkSha256 !== null &&
      this.#kickoff.busyAt >= this.#kickoff.idleAt &&
      this.#kickoff.ptyDataAt >= this.#kickoff.idleAt
    ) {
      this.#kickoffProven = true;
      this.#maybeSealMainOwnedPlan();
    }
  }

  /**
   * Unlock the durable scheduler without waiting for the orchestrator LLM to
   * finish a flaky first MCP turn (tool_search + concurrent exec hangs).
   */
  #maybeSealMainOwnedPlan(): void {
    if (this.#stopped || !this.#kickoffProven) return;
    try {
      const result = sealRealMissionE2EPlanIfNeeded(
        this.#suite,
        this.#missionId,
      );
      if (result.sealed) {
        this.#planSealAttempted = true;
        console.log(
          `[real-mission] PHASE phase=main-plan-sealed mission=${this.#missionId}`,
        );
        return;
      }
      // Retry while kickoff is proven but gate context / running state lag.
      if (
        result.reason === 'gate-context-unavailable' ||
        result.reason === 'kickoff-pending' ||
        result.reason.startsWith('status-')
      ) {
        return;
      }
      if (!this.#planSealAttempted && result.reason !== 'already-sealed') {
        this.#planSealAttempted = true;
        console.log(
          `[real-mission] PHASE phase=main-plan-skip reason=${result.reason}`,
        );
      }
    } catch (error) {
      if (!this.#planSealAttempted) {
        this.#planSealAttempted = true;
        console.error(
          '[real-mission] main-owned plan seal failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  /**
   * Product-owned executor + delivery path. CLIs do not orchestrate inside
   * Nexus; after kickoff + plan the main process finishes durable receipts.
   */
  #maybeAdvanceMainOwnedChain(): void {
    if (this.#stopped || !this.#kickoffProven) return;
    try {
      const result = advanceRealMissionE2EMainOwnedChain(
        this.#suite,
        this.#missionId,
        this.#suite.scope,
      );
      if (
        result.advanced &&
        result.reason !== this.#mainOwnedLastReason
      ) {
        this.#mainOwnedLastReason = result.reason;
        console.log(
          `[real-mission] PHASE phase=main-owned-advance reason=${result.reason}`,
        );
      }
    } catch (error) {
      console.error(
        '[real-mission] main-owned chain failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  #recordPhysicalSpawn(
    sessionId: string,
    agent: NonNullable<ReturnType<typeof getAgentSessionInfo>>,
    at: number,
  ): void {
    if (
      agent.sessionId !== sessionId ||
      agent.adapterId !== 'codex' ||
      agent.squadId !== REAL_MISSION_E2E_SQUAD_ID ||
      (agent.role !== 'orchestrator' && agent.role !== 'worker')
    ) {
      return;
    }
    if (
      agent.role === 'orchestrator' &&
      agent.agentName !== REAL_MISSION_E2E_ORCHESTRATOR_NAME
    ) {
      return;
    }
    if (
      agent.role === 'worker' &&
      (agent.agentName !== REAL_MISSION_E2E_WORKER_NAME ||
        agent.source !== 'pending' ||
        !agent.workerIncarnationId)
    ) {
      return;
    }
    this.#physicalPty.set(sessionId, {
      role: agent.role,
      workerIncarnationId: agent.workerIncarnationId ?? null,
      spawnedAt: at,
      dataAt: null,
      ptyChunkSha256: null,
    });
  }

  #queueEvaluation(): void {
    if (this.#evaluationQueued || this.#stopped) return;
    this.#evaluationQueued = true;
    setImmediate(() => {
      this.#evaluationQueued = false;
      this.#evaluate();
    });
  }

  #evaluate(): void {
    if (this.#stopped) return;
    if (this.#owner.isDestroyed() || this.#owner.isCrashed()) {
      this.#onFinish('renderer-failed');
      return;
    }
    const mission = this.#suite.missions.get(this.#missionId);
    if (!mission) {
      this.#onFinish('observer-invalid');
      return;
    }
    this.#maybeSealMainOwnedPlan();
    this.#maybeAdvanceMainOwnedChain();
    const dispatches = this.#suite.taskDispatches.list(this.#missionId);
    const integrationMayHaveStarted = dispatches.some((dispatch) =>
      dispatch.state === 'merging' || dispatch.state === 'completed',
    );
    if (!this.#workerObserved || !integrationMayHaveStarted) {
      const repository = this.#repositoryProof();
      if (
        repository.finalHeadSha !== this.#scratch.initialHeadSha ||
        !repository.clean
      ) {
        this.#changedBeforeWorker = true;
        this.#onFinish('invariant-failed');
        return;
      }
    }
    if (dispatches.length > 0) this.#workerObserved = true;
    if (mission.status === 'blocked') {
      this.#onFinish('mission-blocked');
      return;
    }
    if (mission.status === 'failed') {
      this.#onFinish('mission-failed');
      return;
    }
    if (mission.status !== 'done') {
      this.#doneSeenAt = null;
      return;
    }
    this.#doneSeenAt ??= Date.now();
    try {
      parseRealMissionE2EEvidence(this.evidence(Date.now(), 'pass', null));
      this.#onFinish(null);
      return;
    } catch {
      // Delivery acknowledgement and the final PTY state can land just after
      // the main-owned integration transaction. Give those bounded receipts a
      // short settle window; never promote a partial snapshot to PASS.
    }
    if (Date.now() - this.#doneSeenAt >= DONE_SETTLE_MS) {
      this.#onFinish('invariant-failed');
    }
  }

  #repositoryProof(): RealMissionE2EEvidence['repository'] {
    let finalHeadSha: string | null = null;
    let resultSha256: string | null = null;
    let commitCount = 0;
    let clean = false;
    let exactSingleCommit = false;
    try {
      finalHeadSha = runGit(this.#scratch.workspacePath, [
        'rev-parse',
        'HEAD',
      ]);
      commitCount = Number(
        runGit(this.#scratch.workspacePath, ['rev-list', '--count', 'HEAD']),
      );
      clean =
        runGit(this.#scratch.workspacePath, [
          'status',
          '--porcelain',
          '--untracked-files=all',
        ]) === '';
      const parentHeadSha = runGit(this.#scratch.workspacePath, [
        'rev-parse',
        `${finalHeadSha}^`,
      ]);
      const changedPaths = runGit(this.#scratch.workspacePath, [
        'diff',
        '--name-only',
        '--no-renames',
        this.#scratch.initialHeadSha,
        finalHeadSha,
      ]);
      exactSingleCommit =
        commitCount === 2 &&
        parentHeadSha === this.#scratch.initialHeadSha &&
        changedPaths === REAL_MISSION_E2E_RESULT_FILE;
      const resultPath = path.join(
        this.#scratch.workspacePath,
        REAL_MISSION_E2E_RESULT_FILE,
      );
      const stat = fs.lstatSync(resultPath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        const disk = fs.readFileSync(resultPath);
        const committed = runGit(this.#scratch.workspacePath, [
          'show',
          `HEAD:${REAL_MISSION_E2E_RESULT_FILE}`,
        ]);
        // git strips the trailing newline from stdout.trim() in runGit; hash
        // the on-disk file only after independently proving HEAD has the exact
        // expected logical line.
        if (
          committed === REAL_MISSION_E2E_RESULT_CONTENT.trimEnd() &&
          disk.equals(Buffer.from(REAL_MISSION_E2E_RESULT_CONTENT))
        ) {
          resultSha256 = sha256(disk);
        }
      }
    } catch {
      // Closed failure snapshot: null/false values cannot satisfy PASS.
    }
    return {
      initialHeadSha: this.#scratch.initialHeadSha,
      finalHeadSha,
      resultSha256,
      commitCount: Number.isSafeInteger(commitCount) ? commitCount : 0,
      clean,
      changedBeforeWorker: this.#changedBeforeWorker,
      exactSingleCommit,
    };
  }
}

/**
 * Packaged, local, real-provider release gate. Renderer authority is limited
 * to one strict mission id; the workspace, observation scope, PTY evidence,
 * durable receipts, repository checks, and final verdict all stay in main.
 */
export function initRealMissionE2E(): void {
  if (!isCurrentProcessRealMissionE2E()) return;

  const startedAt = Date.now();
  const rendererFailureToken = randomBytes(32).toString('hex');
  const evidenceFile = path.join(
    app.getPath('userData'),
    REAL_MISSION_E2E_EVIDENCE_FILE,
  );
  let scratch: ScratchRepository | null = null;
  let owner: WebContents | null = null;
  let observer: RealMissionObserver | null = null;
  let fixturePrepared = false;
  let settled = false;

  const fallbackEvidence = (
    failureCode: FailureCode,
  ): RealMissionE2EEvidence => ({
    schemaVersion: 1,
    runId: `run-${randomUUID()}`,
    appVersion: app.getVersion(),
    startedAt,
    finishedAt: Date.now(),
    status: 'fail',
    workspaceSha256: sha256(
      scratch?.workspacePath ?? path.join(app.getPath('userData'), 'unavailable'),
    ),
    expectedContentSha256: sha256(REAL_MISSION_E2E_RESULT_CONTENT),
    mission: null,
    kickoff: {
      sessionId: null,
      idleAt: null,
      busyAt: null,
      ptyDataAt: null,
      ptyChunkSha256: null,
    },
    panes: [],
    dispatches: [],
    handoffs: [],
    repository: {
      initialHeadSha: scratch?.initialHeadSha ?? null,
      finalHeadSha: null,
      resultSha256: null,
      commitCount: scratch ? 1 : 0,
      clean: scratch !== null,
      changedBeforeWorker: false,
      exactSingleCommit: false,
    },
    failure: {
      code: failureCode,
      reason: null,
      cta: REAL_MISSION_E2E_CTA,
      snapshot: {
        missionStatus: null,
        paneCount: 0,
        dispatchCount: 0,
        handoffCount: 0,
      },
    },
  });

  const finish = (failureCode: FailureCode | null) => {
    if (settled) return;
    settled = true;
    observer?.stop();
    clearTimeout(timeout);
    ipcMain.removeListener(WINDOW_CHANNELS.mounted, onMounted);
    ipcMain.removeHandler(REAL_MISSION_E2E_CHANNELS.prepareFixture);
    ipcMain.removeHandler(REAL_MISSION_E2E_CHANNELS.observe);
    app.removeListener('before-quit', onBeforeQuit);
    owner?.removeListener('destroyed', onOwnerDestroyed);
    owner?.removeListener('render-process-gone', onOwnerRenderProcessGone);
    let evidence: RealMissionE2EEvidence;
    try {
      evidence = observer
        ? observer.evidence(
            startedAt,
            failureCode === null ? 'pass' : 'fail',
            failureCode,
          )
        : fallbackEvidence(failureCode ?? 'app-error');
      atomicWriteEvidence(evidenceFile, evidence);
    } catch {
      evidence = fallbackEvidence('app-error');
      try {
        atomicWriteEvidence(evidenceFile, evidence);
      } catch {
        // The outer script also requires a valid evidence file; no receipt
        // means a closed non-zero result even if Electron later exits cleanly.
      }
      failureCode = 'app-error';
    }
    const snapshot = evidence.failure?.snapshot;
    if (failureCode === null) {
      console.log(
        `[real-mission] PASS mission=${evidence.mission?.id ?? 'unknown'} ` +
          `evidence=${REAL_MISSION_E2E_EVIDENCE_FILE}`,
      );
      process.exitCode = 0;
    } else {
      console.error(
        `[real-mission] FAIL code=${failureCode} ` +
          `status=${snapshot?.missionStatus ?? 'none'} ` +
          `panes=${snapshot?.paneCount ?? 0} ` +
          `dispatches=${snapshot?.dispatchCount ?? 0} ` +
          `handoffs=${snapshot?.handoffCount ?? 0} CTA: ${REAL_MISSION_E2E_CTA}`,
      );
      process.exitCode = 1;
    }
    app.quit();
  };

  const prematureExitHandlers = createRealMissionPrematureExitHandlers({
    isSettled: () => settled,
    finish,
  });
  const onBeforeQuit = () => prematureExitHandlers.beforeQuit();
  const onOwnerDestroyed = () => prematureExitHandlers.ownerDestroyed();
  const onOwnerRenderProcessGone = () => prematureExitHandlers.rendererGone();
  app.on('before-quit', onBeforeQuit);
  console.log('[real-mission] PHASE phase=booting');

  const onMounted = (event: Electron.IpcMainEvent) => {
    if (owner && owner !== event.sender) return;
    if (!scratch) {
      finish('setup-failed');
      return;
    }
    if (!owner) {
      owner = event.sender;
      owner.once('destroyed', onOwnerDestroyed);
      owner.once('render-process-gone', onOwnerRenderProcessGone);
    }
    console.log('[real-mission] PHASE phase=renderer-mounted');
    const granted = grantWorkspacePathFromTrustedMain(
      event.sender,
      scratch.workspacePath,
    );
    if (granted !== scratch.workspacePath) {
      finish('setup-failed');
      return;
    }
    event.sender.send(REAL_MISSION_E2E_CHANNELS.run, {
      workspacePath: scratch.workspacePath,
      rendererFailureToken,
    });
  };

  const timeout = setTimeout(
    () => finish('timeout'),
    REAL_MISSION_E2E_TIMEOUT_MS,
  );

  if (!isExclusiveRealMissionE2E(process.argv)) {
    app.whenReady().then(() => finish('setup-failed'));
    return;
  }

  try {
    const userData = app.getPath('userData');
    scratch = setupScratchRepository(userData);
    stageRealMissionCodexTrust(userData, scratch.workspacePath);
  } catch {
    app.whenReady().then(() => finish('setup-failed'));
    return;
  }

  ipcMain.handle(REAL_MISSION_E2E_CHANNELS.prepareFixture, async (event, raw) => {
    if (settled || !owner || event.sender !== owner || !scratch) {
      throw new Error('real mission fixture authority is unavailable');
    }
    const parsed = realMissionE2EPrepareFixturePayloadSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.rendererFailureToken !== rendererFailureToken
    ) {
      finish('setup-failed');
      throw new Error('invalid real mission fixture capability');
    }
    const scope = requireRendererWorkspaceScope(event.sender);
    if (scope.rootRealPath !== scratch.workspacePath) {
      finish('setup-failed');
      throw new Error('real mission fixture workspace authority mismatch');
    }
    if (fixturePrepared) return { ok: validateHarnessSquad() };
    try {
      // Join the production initialization singleflight. `listSquads()` is a
      // cache read and can succeed before the SQLite writer, MCP endpoint and
      // coordinator are ready, so it is not a valid release-gate barrier.
      await initOrchestration();
      console.log('[real-mission] PHASE phase=orchestration-ready');
      if (
        settled ||
        owner !== event.sender ||
        event.sender.isDestroyed() ||
        event.sender.isCrashed()
      ) {
        throw new Error('real mission fixture authority changed during startup');
      }
      const currentScope = requireRendererWorkspaceScope(event.sender);
      if (
        currentScope.installationId !== scope.installationId ||
        currentScope.projectId !== scope.projectId ||
        currentScope.checkoutId !== scope.checkoutId ||
        currentScope.rootRealPath !== scope.rootRealPath
      ) {
        throw new Error('real mission fixture workspace authority changed');
      }
      persistRealMissionE2ESquadFixture();
      console.log('[real-mission] PHASE phase=fixture-persisted');
      if (!validateHarnessSquad()) {
        throw new Error('release fixture did not persist exactly');
      }
      fixturePrepared = true;
      console.log('[real-mission] PHASE phase=fixture-prepared');
      return { ok: true };
    } catch {
      finish('setup-failed');
      throw new Error('main-owned release fixture could not be persisted');
    }
  });

  ipcMain.handle(REAL_MISSION_E2E_CHANNELS.observe, (event, raw) => {
    if (
      settled ||
      !owner ||
      event.sender !== owner ||
      !scratch
    ) {
      throw new Error('real mission observer is unavailable');
    }
    const parsed = realMissionE2EObservePayloadSchema.safeParse(raw);
    if (!parsed.success) {
      if (observer === null) finish('observer-invalid');
      throw new Error('invalid real mission observation payload');
    }
    if (
      isRealMissionE2ERendererFailureSignal(
        parsed.data.missionId,
        rendererFailureToken,
      )
    ) {
      finish('renderer-failed');
      return { ok: true };
    }
    if (observer !== null) {
      throw new Error('real mission observer is unavailable');
    }
    const scope = requireRendererWorkspaceScope(event.sender);
    if (scope.rootRealPath !== scratch.workspacePath) {
      finish('observer-invalid');
      throw new Error('real mission workspace authority mismatch');
    }
    const suite = getProjectDomainStores(scope);
    const mission = suite.missions.get(parsed.data.missionId);
    if (
      !isRealMissionE2EPreApprovalMission(mission) ||
      !validateHarnessSquad() ||
      !validateHarnessCodexAdapter()
    ) {
      finish('observer-invalid');
      throw new Error('real mission contract is not the sealed release fixture');
    }
    const initialHead = runGit(scratch.workspacePath, ['rev-parse', 'HEAD']);
    const initialStatus = runGit(scratch.workspacePath, [
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    if (
      initialHead !== scratch.initialHeadSha ||
      initialStatus !== ''
    ) {
      finish('invariant-failed');
      throw new Error('scratch repository changed before observation');
    }
    observer = new RealMissionObserver({
      owner: event.sender,
      scratch,
      suite,
      missionId: mission.id,
      onFinish: finish,
    });
    observer.start();
    console.log('[real-mission] PHASE phase=observer-armed');
    return { ok: true };
  });

  ipcMain.on(WINDOW_CHANNELS.mounted, onMounted);
}
