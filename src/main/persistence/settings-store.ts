import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { handleTrusted } from '../security/trusted-ipc';
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_INTEGRATIONS_SETTINGS,
  DEFAULT_ORCH_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_UI_SETTINGS,
  DEFAULT_VISION_SETTINGS,
  SETTINGS_CHANNELS,
  audioSettingsPatchSchema,
  audioSettingsSchema,
  integrationsSettingsSchema,
  orchSettingsSchema,
  terminalSettingsPatchSchema,
  terminalSettingsSchema,
  uiSettingsPatchSchema,
  uiSettingsSchema,
  visionSettingsSchema,
  type AudioSettings,
  type IntegrationsSettings,
  type OrchSettings,
  type TerminalSettings,
  type UiSettings,
  type VisionSettings,
} from '../../shared/settings-types';
import {
  listAvailableShells,
  resolveConfiguredShell,
} from './shell-catalog';
import { setRuntimeOutputDeviceId } from '../voice/audio-output-runtime';
import { writeJsonFileAtomic } from './atomic-json-file';

/**
 * Terminal settings store: ~/.nexus/settings.json (same user-dir convention
 * as the voice config). Invalid or missing files fall back to defaults —
 * settings must never block the terminal from opening.
 */

const SETTINGS_FILE = path.join(os.homedir(), '.nexus', 'settings.json');

let current: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;
let orchSettings: OrchSettings = DEFAULT_ORCH_SETTINGS;
let audioSettings: AudioSettings = DEFAULT_AUDIO_SETTINGS;
let visionSettings: VisionSettings = DEFAULT_VISION_SETTINGS;
let uiSettings: UiSettings = DEFAULT_UI_SETTINGS;
let integrationsSettings: IntegrationsSettings = DEFAULT_INTEGRATIONS_SETTINGS;
const listeners = new Set<WebContents>();
const audioListeners = new Set<WebContents>();
const uiListeners = new Set<WebContents>();

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const parsed = terminalSettingsSchema.safeParse(raw?.terminal ?? raw);
    if (parsed.success) {
      try {
        if (parsed.data.shell) {
          resolveConfiguredShell(
            parsed.data.shell,
            parsed.data.shell,
            listAvailableShells(),
          );
        }
        current = parsed.data;
      } catch {
        current = { ...parsed.data, shell: '' };
      }
    }
    const orchParsed = orchSettingsSchema.safeParse(raw?.orch ?? {});
    if (orchParsed.success) orchSettings = orchParsed.data;
    const audioParsed = audioSettingsSchema.safeParse(raw?.audio ?? {});
    if (audioParsed.success) {
      audioSettings = audioParsed.data;
      setRuntimeOutputDeviceId(audioSettings.outputDeviceId);
    }
    const visionParsed = visionSettingsSchema.safeParse(raw?.vision ?? {});
    if (visionParsed.success) visionSettings = visionParsed.data;
    const uiParsed = uiSettingsSchema.safeParse(raw?.ui ?? {});
    if (uiParsed.success) uiSettings = uiParsed.data;
    const integrationsParsed = integrationsSettingsSchema.safeParse(
      raw?.integrations ?? {},
    );
    if (integrationsParsed.success) integrationsSettings = integrationsParsed.data;
  } catch {
    // Missing/corrupt file — keep defaults.
  }
}

interface SettingsSnapshot {
  terminal: TerminalSettings;
  orch: OrchSettings;
  audio: AudioSettings;
  vision: VisionSettings;
  ui: UiSettings;
  integrations: IntegrationsSettings;
}

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    terminal: current,
    orch: orchSettings,
    audio: audioSettings,
    vision: visionSettings,
    ui: uiSettings,
    integrations: integrationsSettings,
    ...overrides,
  };
}

function persist(next = snapshot()): void {
  try {
    writeJsonFileAtomic(SETTINGS_FILE, next);
  } catch (error) {
    console.error('[settings] failed to persist settings atomically:', error);
    throw new Error('Não foi possível salvar as configurações do Nexus.', {
      cause: error,
    });
  }
}

