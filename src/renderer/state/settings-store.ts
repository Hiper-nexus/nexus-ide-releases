import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  TerminalSettings,
  TerminalSettingsPatch,
} from '../../shared/settings-types';
import { DEFAULT_TERMINAL_SETTINGS } from '../../shared/settings-types';
import { applyTerminalSettings } from '../terminal/terminal-host';

/**
 * Renderer mirror of the terminal settings plus the settings-drawer open
 * state. Every change round-trips through the main process (validate +
 * persist + broadcast) and is applied live to the open terminals.
 */

interface SettingsState {
  terminal: TerminalSettings;
  drawerOpen: boolean;
  hydrated: boolean;

  hydrate(): Promise<void>;
  update(patch: TerminalSettingsPatch): Promise<void>;
  receive(settings: TerminalSettings): void;
  toggleDrawer(): void;
  closeDrawer(): void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  terminal: DEFAULT_TERMINAL_SETTINGS,
  drawerOpen: false,
  hydrated: false,

  hydrate: async () => {
    try {
      const settings = await window.nexus.settings.get();
      applyTerminalSettings(settings);
      set({ terminal: settings, hydrated: true });
    } catch (err) {
      console.warn('[settings] failed to hydrate:', err);
      set({ hydrated: true });
    }
  },

  update: async (patch) => {
    const settings = await window.nexus.settings.set(patch);
    applyTerminalSettings(settings);
    set({ terminal: settings });
  },

  receive: (settings) => {
    applyTerminalSettings(settings);
    set({ terminal: settings });
  },

  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  closeDrawer: () => set({ drawerOpen: false }),
}));

/** Boot hook: hydrate once and follow main-process broadcasts. */
export function useSettingsController(): void {
  const hydrate = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    return window.nexus.settings.onChanged((settings) =>
      useSettingsStore.getState().receive(settings),
    );
  }, [hydrate]);
}
