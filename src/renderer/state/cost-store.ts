import { useEffect } from "react";
import { create } from "zustand";
import type { CostSnapshot } from "../../shared/cost-types";
import { getActiveWorkspacePath } from "./active-workspace";
import { useWorkspaceStore } from "./workspace-store";

/**
 * Renderer mirror of the main-process cost tracker (same pattern as
 * provider-store / account-store). The preload bridge (`window.nexus.cost`)
 * is the real integration; the optional-chain guard only covers a stale
 * preload in dev/hot-reload, which surfaces as the explicit unavailable
 * state below instead of a silent no-op.
 */

function costApi() {
  return window.nexus?.cost;
}

export const EMPTY_COST_SNAPSHOT: CostSnapshot = {
  totalUsd: 0,
  perMinuteUsd: 0,
  tokPerSec: 0,
  panes: [],
};

interface CostStore {
  snapshot: CostSnapshot;
  hydrate(workspacePath: string): Promise<void>;
  receive(snapshot: CostSnapshot): void;
  reset(): void;
  setCap(
    paneId: string,
    capUsd: number | null,
  ): Promise<{ ok: boolean; error?: string }>;
}

export const useCostStore = create<CostStore>((set) => ({
  snapshot: EMPTY_COST_SNAPSHOT,

  hydrate: async (workspacePath) => {
    if (getActiveWorkspacePath() !== workspacePath) return;
    const api = costApi();
    if (!api) return;
    try {
      const snapshot = await api.snapshot();
      if (getActiveWorkspacePath() === workspacePath) set({ snapshot });
    } catch (err) {
      if (getActiveWorkspacePath() === workspacePath) {
        console.warn("[cost] hydrate failed:", err);
      }
    }
  },

  receive: (snapshot) => set({ snapshot }),
  reset: () => set({ snapshot: EMPTY_COST_SNAPSHOT }),

  setCap: async (paneId, capUsd) => {
    const api = costApi();
    if (!api) return { ok: false, error: "cost bridge not wired" };
    return api.setCap(paneId, capUsd);
  },
}));

/** Mount once — rehydrates per authorized workspace and keeps one listener. */
export function useCostController(): void {
  const hydrate = useCostStore((s) => s.hydrate);
  const reset = useCostStore((s) => s.reset);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);
  useEffect(() => {
    reset();
    if (workspaceHydrated && workspacePath) void hydrate(workspacePath);
  }, [hydrate, reset, workspaceHydrated, workspacePath]);

  useEffect(() => {
    const api = costApi();
    if (!api) return undefined;
    return api.onChanged((snapshot) => {
      if (getActiveWorkspacePath()) useCostStore.getState().receive(snapshot);
    });
  }, []);
}
