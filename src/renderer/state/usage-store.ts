import { useEffect } from 'react';
import { create } from 'zustand';
import type { UsageSnapshot } from '../../shared/usage-types';

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
};

interface UsageStore {
  snapshot: UsageSnapshot;
  hydrate(): Promise<void>;
  receive(snapshot: UsageSnapshot): void;
}

export const useUsageStore = create<UsageStore>((set) => ({
  snapshot: EMPTY_USAGE_SNAPSHOT,

  hydrate: async () => {
    const api = usageApi();
    if (!api) return;
    try {
      set({ snapshot: await api.snapshot() });
    } catch (err) {
      console.warn('[usage] hydrate failed:', err);
    }
  },

  receive: (snapshot) => set({ snapshot }),
}));

/** Montar uma vez (junto do useCostSync) — hydrate + subscribe. */
export function useUsageSync(): void {
  const hydrate = useUsageStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    const api = usageApi();
    if (!api) return;
    return api.onChanged((snapshot) => useUsageStore.getState().receive(snapshot));
  }, [hydrate]);
}
