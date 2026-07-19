/**
 * Local operator metrics for plan-lane adoption (no remote analytics).
 * Counts are best-effort and survive reloads via localStorage.
 */
import { create } from 'zustand';

const STORAGE_KEY = 'nexus.plan-lane-metrics.v1';

export interface PlanLaneMetrics {
  /** Missions observed with lane=plan while dispatched/running. */
  planDispatched: number;
  /** Operator promotePlanLane successes. */
  planPromoted: number;
  /** Handoffs while still in plan lane (design delivered). */
  planHandoffReady: number;
  updatedAt: number;
}

const EMPTY: PlanLaneMetrics = {
  planDispatched: 0,
  planPromoted: 0,
  planHandoffReady: 0,
  updatedAt: 0,
};

function load(): PlanLaneMetrics {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<PlanLaneMetrics>;
    return {
      planDispatched: Math.max(0, Number(parsed.planDispatched) || 0),
      planPromoted: Math.max(0, Number(parsed.planPromoted) || 0),
      planHandoffReady: Math.max(0, Number(parsed.planHandoffReady) || 0),
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

function persist(metrics: PlanLaneMetrics): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(metrics));
  } catch {
    // private mode / quota — metrics are optional
  }
}

interface PlanLaneMetricsStore extends PlanLaneMetrics {
  hydrate(): void;
  bump(key: 'planDispatched' | 'planPromoted' | 'planHandoffReady'): void;
  /** Short chip for MissionRail when any count > 0. */
  shortLabel(): string | null;
}

export const usePlanLaneMetricsStore = create<PlanLaneMetricsStore>((set, get) => ({
  ...EMPTY,
  hydrate: () => set(load()),
  bump: (key) => {
    const next = {
      ...get(),
      [key]: get()[key] + 1,
      updatedAt: Date.now(),
    };
    persist(next);
    set(next);
  },
  shortLabel: () => {
    const { planDispatched, planPromoted, planHandoffReady } = get();
    if (planDispatched + planPromoted + planHandoffReady === 0) return null;
    return `plan ${planDispatched}→${planPromoted} (h:${planHandoffReady})`;
  },
}));

export function bumpPlanLaneMetric(
  key: 'planDispatched' | 'planPromoted' | 'planHandoffReady',
): void {
  usePlanLaneMetricsStore.getState().bump(key);
}

/**
 * Pure: which plan missions newly appear as dispatched/running vs previous.
 */
export function newlyDispatchedPlanMissionIds(
  prev: ReadonlyMap<string, string | undefined>,
  next: readonly { id: string; status: string; lane?: string | null }[],
): string[] {
  const out: string[] = [];
  for (const m of next) {
    if (m.lane !== 'plan') continue;
    if (m.status !== 'running' && m.status !== 'pending') continue;
    const prevLane = prev.get(m.id);
    // Count once when first seen as plan, or when lane newly becomes plan.
    if (prevLane === undefined || prevLane !== 'plan') out.push(m.id);
  }
  return out;
}
