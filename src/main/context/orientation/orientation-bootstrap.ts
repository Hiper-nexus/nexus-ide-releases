import { resolveProjectExecutionScopeCached } from '../../persistence/project-identity';
import {
  getProjectOrientationService,
  tryGetProjectOrientationService,
} from './orientation-service';

const headWatchTimers = new Map<string, ReturnType<typeof setInterval>>();
let activeWatchKey: string | null = null;

/**
 * Fire-and-forget orientation build after workspace open.
 * Never throws to the open path; never blocks the UI.
 * Also starts a light HEAD poll so branch switches refresh the map (P2).
 */
export function scheduleOrientationForWorkspace(workspacePath: string): void {
  const service = tryGetProjectOrientationService();
  if (!service) return;
  queueMicrotask(() => {
    try {
      const scope = resolveProjectExecutionScopeCached(workspacePath);
      void service.ensure(scope, { reason: 'workspace-open', waitMs: 0 }).catch((error) => {
        console.warn('[orientation] background ensure failed:', error);
      });
      startHeadWatch(scope.rootRealPath, scope.projectId, scope.checkoutId);
    } catch (error) {
      console.warn('[orientation] scope resolve failed on open:', error);
    }
  });
}

/** Stop HEAD polling when the active workspace is closed or switched. */
export function stopOrientationForWorkspace(): void {
  if (!activeWatchKey) {
    __clearOrientationHeadWatchesForTests();
    return;
  }
  const timer = headWatchTimers.get(activeWatchKey);
  if (timer) clearInterval(timer);
  headWatchTimers.delete(activeWatchKey);
  activeWatchKey = null;
}

function startHeadWatch(
  workspacePath: string,
  projectId: string,
  checkoutId: string,
): void {
  const key = `${projectId}\0${checkoutId}`;
  // One active watch per app session (current workspace). Drop previous.
  if (activeWatchKey && activeWatchKey !== key) {
    const previous = headWatchTimers.get(activeWatchKey);
    if (previous) clearInterval(previous);
    headWatchTimers.delete(activeWatchKey);
  }
  activeWatchKey = key;
  if (headWatchTimers.has(key)) return;
  const timer = setInterval(() => {
    const service = tryGetProjectOrientationService();
    if (!service) return;
    try {
      const scope = resolveProjectExecutionScopeCached(workspacePath);
      // ensure() invalidates when HEAD changes; no force rebuild on every tick.
      void service.ensure(scope, { reason: 'head-change', waitMs: 0 }).catch(() => undefined);
    } catch {
      // workspace may have moved
    }
  }, 60_000);
  // Do not keep the process alive solely for orientation watch.
  if (typeof timer.unref === 'function') timer.unref();
  headWatchTimers.set(key, timer);
}

/** Test helper */
export function __clearOrientationHeadWatchesForTests(): void {
  for (const timer of headWatchTimers.values()) clearInterval(timer);
  headWatchTimers.clear();
  activeWatchKey = null;
}

/**
 * Best-effort map markdown for kickoff. Waits briefly so a warm cache is used.
 */
export async function loadOrientationMarkdownForKickoff(
  workspacePath: string,
  waitMs = 3_000,
): Promise<string | null> {
  const service = tryGetProjectOrientationService();
  if (!service) return null;
  try {
    const scope = resolveProjectExecutionScopeCached(workspacePath);
    const map = await service.ensure(scope, {
      reason: 'pre-kickoff',
      waitMs,
    });
    return map.orientationMarkdown;
  } catch (error) {
    console.warn('[orientation] kickoff load failed:', error);
    return null;
  }
}

export async function ensureOrientationForScopePath(
  workspacePath: string,
  force = false,
) {
  const service = getProjectOrientationService();
  const scope = resolveProjectExecutionScopeCached(workspacePath);
  const map = await service.ensure(scope, {
    reason: force ? 'refresh' : 'mcp',
    force,
  });
  return service.toSnapshot(map);
}
