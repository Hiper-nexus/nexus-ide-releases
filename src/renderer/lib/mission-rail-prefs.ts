/**
 * Local UI prefs for the Activity Rail: pinned mission ids + collapsed sections.
 * Pure module — storage injected for tests.
 */

export type RailSectionId = 'pinned' | 'active' | 'queue' | 'done';

const PINS_KEY = 'nexus.activityRail.pins';
const COLLAPSED_KEY = 'nexus.activityRail.collapsed';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function loadPinnedMissionIds(store: StorageLike | null = storage()): string[] {
  if (!store) return [];
  try {
    const raw = store.getItem(PINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 64);
  } catch {
    return [];
  }
}

export function savePinnedMissionIds(
  ids: string[],
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(PINS_KEY, JSON.stringify(ids.slice(0, 64)));
  } catch {
    // ignore quota
  }
}

export function togglePinnedMissionId(
  id: string,
  store: StorageLike | null = storage(),
): string[] {
  const current = loadPinnedMissionIds(store);
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : [id, ...current].slice(0, 64);
  savePinnedMissionIds(next, store);
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
