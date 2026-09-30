import { assertLicenseAccess } from '../license-enforcement';
import { LicenseError } from '../../shared/license-errors';
/**
 * Production ACP harness driver — lifecycle over AcpClient with typed
 * observer frames. Never scrapes terminal scrollback and never falls back
 * to PTY: when this driver is selected, failures surface as explicit errors.
 *
 * Design distilled from block/buzz buzz-acp (Apache-2.0).
 */
import { randomUUID } from 'node:crypto';

import type { AcpMcpServerSpec } from '../../shared/acp-protocol';
import type { HarnessDefinition } from '../../shared/harness-catalog';
import type { ObserverFrameInput, ObserverSemanticStatus } from '../../shared/observer-frame';
import type { MissionPaneAuthoritySeal } from '../../shared/orch-types';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import { recordPaneSessionExit, recordPaneSessionState } from '../orch/pane-session-output';
import { publishObserverFrame } from '../orch/observer-bus';
import {
  registerExternalWorkerSession,
  unregisterExternalWorkerSession,
} from '../orch/external-worker-session-registry';
import {
  bindTokenToSession,
  releaseSession,
  releaseSessionByToken,
} from '../orch/gate';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  AcpClient,
  AcpClientError,
  type AcpPromptOptions,
  type AcpTurnHandle,
} from './acp-client';
import {
  acpExitReasonFromError,
  buildProviderErrorFrame,
  buildSessionExitedFrame,
  buildSessionSpawnedFrame,
  buildStatusChangedFrame,
  buildTurnEndedFrame,
  buildTurnStartedFrame,
  framesForTurnEvent,
  type AcpObserverScope,
} from './acp-observer-bridge';
import { requestAcpPermission } from './acp-permission-ui';

export interface AcpDriverSpawnInput {
  readonly harness: HarnessDefinition;
  readonly cwd: string;
  readonly paneId: string;
  readonly missionId: string;
  readonly scope: ProjectExecutionScope;
  readonly adapterId?: string;
  readonly role?: 'orchestrator' | 'worker';
  readonly workerIncarnationId?: string;
  readonly mcpServers?: readonly AcpMcpServerSpec[];
  /** Nexus bearer bound to the ACP session after session/new succeeds. */
  readonly mcpToken?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly model?: string;
  readonly accountId?: string;
  readonly effort?: string;
  readonly agentName?: string;
  readonly readOnly?: boolean;
  readonly nativeReadOnly?: boolean;
  readonly allowedTools?: readonly string[] | null;
  readonly allowedSkills?: readonly string[] | null;
  readonly authoritySeal?: MissionPaneAuthoritySeal;
  readonly requestTimeoutMs?: number;
  readonly publishFrame?: (frame: ObserverFrameInput) => void;
}

/** A client that never answers shutdown must not block teardown forever. */
const ACP_SHUTDOWN_TIMEOUT_MS = 10_000;
const ACP_SHUTDOWN_TIMEOUT_MESSAGE = 'acp-shutdown-timeout';

export interface AcpDriverSession {
  readonly sessionId: string;
  readonly acpSessionId: string;
  readonly paneId: string;
  readonly missionId: string;
  readonly harnessId: string;
  readonly role: 'orchestrator' | 'worker';
  readonly scope: Readonly<ProjectExecutionScope>;
  /** Main-owned identity mirror used by orchestration authority checks. */
  readonly agent: OwnedAgentSessionInfo;
  readonly pid: number | undefined;
  prompt(text: string, options?: AcpPromptOptions): Promise<void>;
  cancel(): Promise<void>;
  shutdown(): Promise<void>;
}

interface LiveSession {
  client: AcpClient;
  acpSessionId: string;
  scope: AcpObserverScope;
  turnSequence: number;
  lastStatus: ObserverSemanticStatus | null;
  activeTurn: AcpTurnHandle | null;
  closed: boolean;
  publish: (frame: ObserverFrameInput) => void;
  harnessId: string;
  agent: OwnedAgentSessionInfo;
  mcpToken?: string;
}

const liveBySessionId = new Map<string, LiveSession>();

function defaultPublish(frame: ObserverFrameInput): void {
  publishObserverFrame(frame);
}

function agentInfoForInput(
  input: AcpDriverSpawnInput,
  sessionId: string,
): OwnedAgentSessionInfo {
  const role = input.role ?? 'worker';
  return Object.freeze({
    sessionId,
    paneId: input.paneId,
    adapterId: input.adapterId ?? input.harness.id,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.model !== undefined ? { requestedModel: input.model } : {}),
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    cwd: input.cwd,
    scope: Object.freeze({ ...input.scope }),
    source: 'pending' as const,
    role,
    missionId: input.missionId,
    ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    ...(input.workerIncarnationId !== undefined
      ? { workerIncarnationId: input.workerIncarnationId }
      : {}),
    readOnly: input.readOnly === true,
    nativeReadOnly: input.nativeReadOnly === true,
    allowedTools:
      input.allowedTools === undefined || input.allowedTools === null
        ? null
        : [...input.allowedTools],
    allowedSkills:
      input.allowedSkills === undefined || input.allowedSkills === null
        ? null
        : [...input.allowedSkills],
    ...(input.authoritySeal
      ? { authoritySeal: Object.freeze({ ...input.authoritySeal }) }
      : {}),
  });
}

