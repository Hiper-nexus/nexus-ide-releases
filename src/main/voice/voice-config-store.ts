import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_VOICE_CONFIG,
  voiceConfigSchema,
  clockVoiceConfigSchema,
  migrateClockVoiceConfig,
  type VoiceConfig,
} from '../../shared/voice-config';
import type {
  HotkeyMode,
  SetConfigRequest,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';
import { resolveChain, promoteProvider, type ProviderProbes } from './provider-select';

/**
 * Owns the live voice config: loads user JSON / migrates a ClockVoice
 * audio-config on boot, applies settings patches, and builds the secret-free
 * runtime snapshot the renderer consumes. Secrets (API keys) are read from
 * `process.env` HERE, in main, and never placed on the snapshot.
 */

const NEXUS_DIR = path.join(os.homedir(), '.nexus');
const USER_VOICE_DIR = path.join(NEXUS_DIR, 'plugins', 'voice');
const USER_VOICE_FILE = path.join(USER_VOICE_DIR, 'nexus-voice.json');

// Where a migratable ClockVoice audio-config may live (Overclock or Nexus dir).
const CLOCKVOICE_CANDIDATES = [
  path.join(NEXUS_DIR, 'audio-config.json'),
  path.join(os.homedir(), '.overclock-app', 'audio-config.json'),
];

let current: VoiceConfig = DEFAULT_VOICE_CONFIG;
let hotkeyMode: HotkeyMode = 'toggle';

/** Env var present and non-empty. */
function hasEnv(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

/** Binary resolvable: absolute path exists+executable, or found on PATH. */
function hasBin(binOrPath: string): boolean {
  if (path.isAbsolute(binOrPath)) {
    try {
      fs.accessSync(binOrPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(lookup, [binOrPath], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function currentProbes(): ProviderProbes {
  return { hasEnv, hasBin, platform: process.platform };
}

function readUserConfig(): VoiceConfig | null {
  if (fs.existsSync(USER_VOICE_FILE)) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(USER_VOICE_FILE, 'utf-8'));
      const parsed = voiceConfigSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      console.error(
        '[voice-config] invalid nexus-voice.json:',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    } catch (err) {
      console.error('[voice-config] failed to read nexus-voice.json:', err);
    }
  }
  return null;
}

function readClockVoiceConfig(): VoiceConfig | null {
  for (const file of CLOCKVOICE_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const parsed = clockVoiceConfigSchema.safeParse(raw);
      if (parsed.success) {
        console.log(`[voice-config] migrated ClockVoice config from ${file}`);
        return migrateClockVoiceConfig(parsed.data);
      }
    } catch (err) {
      console.error(`[voice-config] failed to migrate ${file}:`, err);
    }
  }
  return null;
}

/** Load config: user JSON wins, else a migrated ClockVoice config, else defaults. */
export function loadVoiceConfig(): VoiceConfig {
  try {
    fs.mkdirSync(USER_VOICE_DIR, { recursive: true });
  } catch {
    // Non-fatal; we can still run off in-memory defaults.
  }
  const userConfig = readUserConfig();
  if (userConfig) {
    current = userConfig;
    return current;
  }

  const migrated = readClockVoiceConfig();
  if (migrated) {
    current = migrated;
    // Materialize the migrated config to the editable user file so we don't
    // re-derive it from the ClockVoice source on every boot. Idempotent.
    persist(migrated);
    return current;
  }

  current = DEFAULT_VOICE_CONFIG;
  return current;
}

export function getVoiceConfig(): VoiceConfig {
  return current;
}

export function setHotkeyMode(mode: HotkeyMode): void {
  hotkeyMode = mode;
}

/** Apply a settings patch, persist, and return the updated config. */
export function applyConfigPatch(patch: SetConfigRequest): VoiceConfig {
  let stt = current.stt;
  let tts = current.tts;
  if (patch.sttProvider) stt = promoteProvider(stt, patch.sttProvider);
  if (patch.ttsProvider) tts = promoteProvider(tts, patch.ttsProvider);

  const next: VoiceConfig = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    routing: patch.routing ?? current.routing,
    speakMode: patch.speakMode ?? current.speakMode,
    input: {
      ...current.input,
      shortcut: patch.shortcut ?? current.input.shortcut,
    },
    stt,
    tts,
  };

  current = next;
  persist(next);
  return next;
}

function persist(config: VoiceConfig): void {
  try {
    fs.mkdirSync(USER_VOICE_DIR, { recursive: true });
    fs.writeFileSync(USER_VOICE_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[voice-config] failed to persist config:', err);
  }
}

/** Build the secret-free snapshot for the renderer. */
export function buildRuntimeInfo(): VoiceRuntimeInfo {
  const probes = currentProbes();
  return {
    enabled: current.enabled,
    routing: current.routing,
    speakMode: current.speakMode,
    shortcut: current.input.shortcut,
    hotkeyMode,
    stt: resolveChain(current.stt, probes),
    tts: resolveChain(current.tts, probes),
  };
}