function broadcast(): void {
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(SETTINGS_CHANNELS.changed, current);
  }
}

function broadcastUi(): void {
  for (const wc of uiListeners) {
    if (!wc.isDestroyed()) wc.send(SETTINGS_CHANNELS.uiChanged, uiSettings);
  }
}

function broadcastAudio(): void {
  for (const wc of audioListeners) {
    if (!wc.isDestroyed()) wc.send(SETTINGS_CHANNELS.audioChanged, audioSettings);
  }
}

export function getTerminalSettings(): TerminalSettings {
  return current;
}

export function getOrchSettings(): OrchSettings {
  return orchSettings;
}

export function getAudioSettings(): AudioSettings {
  return audioSettings;
}

export function getVisionSettings(): VisionSettings {
  return visionSettings;
}

export function getUiSettings(): UiSettings {
  return uiSettings;
}

export function getIntegrationsSettings(): IntegrationsSettings {
  return integrationsSettings;
}

export function setVisionSettingsPatch(
  patch: Partial<VisionSettings>,
): VisionSettings {
  const parsed = visionSettingsSchema.safeParse({
    ...visionSettings,
    ...patch,
  });
  if (parsed.success) {
    persist(snapshot({ vision: parsed.data }));
    visionSettings = parsed.data;
  }
  return visionSettings;
}

export function registerSettingsListener(wc: WebContents): void {
  listeners.add(wc);
  audioListeners.add(wc);
  uiListeners.add(wc);
}

export function unregisterSettingsListener(wc: WebContents): void {
  listeners.delete(wc);
  audioListeners.delete(wc);
  uiListeners.delete(wc);
}

export function registerSettingsIpc(): void {
  load();

  ipcMain.handle(SETTINGS_CHANNELS.get, () => current);

  handleTrusted(SETTINGS_CHANNELS.set, (_event, raw) => {
    const parsed = terminalSettingsPatchSchema.safeParse(raw);
    if (!parsed.success) return current;
    const next = { ...current, ...parsed.data };
    if (next.shell) {
      try {
        resolveConfiguredShell(next.shell, next.shell, listAvailableShells());
      } catch {
        return current;
      }
    }
    persist(snapshot({ terminal: next }));
    current = next;
    broadcast();
    return current;
  });

  ipcMain.handle(SETTINGS_CHANNELS.orchGet, () => orchSettings);

  handleTrusted(SETTINGS_CHANNELS.orchSet, (_event, raw) => {
    const parsed = orchSettingsSchema.safeParse({ ...orchSettings, ...(raw ?? {}) });
    if (parsed.success) {
      persist(snapshot({ orch: parsed.data }));
      orchSettings = parsed.data;
    }
    return orchSettings;
  });

  ipcMain.handle(SETTINGS_CHANNELS.audioGet, () => audioSettings);

  handleTrusted(SETTINGS_CHANNELS.audioSet, (_event, raw) => {
    const parsed = audioSettingsPatchSchema.safeParse(raw);
    if (!parsed.success) return audioSettings;
    const next = { ...audioSettings, ...parsed.data };
    persist(snapshot({ audio: next }));
    audioSettings = next;
    setRuntimeOutputDeviceId(next.outputDeviceId);
    broadcastAudio();
    return audioSettings;
  });

  ipcMain.handle(SETTINGS_CHANNELS.shellsList, () => listAvailableShells());

  ipcMain.handle(SETTINGS_CHANNELS.uiGet, () => uiSettings);

  handleTrusted(SETTINGS_CHANNELS.uiSet, (_event, raw) => {
    const parsed = uiSettingsPatchSchema.safeParse(raw);
    if (!parsed.success) return uiSettings;
    const next = { ...uiSettings, ...parsed.data };
    persist(snapshot({ ui: next }));
    uiSettings = next;
    broadcastUi();
    return uiSettings;
  });
}
