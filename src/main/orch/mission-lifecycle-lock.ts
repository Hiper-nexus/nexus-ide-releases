import type { ProjectExecutionScope } from "../../shared/types";

const missionLifecycleTails = new Map<string, Promise<void>>();

/**
 * Canonical identity for one mission's physical lifecycle.
 *
 * `version` and `identitySource` describe how the scope was obtained; they do
 * not create a second checkout or a second mission authority.
 */
export function missionLifecycleKey(
  scope: Readonly<ProjectExecutionScope>,
  missionId: string,
): string {
  if (missionId.length === 0 || missionId.length > 256) {
    throw new Error("invalid mission lifecycle id");
  }
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    missionId,
  ].join("\0");
}

/**
 * The waiter gave up before the predecessor released the lock. The holder
 * and every later waiter are unaffected — this only means "busy right now",
 * which recovery maps to a retryable outcome instead of hanging forever.
 */
export class MissionLifecycleLockBusyError extends Error {
  constructor(missionId: string, timeoutMs: number) {
    super(
      `mission lifecycle lock busy for ${missionId} after ${timeoutMs}ms`,
    );
    this.name = "MissionLifecycleLockBusyError";
  }
}

/**
 * Main-owned mutex for physical mission lifecycle transitions.
 *
 * Teardown/delete and rearm/spawn must share this boundary. A store CAS still
 * protects against writers that do not participate in the mutex; the mutex
 * prevents a participating recovery flight from spawning after teardown but
 * before the mission row is deleted.
 *
 * `acquireTimeoutMs` bounds ONLY the wait for the predecessor. A waiter that
 * times out never runs `operation` and resolves its gate immediately, so the
 * current holder keeps running and later waiters still chain correctly.
 */
export async function withMissionLifecycleLock<T>(
  scope: Readonly<ProjectExecutionScope>,
  missionId: string,
  operation: () => Promise<T> | T,
  options: { readonly acquireTimeoutMs?: number } = {},
): Promise<T> {
  const key = missionLifecycleKey(scope, missionId);
  const predecessor = missionLifecycleTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.catch(() => undefined).then(() => gate);
  missionLifecycleTails.set(key, tail);

  const { acquireTimeoutMs } = options;
  if (typeof acquireTimeoutMs === "number" && acquireTimeoutMs >= 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new MissionLifecycleLockBusyError(missionId, acquireTimeoutMs)),
        acquireTimeoutMs,
      );
    });
    try {
      await Promise.race([predecessor.catch(() => undefined), timeout]);
    } catch (error) {
      clearTimeout(timer);
      // A dead waiter must not strand its successors behind an unresolved
      // gate; resolving it keeps the chain exactly as sound as before.
      release();
      throw error;
    }
    clearTimeout(timer);
  } else {
    await predecessor.catch(() => undefined);
  }
  try {
    return await operation();
  } finally {
    release();
    if (missionLifecycleTails.get(key) === tail) {
      missionLifecycleTails.delete(key);
    }
  }
}
