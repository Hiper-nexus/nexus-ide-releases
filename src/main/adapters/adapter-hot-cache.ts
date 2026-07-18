/**
 * Thunder-lite hot snapshot for adapter routing — short TTL cache so
 * route_task / scheduler do not re-probe install state every tick.
 * Pure helpers + process cache; invalidation from adapter-registry.
 */
import type { AdapterInfo } from '../../shared/types';

export interface AdapterHotSnapshot {
  at: number;
  adapters: AdapterInfo[];
}

const DEFAULT_TTL_MS = 5_000;

let snapshot: AdapterHotSnapshot | null = null;

export function invalidateAdapterHotCache(): void {
  snapshot = null;
}

export function getAdapterHotCache(): AdapterHotSnapshot | null {
  return snapshot;
}

/**
 * Return cached adapters if fresh; otherwise call `load` and store.
 */
export function loadAdaptersHot(
  load: () => AdapterInfo[],
  ttlMs = DEFAULT_TTL_MS,
  now: () => number = () => Date.now(),
): AdapterInfo[] {
  const t = now();
  if (snapshot && t - snapshot.at < ttlMs) {
    return snapshot.adapters;
  }
  const adapters = load();
  snapshot = { at: t, adapters };
  return adapters;
}
