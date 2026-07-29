import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Main-owned liveness for worker transports that are not backed by a PTY
 * from non-PTY transports. Durable dispatch rows keep the opaque sessionId;
 * this registry only proves that the exact process incarnation is still live
 * in the current main process. It is intentionally empty after restart.
 */
export interface ExternalWorkerSessionInfo {
  readonly sessionId: string;
  readonly missionId: string;
  readonly workerIncarnationId?: string;
  readonly role: 'worker';
  readonly scope: Readonly<ProjectExecutionScope>;
}

const sessions = new Map<string, ExternalWorkerSessionInfo>();

export function registerExternalWorkerSession(input: {
  readonly sessionId: string;
  readonly missionId: string;
  readonly workerIncarnationId?: string;
  readonly scope: ProjectExecutionScope;
}): void {
  const existing = sessions.get(input.sessionId);
  if (existing) {
    throw new Error(`external worker session already registered: ${input.sessionId}`);
  }
  sessions.set(input.sessionId, {
    sessionId: input.sessionId,
    missionId: input.missionId,
    workerIncarnationId: input.workerIncarnationId,
    role: 'worker',
    scope: Object.freeze({ ...input.scope }),
  });
}

export function unregisterExternalWorkerSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function getExternalWorkerSessionInfo(
  sessionId: string,
): ExternalWorkerSessionInfo | null {
  return sessions.get(sessionId) ?? null;
}
