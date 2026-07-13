/**
 * Local UI prefs for the Activity Rail: pinned mission ids (per workspace) +
 * collapsed sections. Pure module — storage injected for tests.
 */

export type RailSectionId = 'pinned' | 'active' | 'queue' | 'done';

/** @deprecated legacy flat list — migrated away; kept only for read fallback skip */
const PINS_KEY_LEGACY = 'nexus.activityRail.pins';
const PINS_BY_WORKSPACE_KEY = 'nexus.activityRail.pinsByWorkspace';
const COLLAPSED_KEY = 'nexus.activityRail.collapsed';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> & {
  removeItem?(key: string): void;
};

function storage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function readPinsMap(
  store: StorageLike | null,
): Record<string, string[]> {
  if (!store) return {};
  try {
    const raw = store.getItem(PINS_BY_WORKSPACE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [path, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof path !== 'string' || path.length === 0) continue;
      if (!Array.isArray(value)) continue;
      out[path] = value
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, 64);
    }
    return out;
  } catch {
    return {};
  }
}

function writePinsMap(
  map: Record<string, string[]>,
  store: StorageLike | null,
): void {
  if (!store) return;
  try {
    store.setItem(PINS_BY_WORKSPACE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota
  }
}

/**
 * Pins are scoped to the open workspace path so switching folders never
 * mixes another project's starred missions into the list.
 */
export function loadPinnedMissionIds(
  workspacePath: string | null | undefined,
  store: StorageLike | null = storage(),
): string[] {
  if (!workspacePath) return [];
  const map = readPinsMap(store);
  return map[workspacePath] ?? [];
}

export function savePinnedMissionIds(
  workspacePath: string | null | undefined,
  ids: string[],
  store: StorageLike | null = storage(),
): void {
  if (!workspacePath || !store) return;
  const map = readPinsMap(store);
  const next = ids
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .slice(0, 64);
  if (next.length === 0) {
    delete map[workspacePath];
  } else {
    map[workspacePath] = next;
  }
  writePinsMap(map, store);
  // Drop legacy global pin list so it cannot re-leak across workspaces.
  try {
    store.removeItem?.(PINS_KEY_LEGACY);
  } catch {
    // ignore
  }
}

export function togglePinnedMissionId(
  workspacePath: string | null | undefined,
  id: string,
  store: StorageLike | null = storage(),
): string[] {
  if (!workspacePath) return [];
  const current = loadPinnedMissionIds(workspacePath, store);
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : [id, ...current].slice(0, 64);
  savePinnedMissionIds(workspacePath, next, store);
  return next;
}

export function loadCollapsedSections(
  store: StorageLike | null = storage(),
): RailSectionId[] {
  if (!store) return ['done'];
  try {
    const raw = store.getItem(COLLAPSED_KEY);
    if (!raw) return ['done'];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ['done'];
    const allowed: RailSectionId[] = ['pinned', 'active', 'queue', 'done'];
    return parsed.filter((s): s is RailSectionId =>
      allowed.includes(s as RailSectionId),
    );
  } catch {
    return ['done'];
  }
}

export function saveCollapsedSections(
  sections: RailSectionId[],
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(COLLAPSED_KEY, JSON.stringify(sections));
  } catch {
    // ignore
  }
}
