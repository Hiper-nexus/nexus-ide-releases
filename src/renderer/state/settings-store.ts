import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  TerminalSettings,
  TerminalSettingsPatch,
  UiSettings,
  UiSettingsPatch,
} from '../../shared/settings-types';
import {
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_UI_SETTINGS,
} from '../../shared/settings-types';
import { applyTerminalSettings } from '../terminal/terminal-host';
import { applyPixelMode, applyUiTheme } from '../styles/ui-theme';

/** One entry point: restyle terminals AND the whole app UI. */
function applyEverywhere(settings: TerminalSettings): void {
  applyTerminalSettings(settings);
  applyUiTheme(settings.themeId);
}

function applyUiEverywhere(ui: UiSettings): void {
  applyPixelMode(ui.pixelMode);
}

/**
 * Renderer mirror of terminal + UI settings plus the settings-drawer open
 * state. Every change round-trips through the main process (validate +
 * persist + broadcast) and is applied live.
 */

interface SettingsState {
  terminal: TerminalSettings;
  ui: UiSettings;
  drawerOpen: boolean;
  hydrated: boolean;

  hydrate(): Promise<void>;
  update(patch: TerminalSettingsPatch): Promise<void>;
  updateUi(patch: UiSettingsPatch): Promise<void>;
  receive(settings: TerminalSettings): void;
  receiveUi(ui: UiSettings): void;
  toggleDrawer(): void;
  closeDrawer(): void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  terminal: DEFAULT_TERMINAL_SETTINGS,
  ui: DEFAULT_UI_SETTINGS,
  drawerOpen: false,
  hydrated: false,

  hydrate: async () => {
    try {
      const [settings, ui] = await Promise.all([
        window.nexus.settings.get(),
        window.nexus.settings.uiGet(),
      ]);
      applyEverywhere(settings);
      applyUiEverywhere(ui);
      set({ terminal: settings, ui, hydrated: true });
    } catch (err) {
      console.warn('[settings] failed to hydrate:', err);
      set({ hydrated: true });
    }
  },

  update: async (patch) => {
    const settings = await window.nexus.settings.set(patch);
    applyEverywhere(settings);
    set({ terminal: settings });
  },

  updateUi: async (patch) => {
    const ui = await window.nexus.settings.uiSet(patch);
    applyUiEverywhere(ui);
    set({ ui });
  },

  receive: (settings) => {
    applyEverywhere(settings);
    set({ terminal: settings });
  },

  receiveUi: (ui) => {
    applyUiEverywhere(ui);
    set({ ui });
  },

  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  closeDrawer: () => set({ drawerOpen: false }),
}));

/** Boot hook: hydrate once and follow main-process broadcasts. */
export function useSettingsController(): void {
  const hydrate = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
    const unsubTerminal = window.nexus.settings.onChanged((settings) =>
      useSettingsStore.getState().receive(settings),
    );
    const unsubUi = window.nexus.settings.onUiChanged((ui) =>
      useSettingsStore.getState().receiveUi(ui),
    );
    return () => {
      unsubTerminal();
      unsubUi();
    };
  }, [hydrate]);
}
