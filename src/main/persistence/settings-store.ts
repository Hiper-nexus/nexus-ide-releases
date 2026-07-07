import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  DEFAULT_ORCH_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_VISION_SETTINGS,
  SETTINGS_CHANNELS,
  orchSettingsSchema,
  terminalSettingsPatchSchema,
  terminalSettingsSchema,
  visionSettingsSchema,
  type OrchSettings,
  type TerminalSettings,
  type VisionSettings,
} from '../../shared/settings-types';

/**
 * Terminal settings store: ~/.nexus/settings.json (same user-dir convention
 * as the voice config). Invalid or missing files fall back to defaults —
 * settings must never block the terminal from opening.
 */

const SETTINGS_FILE = path.join(os.homedir(), '.nexus', 'settings.json');

let current: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;
let orchSettings: OrchSettings = DEFAULT_ORCH_SETTINGS;
let visionSettings: VisionSettings = DEFAULT_VISION_SETTINGS;
const listeners = new Set<WebContents>();

function load(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const parsed = terminalSettingsSchema.safeParse(raw?.terminal ?? raw);
    if (parsed.success) current = parsed.data;
    const orchParsed = orchSettingsSchema.safeParse(raw?.orch ?? {});
    if (orchParsed.success) orchSettings = orchParsed.data;
    const visionParsed = visionSettingsSchema.safeParse(raw?.vision ?? {});
    if (visionParsed.success) visionSettings = visionParsed.data;
  } catch {
    // Missing/corrupt file — keep defaults.
  }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify(
        { terminal: current, orch: orchSettings, vision: visionSettings },
        null,
        2,
      ),
    );
  } catch (err) {
    console.warn('[settings] failed to persist settings:', err);
  }
}

function broadcast(): void {
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(SETTINGS_CHANNELS.changed, current);
  }
}

export function getTerminalSettings(): TerminalSettings {
  return current;
}

export function getOrchSettings(): OrchSettings {
  return orchSettings;
}

export function getVisionSettings(): VisionSettings {
  return visionSettings;
}

export function setVisionSettingsPatch(
  patch: Partial<VisionSettings>,
): VisionSettings {
  const parsed = visionSettingsSchema.safeParse({
    ...visionSettings,
    ...patch,
  });
  if (parsed.success) {
    visionSettings = parsed.data;
    persist();
  }
  return visionSettings;
}

export function registerSettingsListener(wc: WebContents): void {
  listeners.add(wc);
}

export function unregisterSettingsListener(wc: WebContents): void {
  listeners.delete(wc);
}

export function registerSettingsIpc(): void {
  load();

  ipcMain.handle(SETTINGS_CHANNELS.get, () => current);

  ipcMain.handle(SETTINGS_CHANNELS.set, (_event, raw) => {
    const parsed = terminalSettingsPatchSchema.safeParse(raw);
    if (!parsed.success) return current;
    current = { ...current, ...parsed.data };
    persist();
    broadcast();
    return current;
  });

  ipcMain.handle(SETTINGS_CHANNELS.orchGet, () => orchSettings);

  ipcMain.handle(SETTINGS_CHANNELS.orchSet, (_event, raw) => {
    const parsed = orchSettingsSchema.safeParse({ ...orchSettings, ...(raw ?? {}) });
    if (parsed.success) {
      orchSettings = parsed.data;
      persist();
    }
    return orchSettings;
  });
}
