import { useEffect } from 'react';
import { create } from 'zustand';
import type { UsageSnapshot } from '../../shared/usage-types';
import { getActiveWorkspacePath } from './active-workspace';
import { useWorkspaceStore } from './workspace-store';

/**
 * Espelho no renderer da telemetria REAL de tokens (usage-service no main).
 * Mesmo padrão do cost-store: pull na montagem + push via broadcast. Quando um
 * pane tem dados aqui, a UI mostra custo `real` em vez da estimativa por bytes.
 */

interface UsageApi {
  snapshot(): Promise<UsageSnapshot>;
  onChanged(cb: (snapshot: UsageSnapshot) => void): () => void;
}

function usageApi(): UsageApi | undefined {
  return (window.nexus as unknown as { usage?: UsageApi }).usage;
}

export const EMPTY_USAGE_SNAPSHOT: UsageSnapshot = {
  byPane: {},
  global: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
  media: { generations: 0, costUsd: 0 },
};

interface UsageStore {
  snapshot: UsageSnapshot;
  hydrate(workspacePath: string): Promise<void>;
  receive(snapshot: UsageSnapshot): void;
  reset(): void;
}

export const useUsageStore = create<UsageStore>((set) => ({
  snapshot: EMPTY_USAGE_SNAPSHOT,

  hydrate: async (workspacePath) => {
    if (getActiveWorkspacePath() !== workspacePath) return;
    const api = usageApi();
    if (!api) return;
    try {
      const snapshot = await api.snapshot();
      if (getActiveWorkspacePath() === workspacePath) set({ snapshot });
    } catch (err) {
      if (getActiveWorkspacePath() === workspacePath) {
        console.warn('[usage] hydrate failed:', err);
      }
    }
  },

  receive: (snapshot) => set({ snapshot }),
  reset: () => set({ snapshot: EMPTY_USAGE_SNAPSHOT }),
}));

/** Mount once — rehydrates per authorized workspace and keeps one listener. */
export function useUsageSync(): void {
  const hydrate = useUsageStore((s) => s.hydrate);
  const reset = useUsageStore((s) => s.reset);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const workspacePath = useWorkspaceStore((s) => s.current?.path ?? null);
  useEffect(() => {
    reset();
    if (workspaceHydrated && workspacePath) void hydrate(workspacePath);
  }, [hydrate, reset, workspaceHydrated, workspacePath]);

  useEffect(() => {
    const api = usageApi();
    if (!api) return;
    return api.onChanged((snapshot) => {
      if (getActiveWorkspacePath()) useUsageStore.getState().receive(snapshot);
    });
  }, []);
}
