import { useEffect } from 'react';
import { create } from 'zustand';
import type { CostSnapshot } from '../../shared/cost-types';

/**
 * Renderer mirror of the main-process cost tracker (same pattern as
 * provider-store / account-store).
 *
 * TODO(orchestrator): `window.nexus.cost` does not exist yet — the preload
 * bridge is wired during integration. Until NexusApi grows a `cost` member,
 * we cast through the narrow CostApi shape below and no-op when absent, so
 * this file compiles and the app runs before the bridge lands.
 */

interface CostApi {
  snapshot(): Promise<CostSnapshot>;
  setCap(
    paneId: string,
    capUsd: number | null,
  ): Promise<{ ok: boolean; error?: string }>;
  onChanged(cb: (snapshot: CostSnapshot) => void): () => void;
}

function costApi(): CostApi | undefined {
  return (window.nexus as unknown as { cost?: CostApi }).cost;
}

export const EMPTY_COST_SNAPSHOT: CostSnapshot = {
  totalUsd: 0,
  perMinuteUsd: 0,
  tokPerSec: 0,
  panes: [],
};

interface CostStore {
  snapshot: CostSnapshot;
  hydrate(): Promise<void>;
  receive(snapshot: CostSnapshot): void;
  setCap(
    paneId: string,
    capUsd: number | null,
  ): Promise<{ ok: boolean; error?: string }>;
}

export const useCostStore = create<CostStore>((set) => ({
  snapshot: EMPTY_COST_SNAPSHOT,

  hydrate: async () => {
    const api = costApi();
    if (!api) return;
    try {
      set({ snapshot: await api.snapshot() });
    } catch (err) {
      console.warn('[cost] hydrate failed:', err);
    }
  },

  receive: (snapshot) => set({ snapshot }),

  setCap: async (paneId, capUsd) => {
    const api = costApi();
    if (!api) return { ok: false, error: 'cost bridge not wired' };
    return api.setCap(paneId, capUsd);
  },
}));

/** Mount once (e.g. in App) — hydrates and subscribes to change broadcasts. */
export function useCostController(): void {
  const hydrate = useCostStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    const api = costApi();
    if (!api) return undefined;
    return api.onChanged((snapshot) =>
      useCostStore.getState().receive(snapshot),
    );
  }, [hydrate]);
}