function setStatus(live: LiveSession, status: ObserverSemanticStatus): void {
  const previous = live.lastStatus;
  if (previous === status) return;
  live.publish(buildStatusChangedFrame(live.scope, status, previous));
  live.lastStatus = status;
  recordPaneSessionState(
    live.scope.sessionId,
    status === 'working' ? 'busy' : status === 'error' ? 'exited' : 'idle',
  );
}

function closeLive(
  sessionId: string,
  reason: Parameters<typeof buildSessionExitedFrame>[1],
  error?: AcpClientError,
): void {
  const live = liveBySessionId.get(sessionId);
  if (!live || live.closed) return;
  live.closed = true;
  liveBySessionId.delete(sessionId);
  unregisterExternalWorkerSession(sessionId);
  if (live.mcpToken) releaseSession(sessionId);
  if (error) {
    live.publish(buildProviderErrorFrame(live.scope, error.message));
  }
  setStatus(live, 'error');
  live.publish(
    buildSessionExitedFrame(live.scope, reason, live.lastStatus),
  );
  recordPaneSessionExit(sessionId);
}

async function promptLiveSession(
  sessionId: string,
  live: LiveSession,
  text: string,
  options?: AcpPromptOptions,
): Promise<void> {
  if (live.closed) {
    throw new AcpClientError('disposed', 'ACP session already shut down');
  }
  if (live.activeTurn) {
    throw new AcpClientError(
      'protocol',
      'a prompt is already in flight on this ACP session',
    );
  }
  live.turnSequence += 1;
  const turnId = `turn-${live.turnSequence}`;
  live.publish(buildTurnStartedFrame(live.scope, turnId, live.turnSequence));
  setStatus(live, 'working');
  const turn = live.client.prompt(live.acpSessionId, text, options);
  live.activeTurn = turn;
  try {
    for await (const event of turn) {
      for (const frame of framesForTurnEvent(live.scope, event)) {
        live.publish(frame);
      }
      if (event.type === 'stop') {
        const outcome =
          event.stopReason === 'end_turn' ||
          event.stopReason === 'max_tokens' ||
          event.stopReason === 'cancelled'
            ? 'completed'
            : 'error';
        live.publish(buildTurnEndedFrame(live.scope, turnId, outcome));
        setStatus(live, outcome === 'completed' ? 'completed' : 'error');
      }
    }
  } catch (error) {
    const wrapped =
      error instanceof AcpClientError
        ? error
        : new AcpClientError(
            'protocol',
            error instanceof Error ? error.message : String(error),
          );
    live.publish(buildTurnEndedFrame(live.scope, turnId, 'error'));
    closeLive(sessionId, acpExitReasonFromError(wrapped), wrapped);
    throw wrapped;
  } finally {
    live.activeTurn = null;
  }
}

/**
 * Spawn → initialize → session/new. Registers an external (non-PTY) worker
 * session and emits session_spawned. Does not fall back to PTY on failure.
 */
