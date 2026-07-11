/**
 * Pinned workspace paths for the Activity Rail (local UI prefs).
 */

const KEY = 'nexus.activityRail.workspacePins';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function loadPinnedWorkspacePaths(store: StorageLike | null = storage()): string[] {
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .slice(0, 24);
  } catch {
    return [];
  }
}

export function savePinnedWorkspacePaths(
  paths: string[],
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(paths.slice(0, 24)));
  } catch {
    // ignore
  }
}

export function togglePinnedWorkspacePath(
  path: string,
  store: StorageLike | null = storage(),
): string[] {
  const current = loadPinnedWorkspacePaths(store);
  const next = current.includes(path)
    ? current.filter((p) => p !== path)
    : [path, ...current].slice(0, 24);
  savePinnedWorkspacePaths(next, store);
  return next;
}
