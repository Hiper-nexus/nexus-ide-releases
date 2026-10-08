import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  AudioSettings,
  AudioSettingsPatch,
  TerminalSettings,
  TerminalSettingsPatch,
  UiSettings,
  UiSettingsPatch,
} from '../../shared/settings-types';
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_UI_SETTINGS,
} from '../../shared/settings-types';
import { applyTerminalSettings } from '../terminal/terminal-host';
import {
  applyPixelMode,
  applyUiTheme,
  resolveImportedTheme,
} from '../styles/ui-theme';
import { setAudioDevicePreferences } from '../voice/audio-device-preferences';

/**
 * One entry point: restyle terminals AND the whole app UI. The theme lives in
 * two halves — built-in id in `terminal`, imported VS Code theme in `ui` — so
 * either half changing re-resolves the pair.
 */
function applyEverywhere(settings: TerminalSettings, ui: UiSettings): void {
  const imported = resolveImportedTheme(ui);
  applyTerminalSettings(settings, imported?.terminal ?? null);
  applyUiTheme(settings.themeId, imported);
}

function applyUiEverywhere(settings: TerminalSettings, ui: UiSettings): void {
  applyEverywhere(settings, ui);
  applyPixelMode(ui.pixelMode);
}

function applyAudioEverywhere(audio: AudioSettings): void {
  setAudioDevicePreferences(audio);
}

function settingsApi() {
  return window.nexus.settings as typeof window.nexus.settings & {
    uiGet?: () => Promise<UiSettings>;
    uiSet?: (patch: UiSettingsPatch) => Promise<UiSettings>;
    onUiChanged?: (cb: (ui: UiSettings) => void) => () => void;
  };
}

/**
 * Renderer mirror of terminal, UI, and audio settings. Every change
 * round-trips through the main process (validate + persist + broadcast) and
 * is applied live.
 */

interface SettingsState {
  terminal: TerminalSettings;
  ui: UiSettings;
  audio: AudioSettings;
  hydrated: boolean;

  hydrate(): Promise<void>;
  update(patch: TerminalSettingsPatch): Promise<void>;
  updateUi(patch: UiSettingsPatch): Promise<void>;
  updateAudio(patch: AudioSettingsPatch): Promise<void>;
  receive(settings: TerminalSettings): void;
  receiveUi(ui: UiSettings): void;
  receiveAudio(audio: AudioSettings): void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  terminal: DEFAULT_TERMINAL_SETTINGS,
  ui: DEFAULT_UI_SETTINGS,
  audio: DEFAULT_AUDIO_SETTINGS,
  hydrated: false,

  hydrate: async () => {
    try {
      const api = settingsApi();
      const [settings, ui, audio] = await Promise.all([
        api.get(),
        api.uiGet ? api.uiGet() : Promise.resolve(DEFAULT_UI_SETTINGS),
        api.audioGet(),
      ]);
      applyUiEverywhere(settings, ui);
      applyAudioEverywhere(audio);
      set({ terminal: settings, ui, audio, hydrated: true });
    } catch (err) {
      console.warn('[settings] failed to hydrate:', err);
      set({ hydrated: true });
    }
  },

  update: async (patch) => {
    const settings = await window.nexus.settings.set(patch);
    applyEverywhere(settings, useSettingsStore.getState().ui);
    set({ terminal: settings });
  },

  updateUi: async (patch) => {
    const api = settingsApi();
    const ui = api.uiSet
      ? await api.uiSet(patch)
      : { ...useSettingsStore.getState().ui, ...patch };
    applyUiEverywhere(useSettingsStore.getState().terminal, ui);
    set({ ui });
  },

  updateAudio: async (patch) => {
    const audio = await settingsApi().audioSet(patch);
    applyAudioEverywhere(audio);
    set({ audio });
  },

  receive: (settings) => {
    applyEverywhere(settings, useSettingsStore.getState().ui);
    set({ terminal: settings });
  },

  receiveUi: (ui) => {
    applyUiEverywhere(useSettingsStore.getState().terminal, ui);
    set({ ui });
  },

  receiveAudio: (audio) => {
    applyAudioEverywhere(audio);
    set({ audio });
  },

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
    const unsubAudio = api.onAudioChanged((audio) =>
      useSettingsStore.getState().receiveAudio(audio),
    );
    return () => {
      unsubTerminal();
      unsubUi();
      unsubAudio();
    };
  }, [hydrate]);
}
