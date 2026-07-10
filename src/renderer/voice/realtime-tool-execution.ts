import type {
  JarvisLiveToolCancellationEvent,
  JarvisLiveToolCancellationReason,
} from '../../shared/voice-ipc';

const MAX_EXECUTION_RECORDS = 512;

type ExecutionStatus = 'running' | 'completed' | 'cancelled';

interface ExecutionRecord {
  controller: AbortController;
  status: ExecutionStatus;
  effectMayHaveCommitted: boolean;
  cancellation?: JarvisLiveToolCancellationEvent;
}

const executions = new Map<string, ExecutionRecord>();

function executionKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

export class RealtimeToolCancelledError extends Error {
  readonly name = 'RealtimeToolCancelledError';

  constructor(
    readonly callId: string,
    readonly reason: JarvisLiveToolCancellationReason,
    readonly effectMayHaveCommitted: boolean,
  ) {
    super(
      effectMayHaveCommitted
        ? `Live tool ${callId} cancelled after an effect may have committed`
        : `Live tool ${callId} cancelled before execution completed`,
    );
  }
}

export interface RealtimeToolExecution {
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly effectMayHaveCommitted: boolean;
  checkpoint(): void;
  markEffectMayHaveCommitted(): void;
  finish(): void;
}

export type RealtimeToolExecutionClaim =
  | { status: 'started'; execution: RealtimeToolExecution }
  | {
      status: 'duplicate' | 'cancelled';
      effectMayHaveCommitted: boolean;
    };

function trimExecutionRecords(): void {
  if (executions.size <= MAX_EXECUTION_RECORDS) return;
  for (const [callId, record] of executions) {
    if (record.status === 'running') continue;
    executions.delete(callId);
    if (executions.size <= MAX_EXECUTION_RECORDS) return;
  }
}

export function beginRealtimeToolExecution(
  sessionId: string,
  callId: string,
): RealtimeToolExecutionClaim {
  const key = executionKey(sessionId, callId);
  const existing = executions.get(key);
  if (existing) {
    return {
      status: existing.status === 'cancelled' ? 'cancelled' : 'duplicate',
      effectMayHaveCommitted: existing.effectMayHaveCommitted,
    };
  }

  const record: ExecutionRecord = {
    controller: new AbortController(),
    status: 'running',
    effectMayHaveCommitted: false,
  };
  executions.set(key, record);
  trimExecutionRecords();

  const execution: RealtimeToolExecution = {
    callId,
    signal: record.controller.signal,
    get effectMayHaveCommitted() {
      return record.effectMayHaveCommitted;
    },
    checkpoint() {
      if (!record.controller.signal.aborted) return;
      throw new RealtimeToolCancelledError(
        callId,
        record.cancellation?.reason ?? 'session_closed',
        record.effectMayHaveCommitted,
      );
    },
    markEffectMayHaveCommitted() {
      record.effectMayHaveCommitted = true;
    },
    finish() {
      if (record.status === 'running') record.status = 'completed';
      trimExecutionRecords();
    },
  };
  return { status: 'started', execution };
}

export function cancelRealtimeToolExecution(
  event: JarvisLiveToolCancellationEvent,
): { known: boolean; effectMayHaveCommitted: boolean } {
  const key = executionKey(event.sessionId, event.callId);
  const existing = executions.get(key);
  if (existing) {
    existing.cancellation = event;
    existing.status = 'cancelled';
    if (!existing.controller.signal.aborted) existing.controller.abort(event);
    return {
      known: true,
      effectMayHaveCommitted: existing.effectMayHaveCommitted,
    };
  }

  const controller = new AbortController();
  controller.abort(event);
  executions.set(key, {
    controller,
    status: 'cancelled',
    effectMayHaveCommitted: false,
    cancellation: event,
  });
  trimExecutionRecords();
  return { known: false, effectMayHaveCommitted: false };
}

/** Test-only reset; runtime records intentionally survive React remounts. */
export function __resetRealtimeToolExecutions(): void {
  executions.clear();
}
