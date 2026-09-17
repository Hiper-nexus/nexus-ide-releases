import { useEffect } from "react";
import { create } from "zustand";
import {
  EMPTY_TOKEN_SPEED_SNAPSHOT,
  type TokenSpeedSnapshot,
} from "../../shared/token-speed-types";
import { getActiveWorkspacePath } from "./active-workspace";
import { useWorkspaceStore } from "./workspace-store";

/**
 * Espelho no renderer do cronômetro de geração do Main (mesmo padrão do
 * cost-store). A ponte real é `window.nexus.tokenSpeed`; o optional-chain só
 * cobre preload velho em dev/hot-reload, que aparece como estado vazio
 * explícito em vez de um no-op silencioso.
 */

function tokenSpeedApi() {
  return window.nexus?.tokenSpeed;
}

interface TokenSpeedStore {
  snapshot: TokenSpeedSnapshot;
  hydrate(workspacePath: string): Promise<void>;
  receive(snapshot: TokenSpeedSnapshot): void;
  reset(): void;
}

export const useTokenSpeedStore = create<TokenSpeedStore>((set) => ({
  snapshot: EMPTY_TOKEN_SPEED_SNAPSHOT,

  hydrate: async (workspacePath) => {
    if (getActiveWorkspacePath() !== workspacePath) return;
    const api = tokenSpeedApi();
    if (!api) return;
    try {
      const snapshot = await api.snapshot();
      if (getActiveWorkspacePath() === workspacePath && snapshot) {
        set({ snapshot });
      }
    } catch (err) {
      if (getActiveWorkspacePath() === workspacePath) {
        console.warn("[token-speed] hydrate failed:", err);
      }
    }
  },

  receive: (snapshot) => set({ snapshot }),
  reset: () => set({ snapshot: EMPTY_TOKEN_SPEED_SNAPSHOT }),
}));

/** Monte uma vez — reidrata por workspace autorizado e mantém um listener. */
export function useTokenSpeedController(): void {
  const hydrate = useTokenSpeedStore((s) => s.hydrate);
  const reset = useTokenSpeedStore((s) => s.reset);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);
  useEffect(() => {
    reset();
    if (workspaceHydrated && workspacePath) void hydrate(workspacePath);
  }, [hydrate, reset, workspaceHydrated, workspacePath]);

  useEffect(() => {
    const api = tokenSpeedApi();
    if (!api) return undefined;
    return api.onChanged((snapshot) => {
      if (getActiveWorkspacePath()) {
        useTokenSpeedStore.getState().receive(snapshot);
      }
    });
  }, []);
}
