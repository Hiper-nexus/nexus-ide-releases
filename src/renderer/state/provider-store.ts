import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  ProviderConfigPatch,
  ProviderSettingsInfo,
} from '../../shared/provider-settings-types';

/**
 * Renderer mirror of the provider settings hub (CLIs/providers config + key
 * presence). Keys themselves never reach the renderer — only masked previews.
 */

interface ProviderStore {
  providers: ProviderSettingsInfo[];
  hydrate(): Promise<void>;
  receive(list: ProviderSettingsInfo[]): void;
  setConfig(patch: ProviderConfigPatch): Promise<void>;
  setKey(adapterId: string, key: string): Promise<{ ok: boolean; error?: string }>;
  testKey(adapterId: string): Promise<{ ok: boolean; detail: string }>;
}

export const useProviderStore = create<ProviderStore>((set) => ({
  providers: [],

  hydrate: async () => {
    try {
      set({ providers: await window.nexus.providers.list() });
    } catch (err) {
      console.warn('[providers] hydrate failed:', err);
    }
  },

  receive: (list) => set({ providers: list }),

  setConfig: async (patch) => {
    const list = await window.nexus.providers.setConfig(patch);
    set({ providers: list });
  },

  setKey: async (adapterId, key) => {
    const result = await window.nexus.providers.setKey({ adapterId, key });
    set({ providers: await window.nexus.providers.list() });
    return result;
  },

  testKey: (adapterId) => window.nexus.providers.testKey(adapterId),
}));

export function useProviderController(): void {
  const hydrate = useProviderStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    return window.nexus.providers.onChanged((list) =>
      useProviderStore.getState().receive(list),
    );
  }, [hydrate]);
}
