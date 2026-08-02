/**
 * Map ACP turn events onto typed observer frames.
 *
 * The ACP path must never fall back to PTY scrollback: every lifecycle and
 * tool event is published as a first-class ObserverFrame so detectors and the
 * mission journal see the same contract as the hook/PTY path.
 */
import type { AcpSessionUpdate } from '../../shared/acp-protocol';
import type {
  ObserverFrameInput,
  ObserverSemanticStatus,
  ObserverSessionExitedPayload,
} from '../../shared/observer-frame';
import type { AcpClientError, AcpTurnEvent } from './acp-client';

export interface AcpObserverScope {
  readonly sessionId: string;
  readonly paneId?: string;
  readonly missionId?: string;
  readonly adapterId?: string | null;
  readonly role?: 'orchestrator' | 'worker' | 'user' | null;
}

export type AcpExitReason = ObserverSessionExitedPayload['reason'];

export function acpExitReasonFromError(error: AcpClientError): AcpExitReason {
  switch (error.code) {
    case 'request-timeout':
    case 'idle-timeout':
    case 'hard-timeout':
    case 'write-timeout':
    case 'cancel-drain-timeout':
      return 'acp-timeout';
    case 'disposed':
      return 'acp-shutdown';
    case 'peer-exited':
      return 'acp-peer-exited';
    case 'agent-error':
    case 'protocol':
    case 'spawn-failed':
    case 'backpressure':
      return 'acp-error';
    default:
      return 'acp-error';
  }
}

export function buildSessionSpawnedFrame(
  scope: AcpObserverScope,
): ObserverFrameInput {
  return {
    kind: 'session_spawned',
    sessionId: scope.sessionId,
    paneId: scope.paneId,
    missionId: scope.missionId,
    payload: {
      adapterId: scope.adapterId ?? null,
      role: scope.role ?? null,
    },
  };
}

export function buildSessionExitedFrame(
  scope: AcpObserverScope,
  reason: AcpExitReason,
  lastStatus: ObserverSemanticStatus | null,
): ObserverFrameInput {
  return {
    kind: 'session_exited',
    sessionId: scope.sessionId,
    paneId: scope.paneId,
    missionId: scope.missionId,
    payload: { reason, lastStatus },
  };
}

export function buildTurnStartedFrame(
  scope: AcpObserverScope,
  turnId: string,
  turnSequence: number,
): ObserverFrameInput {
  return {
    kind: 'turn_started',
    sessionId: scope.sessionId,
    paneId: scope.paneId,
    missionId: scope.missionId,
    turnId,
    payload: { turnId, turnSequence },
  };
}

export function buildTurnEndedFrame(
  scope: AcpObserverScope,
  turnId: string | null,
  outcome: 'completed' | 'error',
): ObserverFrameInput {
  return {
    kind: 'turn_ended',
    sessionId: scope.sessionId,
    paneId: scope.paneId,
    missionId: scope.missionId,
    turnId: turnId ?? undefined,
    payload: { turnId, outcome },
  };
}

export function buildStatusChangedFrame(
  scope: AcpObserverScope,
  status: ObserverSemanticStatus,
  previousStatus: ObserverSemanticStatus | null,
): ObserverFrameInput {
  return {
    kind: 'status_changed',
    sessionId: scope.sessionId,
    paneId: scope.paneId,
    missionId: scope.missionId,
    payload: {
      paneId: scope.paneId ?? scope.sessionId,
      status,
      previousStatus,
      transitioned: previousStatus !== status,
    },
  };
}

export function buildProviderErrorFrame(
  scope: AcpObserverScope,
  reason: string,
): ObserverFrameInput {
  return {
    kind: 'provider_error',
    sessionId: scope.sessionId,
    paneId: scope.paneId,
    missionId: scope.missionId,
    payload: {
      source: 'acp-driver',
      kind: 'transient',
      reason: reason.slice(0, 512),
      cooldownMs: 0,
    },
  };
}

function mapToolStatus(
  status: string | undefined,
): 'call' | 'result-ok' | 'result-fail' | 'ignore' {
  if (status === undefined || status === 'pending' || status === 'in_progress') {
    return status === 'pending' || status === undefined ? 'call' : 'ignore';
  }
  if (status === 'completed') return 'result-ok';
  if (status === 'failed') return 'result-fail';
  return 'ignore';
}

export function framesForSessionUpdate(
  scope: AcpObserverScope,
  update: AcpSessionUpdate,
): ObserverFrameInput[] {
  if (update.sessionUpdate === 'tool_call') {
    return [
      {
        kind: 'tool_call',
        sessionId: scope.sessionId,
        paneId: scope.paneId,
        missionId: scope.missionId,
        payload: {
          callId: update.toolCallId,
          toolName: update.title ?? null,
        },
      },
    ];
  }
  if (update.sessionUpdate === 'tool_call_update') {
    const mapped = mapToolStatus(update.status);
    if (mapped === 'call') {
      return [
        {
          kind: 'tool_call',
          sessionId: scope.sessionId,
          paneId: scope.paneId,
          missionId: scope.missionId,
          payload: {
            callId: update.toolCallId,
            toolName: null,
          },
        },
      ];
    }
    if (mapped === 'result-ok' || mapped === 'result-fail') {
      return [
        {
          kind: 'tool_result',
          sessionId: scope.sessionId,
          paneId: scope.paneId,
          missionId: scope.missionId,
          payload: {
            callId: update.toolCallId,
            toolName: null,
            ok: mapped === 'result-ok',
          },
        },
      ];
    }
  }
  return [];
}

export function framesForTurnEvent(
  scope: AcpObserverScope,
  event: AcpTurnEvent,
): ObserverFrameInput[] {
  if (event.type === 'update') {
    return framesForSessionUpdate(scope, event.update);
  }
  return [];
}
