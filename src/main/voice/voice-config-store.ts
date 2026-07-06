import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_VOICE_CONFIG,
  keyCodeFromAccelerator,
  normalizeKeyCode,
  voiceConfigSchema,
  legacyVoiceConfigSchema,
  migrateLegacyVoiceConfig,
  type VoiceConfig,
  type VoicePlugin,
} from '../../shared/voice-config';
import type {
  HotkeyMode,
  VoiceApiKeyStatus,
  SetConfigRequest,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';
import {
  flattenChain,
  resolveChain,
  promoteProvider,
  type ProviderProbes,
} from './provider-select';
import {
  hasStoredVoiceApiKey,
  hasVoiceCredential,
  isVoiceSecretStorageAvailable,
  maskedVoiceApiKey,
  setVoiceApiKey,
} from './voice-secrets';

/**
 * Owns the live voice config: loads user JSON / migrates a legacy
 * audio-config on boot, applies settings patches, and builds the secret-free
 * runtime snapshot the renderer consumes. Secrets (API keys) are read from
 * `process.env` HERE, in main, and never placed on the snapshot.
 */

const NEXUS_DIR = path.join(os.homedir(), '.nexus');
const USER_VOICE_DIR = path.join(NEXUS_DIR, 'plugins', 'voice');
const USER_VOICE_FILE = path.join(USER_VOICE_DIR, 'nexus-voice.json');

// Where a migratable audio-config may live (Nexus dir).
const LEGACY_VOICE_CANDIDATES = [
  path.join(NEXUS_DIR, 'audio-config.json'),
];

let current: VoiceConfig = DEFAULT_VOICE_CONFIG;
let hotkeyMode: HotkeyMode = 'toggle';

/** Env var present and non-empty. */
function hasEnv(name: string): boolean {
  return hasVoiceCredential(name);
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

function readLegacyVoiceConfig(): VoiceConfig | null {
  for (const file of LEGACY_VOICE_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const parsed = legacyVoiceConfigSchema.safeParse(raw);
      if (parsed.success) {
        console.log(`[voice-config] migrated legacy voice config from ${file}`);
        return migrateLegacyVoiceConfig(parsed.data);
      }
    } catch (err) {
      console.error(`[voice-config] failed to migrate ${file}:`, err);
    }
  }
  return null;
}

/** Load config: user JSON wins, else a migrated legacy config, else defaults. */
export function loadVoiceConfig(): VoiceConfig {
  try {
    fs.mkdirSync(USER_VOICE_DIR, { recursive: true });
  } catch {
    // Non-fatal; we can still run off in-memory defaults.
  }
  const userConfig = readUserConfig();
  if (userConfig) {
    let migrated = false;
    // Upgrade one-time: quem ficou nos defaults antigos de TTS (tts-1/onyx)
    // ganha a voz natural nova (gpt-4o-mini-tts/nova) sem perder customização.
    if (
      userConfig.tts.provider === 'openai' &&
      ((userConfig.tts.model === 'tts-1' && userConfig.tts.voice === 'onyx') ||
        // gpt-4o-mini-tts media 1.3s/frase — tts-1 é o modelo low-latency.
        userConfig.tts.model === 'gpt-4o-mini-tts')
    ) {
      userConfig.tts = {
        ...userConfig.tts,
        model: 'tts-1',
        voice: 'nova',
      };
      migrated = true;
      console.log('[voice] TTS migrado para tts-1 (latência)');
    }
    // Saves antigos promoviam o fallback macos-say para o TOPO da chain — a
    // voz ficava robótica para sempre, mesmo com key OpenAI. Restaure a chain
    // natural (openai → piper → say).
    if (userConfig.tts.provider === 'macos-say') {
      userConfig.tts = DEFAULT_VOICE_CONFIG.tts;
      migrated = true;
      console.log('[voice] TTS destravado do macos-say → chain natural (openai→piper→say)');
    }
    // A JARVIS conversacional virou o modo padrão do produto.
    if (userConfig.routing === 'focused-pane') {
      userConfig.routing = 'jarvis';
      migrated = true;
      console.log('[voice] routing migrado para o modo JARVIS (assistente)');
    }
    if (migrated) persist(userConfig);
    current = userConfig;
    return current;
  }

  const migrated = readLegacyVoiceConfig();
  if (migrated) {
    current = migrated;
    // Materialize the migrated config to the editable user file so we don't
    // re-derive it from the legacy source on every boot. Idempotent.
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
  const shortcut = patch.shortcut ?? current.input.shortcut;
  const pushToTalkKeyCode = normalizeKeyCode(
    patch.pushToTalkKeyCode ?? keyCodeFromAccelerator(shortcut),
  );

  const next: VoiceConfig = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    routing: patch.routing ?? current.routing,
    speakMode: patch.speakMode ?? current.speakMode,
    wakeWord: {
      enabled: patch.wakeWordEnabled ?? current.wakeWord.enabled,
    },
    jarvisLive: {
      ...current.jarvisLive,
      enabled: patch.jarvisLiveEnabled ?? current.jarvisLive.enabled,
    },
    input: {
      ...current.input,
      shortcut,
      pushToTalkKey: { code: pushToTalkKeyCode },
    },
    stt,
    tts,
  };

  current = next;
  persist(next);
  return next;
}

function collectVoiceEnvVars(...heads: VoicePlugin[]): VoiceApiKeyStatus[] {
  const byEnv = new Map<string, Set<string>>();
  for (const head of heads) {
    for (const plugin of flattenChain(head)) {
      const authType = plugin.auth?.type ?? 'api_key';
      const envVar = plugin.auth?.envVar;
      if (authType === 'none' || !envVar) continue;
      const providers = byEnv.get(envVar) ?? new Set<string>();
      providers.add(plugin.provider);
      byEnv.set(envVar, providers);
    }
  }
  return [...byEnv.entries()].map(([envVar, providers]) => ({
    envVar,
    providers: [...providers],
    hasEnv: typeof process.env[envVar] === 'string' && process.env[envVar]!.trim().length > 0,
    hasStoredKey: hasStoredVoiceApiKey(envVar),
    keyMasked: maskedVoiceApiKey(envVar),
    secureStorageAvailable: isVoiceSecretStorageAvailable(),
  }));
}

export function knownVoiceEnvVars(): Set<string> {
  return new Set(collectVoiceEnvVars(current.stt, current.tts).map((key) => key.envVar));
}

export function storeVoiceApiKey(
  envVar: string,
  key: string,
): { ok: boolean; error?: string } {
  if (!knownVoiceEnvVars().has(envVar)) {
    return { ok: false, error: `Unsupported voice key: ${envVar}` };
  }
  return setVoiceApiKey(envVar, key);
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
  const pushToTalkKeyCode =
    current.input.pushToTalkKey?.code ?? keyCodeFromAccelerator(current.input.shortcut);
  return {
    enabled: current.enabled,
    routing: current.routing,
    speakMode: current.speakMode,
    shortcut: current.input.shortcut,
    pushToTalkKeyCode,
    hotkeyMode,
    wakeWordEnabled: current.wakeWord.enabled,
    jarvisLive: {
      enabled: current.jarvisLive.enabled,
      graceReuseMs: current.jarvisLive.graceReuseMs,
      dormantAfterMs: current.jarvisLive.dormantAfterMs,
      maxWindowTurns: current.jarvisLive.maxWindowTurns,
    },
    // openWakeWord roda local e sem key — o campo fica por compat de UI.
    hasWakeKey: true,
    keys: collectVoiceEnvVars(current.stt, current.tts),
    stt: resolveChain(current.stt, probes),
    tts: resolveChain(current.tts, probes),
  };
}
