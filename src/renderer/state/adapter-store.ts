import { useEffect } from 'react';
import { create } from 'zustand';
import type { AdapterInfo } from '../../shared/adapter-types';

/**
 * Renderer mirror of the adapter registry (id/label/icon/models/authMethod).
 * Full configs never leave main — only the trimmed AdapterInfo crosses IPC.
 * Feeds the Orca-style provider rows (logo + usage) in the rail and the
 * unified ModelPicker. Hydration is best-effort: empty while main boots.
 */

interface AdapterStore {
  adapters: AdapterInfo[];
  hydrate(): Promise<void>;
  receive(list: AdapterInfo[]): void;
}

function adaptersApi() {
  return (globalThis as { nexus?: Window['nexus'] }).nexus?.adapters;
}

export const useAdapterStore = create<AdapterStore>((set) => ({
  adapters: [],

  hydrate: async () => {
    try {
      const api = adaptersApi();
      if (!api) return;
      set({ adapters: await api.list() });
    } catch (err) {
      console.warn('[adapters] hydrate failed:', err);
    }
  },

  receive: (list) => set({ adapters: list }),
}));

export function useAdapterController(): void {
  const hydrate = useAdapterStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    return adaptersApi()?.onChanged((list) =>
      useAdapterStore.getState().receive(list),
    );
  }, [hydrate]);
}