export async function spawnAcpHarnessSession(
  input: AcpDriverSpawnInput,
): Promise<AcpDriverSession> {
  assertLicenseAccess();
  const sessionId = `acp-${randomUUID()}`;
  const publish = input.publishFrame ?? defaultPublish;
  const observerScope: AcpObserverScope = {
    sessionId,
    paneId: input.paneId,
    missionId: input.missionId,
    adapterId: input.adapterId ?? input.harness.id,
    role: input.role ?? 'worker',
  };
  const agent = agentInfoForInput(input, sessionId);

  let client: AcpClient;
  try {
    client = AcpClient.spawn({
      command: input.harness.command,
      args: input.harness.args,
      cwd: input.cwd,
      env: { ...input.harness.env, ...(input.env ?? {}) },
      requestTimeoutMs: input.requestTimeoutMs,
      requestPermission: (params) =>
        requestAcpPermission(params, {
          agentLabel: input.agentName ?? input.harness.label,
          missionId: input.missionId,
        }),
    });
  } catch (error) {
    if (error instanceof LicenseError) throw error;
    const wrapped =
      error instanceof AcpClientError
        ? error
        : new AcpClientError(
            'spawn-failed',
            error instanceof Error ? error.message : String(error),
          );
    publish(buildProviderErrorFrame(observerScope, wrapped.message));
    publish(buildSessionExitedFrame(observerScope, 'acp-error', null));
    throw wrapped;
  }

  const live: LiveSession = {
    client,
    acpSessionId: '',
    scope: observerScope,
    turnSequence: 0,
    lastStatus: null,
    activeTurn: null,
    closed: false,
    publish,
    harnessId: input.harness.id,
    agent,
    ...(input.mcpToken ? { mcpToken: input.mcpToken } : {}),
  };

  try {
    await client.initialize();
    live.acpSessionId = await client.sessionNew(
      input.cwd,
      input.mcpServers ?? [],
    );
    if (input.mcpToken) bindTokenToSession(input.mcpToken, sessionId);
  } catch (error) {
    const wrapped =
      error instanceof AcpClientError
        ? error
        : new AcpClientError(
            'protocol',
            error instanceof Error ? error.message : String(error),
          );
    try {
      await client.shutdown();
    } catch {
      /* already dead */
    }
    if (input.mcpToken) releaseSessionByToken(input.mcpToken);
    publish(buildProviderErrorFrame(observerScope, wrapped.message));
    publish(
      buildSessionExitedFrame(
        observerScope,
        acpExitReasonFromError(wrapped),
        null,
      ),
    );
    throw wrapped;
  }

  liveBySessionId.set(sessionId, live);
  if (agent.role === 'worker') {
    registerExternalWorkerSession({
      sessionId,
      missionId: input.missionId,
      workerIncarnationId: input.workerIncarnationId,
      scope: input.scope,
    });
  }
  publish(buildSessionSpawnedFrame(observerScope));
  setStatus(live, 'idle');

  const handle: AcpDriverSession = {
    sessionId,
    acpSessionId: live.acpSessionId,
    paneId: input.paneId,
    missionId: input.missionId,
    harnessId: input.harness.id,
    role: input.role ?? 'worker',
    scope: Object.freeze({ ...input.scope }),
    agent,
    get pid() {
      return live.client.pid;
    },
    async prompt(text: string, options?: AcpPromptOptions): Promise<void> {
      await promptLiveSession(sessionId, live, text, options);
    },
    async cancel(): Promise<void> {
      if (live.closed) return;
      try {
        await live.client.cancel(live.acpSessionId);
      } catch (error) {
        const wrapped =
          error instanceof AcpClientError
            ? error
            : new AcpClientError(
                'protocol',
                error instanceof Error ? error.message : String(error),
              );
        closeLive(sessionId, 'acp-cancel', wrapped);
        throw wrapped;
      }
    },
    async shutdown(): Promise<void> {
      if (live.closed) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(ACP_SHUTDOWN_TIMEOUT_MESSAGE)),
          ACP_SHUTDOWN_TIMEOUT_MS,
        );
      });
      try {
        try {
          await Promise.race([live.client.shutdown(), timeout]);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        // Hung shutdown: local state dies in the finally below, and callers
        // that probe `getAcpDriverSession` see the session gone. Protocol
        // errors keep propagating exactly as before.
        if (
          !(error instanceof Error) ||
          error.message !== ACP_SHUTDOWN_TIMEOUT_MESSAGE
        ) {
          throw error;
        }
      } finally {
        closeLive(sessionId, 'acp-shutdown');
      }
    },
  };

  return handle;
}

export function getAcpDriverSession(
  sessionId: string,
): AcpDriverSession | null {
  const live = liveBySessionId.get(sessionId);
  if (!live || live.closed) return null;
  return {
    sessionId,
    acpSessionId: live.acpSessionId,
    paneId: live.scope.paneId ?? sessionId,
    missionId: live.scope.missionId ?? '',
    harnessId: live.harnessId,
    role: live.agent.role === 'worker' ? 'worker' : 'orchestrator',
    scope: Object.freeze({ ...live.agent.scope }),
    agent: live.agent,
    get pid() {
      return live.client.pid;
    },
    prompt: async (text: string, options?: AcpPromptOptions) => {
      await promptLiveSession(sessionId, live, text, options);
    },
    cancel: async () => {
      await live.client.cancel(live.acpSessionId);
    },
    shutdown: async () => {
      await live.client.shutdown();
      closeLive(sessionId, 'acp-shutdown');
    },
  };
}

export function getAcpDriverSemanticStatus(
  sessionId: string,
): ObserverSemanticStatus | null {
  const live = liveBySessionId.get(sessionId);
  return live && !live.closed ? live.lastStatus : null;
}

/** Snapshot of all live ACP agent identities for mission teardown/recovery. */
export function listAcpDriverAgentSessions(): OwnedAgentSessionInfo[] {
  return [...liveBySessionId.values()]
    .filter((live) => !live.closed)
    .map((live) => live.agent);
}

/**
 * Terminate one ACP child from a main-owned pane lifecycle boundary. Returning
 * `false` for an unknown id lets callers distinguish an already-exited child
 * from a live ACP process without guessing from PTY state.
 */
export async function shutdownAcpDriverSession(
  sessionId: string,
): Promise<boolean> {
  const session = getAcpDriverSession(sessionId);
  if (!session) return false;
  await session.shutdown();
  return true;
}

/** Shutdown all live ACP children during app teardown. */
export async function shutdownAllAcpDriverSessions(): Promise<void> {
  const sessionIds = [...liveBySessionId.keys()];
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        await shutdownAcpDriverSession(sessionId);
      } catch (error) {
        console.warn(
          `[acp] shutdown failed for ${sessionId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }),
  );
}

/** Test helper — drops in-memory sessions without touching processes. */
export function resetAcpDriverSessionsForTests(): void {
  liveBySessionId.clear();
}
