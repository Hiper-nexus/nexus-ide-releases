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

function settingsApi() {
  return window.nexus.settings as typeof window.nexus.settings & {
    uiGet?: () => Promise<UiSettings>;
    uiSet?: (patch: UiSettingsPatch) => Promise<UiSettings>;
    onUiChanged?: (cb: (ui: UiSettings) => void) => () => void;
  };
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
      const api = settingsApi();
      const [settings, ui] = await Promise.all([
        api.get(),
        api.uiGet ? api.uiGet() : Promise.resolve(DEFAULT_UI_SETTINGS),
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
    const api = settingsApi();
    const ui = api.uiSet
      ? await api.uiSet(patch)
      : { ...useSettingsStore.getState().ui, ...patch };
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
    const api = settingsApi();
    const unsubTerminal = api.onChanged((settings) =>
      useSettingsStore.getState().receive(settings),
    );
    const unsubUi = api.onUiChanged
      ? api.onUiChanged((ui) => useSettingsStore.getState().receiveUi(ui))
      : () => {};
    return () => {
      unsubTerminal();
      unsubUi();
    };
  }, [hydrate]);
}
