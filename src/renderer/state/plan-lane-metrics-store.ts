/**
 * Local operator metrics for plan-lane adoption (no remote analytics).
 * Counts + seen-id sets survive reloads so rehydrate never double-counts
 * or re-toasts old plan handoffs.
 */
import { create } from 'zustand';

const STORAGE_KEY = 'nexus.plan-lane-metrics.v1';
const MAX_SEEN_IDS = 400;

export interface PlanLaneMetrics {
  /** Unique plan missions counted (first time seen as plan). */
  planDispatched: number;
  /** Operator promotePlanLane successes. */
  planPromoted: number;
  /** Unique plan-lane handoffs that triggered "ready" UX. */
  planHandoffReady: number;
  updatedAt: number;
  /** Mission ids already counted as planDispatched. */
  seenPlanMissionIds: string[];
  /** Handoff ids already toasted / counted as planHandoffReady. */
  seenPlanHandoffIds: string[];
}

const EMPTY: PlanLaneMetrics = {
  planDispatched: 0,
  planPromoted: 0,
  planHandoffReady: 0,
  updatedAt: 0,
  seenPlanMissionIds: [],
  seenPlanHandoffIds: [],
};

function load(): PlanLaneMetrics {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY, seenPlanMissionIds: [], seenPlanHandoffIds: [] };
    const parsed = JSON.parse(raw) as Partial<PlanLaneMetrics>;
    return {
      planDispatched: Math.max(0, Number(parsed.planDispatched) || 0),
      planPromoted: Math.max(0, Number(parsed.planPromoted) || 0),
      planHandoffReady: Math.max(0, Number(parsed.planHandoffReady) || 0),
      updatedAt: Number(parsed.updatedAt) || 0,
      seenPlanMissionIds: Array.isArray(parsed.seenPlanMissionIds)
        ? parsed.seenPlanMissionIds.map(String).slice(-MAX_SEEN_IDS)
        : [],
      seenPlanHandoffIds: Array.isArray(parsed.seenPlanHandoffIds)
        ? parsed.seenPlanHandoffIds.map(String).slice(-MAX_SEEN_IDS)
        : [],
    };
  } catch {
    return { ...EMPTY, seenPlanMissionIds: [], seenPlanHandoffIds: [] };
  }
}

function persist(metrics: PlanLaneMetrics): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(metrics));
  } catch {
    // private mode / quota — metrics are optional
  }
}

function pushSeen(list: string[], id: string): string[] {
  if (list.includes(id)) return list;
  const next = [...list, id];
  return next.length > MAX_SEEN_IDS ? next.slice(-MAX_SEEN_IDS) : next;
}

interface PlanLaneMetricsStore extends PlanLaneMetrics {
  hydrate(): void;
  /** @returns true if this was a first-time count */
  notePlanDispatched(missionId: string): boolean;
  notePlanPromoted(): void;
  /** @returns true if this handoff id was new (should toast) */
  notePlanHandoffReady(handoffId: string): boolean;
}

export const usePlanLaneMetricsStore = create<PlanLaneMetricsStore>((set, get) => ({
  ...EMPTY,
  seenPlanMissionIds: [],
  seenPlanHandoffIds: [],
  hydrate: () => set(load()),
  notePlanDispatched: (missionId) => {
    const state = get();
    if (!missionId || state.seenPlanMissionIds.includes(missionId)) return false;
    const next: PlanLaneMetrics = {
      ...state,
      planDispatched: state.planDispatched + 1,
      seenPlanMissionIds: pushSeen(state.seenPlanMissionIds, missionId),
      updatedAt: Date.now(),
    };
    persist(next);
    set(next);
    return true;
  },
  notePlanPromoted: () => {
    const state = get();
    const next: PlanLaneMetrics = {
      ...state,
      planPromoted: state.planPromoted + 1,
      updatedAt: Date.now(),
    };
    persist(next);
    set(next);
  },
  notePlanHandoffReady: (handoffId) => {
    const state = get();
    if (!handoffId || state.seenPlanHandoffIds.includes(handoffId)) return false;
    const next: PlanLaneMetrics = {
      ...state,
      planHandoffReady: state.planHandoffReady + 1,
      seenPlanHandoffIds: pushSeen(state.seenPlanHandoffIds, handoffId),
      updatedAt: Date.now(),
    };
    persist(next);
    set(next);
    return true;
  },
}));

/** @deprecated prefer notePlanDispatched / notePlanPromoted / notePlanHandoffReady */
export function bumpPlanLaneMetric(
  key: 'planDispatched' | 'planPromoted' | 'planHandoffReady',
): void {
  const s = usePlanLaneMetricsStore.getState();
  if (key === 'planPromoted') s.notePlanPromoted();
  // other keys require ids — no-op legacy callers without id
}

/**
 * Pure: which plan missions newly appear as plan vs previous snapshot.
 * Does not consult localStorage — callers still dedupe with notePlanDispatched.
 */
export function newlyDispatchedPlanMissionIds(
  prev: ReadonlyMap<string, string | undefined>,
  next: readonly { id: string; status: string; lane?: string | null }[],
): string[] {
  const out: string[] = [];
  // Full rehydrate from empty store: do not treat every plan mission as new.
  if (prev.size === 0) return out;
  for (const m of next) {
    if (m.lane !== 'plan') continue;
    if (m.status !== 'running' && m.status !== 'pending') continue;
    const prevLane = prev.get(m.id);
    if (prevLane === undefined || prevLane !== 'plan') out.push(m.id);
  }
  return out;
}
