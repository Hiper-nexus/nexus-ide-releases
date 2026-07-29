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
 * Main-owned mutex for physical mission lifecycle transitions.
 *
 * Teardown/delete and rearm/spawn must share this boundary. A store CAS still
 * protects against writers that do not participate in the mutex; the mutex
 * prevents a participating recovery flight from spawning after teardown but
 * before the mission row is deleted.
 */
export async function withMissionLifecycleLock<T>(
  scope: Readonly<ProjectExecutionScope>,
  missionId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const key = missionLifecycleKey(scope, missionId);
  const predecessor = missionLifecycleTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.catch(() => undefined).then(() => gate);
  missionLifecycleTails.set(key, tail);

  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (missionLifecycleTails.get(key) === tail) {
      missionLifecycleTails.delete(key);
    }
  }
}
