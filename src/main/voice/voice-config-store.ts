import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_VOICE,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_GEMINI_TTS,
  DEFAULT_OPENAI_VOICE,
  DEFAULT_XAI_STT,
  LEGACY_GEMINI_LIVE_MODEL,
  LEGACY_GEMINI_LIVE_VOICE,
  flattenJarvisBrainProviders,
  isWindowScopedShortcut,
  keyCodeFromAccelerator,
  normalizeKeyCode,
  promoteJarvisBrainProvider,
  voiceConfigSchema,
  legacyVoiceConfigSchema,
  migrateLegacyVoiceConfig,
  type JarvisBrainProvider,
  type VoiceConfig,
  type VoicePlugin,
} from '../../shared/voice-config';
import type {
  HotkeyMode,
  ResolvedChain,
  ResolvedProvider,
  VoiceApiKeyStatus,
  SetConfigRequest,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';
import {
  classifyKind,
  resolveChain,
  promoteProvider,
  flattenChain,
  relink,
  type ProviderProbes,
} from './provider-select';
import {
  hasStoredVoiceApiKey,
  hasVoiceCredential,
  isVoiceSecretStorageAvailable,
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

const VALID_JARVIS_LIVE_TRANSPORTS: ReadonlySet<string> = new Set([
  'classic',
  'grok-realtime',
  'openai-realtime',
  'gemini-live',
]);

/**
 * Validador do transporte Live. Durante a hibernação (2026-07-06) esta função
 * COAGIA gemini-live→classic, mantendo o realtime adormecido. A Decisão aprovada
 * (2026-07-08) reverteu isso: agora ela só VALIDA — um valor conhecido passa
 * intacto (realtime é entregue), e um valor inválido cai no default realtime. A
 * degradação para o Classic acontece em runtime (sem key / setup falho /
 * reconexão esgotada), não por coerção da config.
 */
function stableJarvisLiveTransport(
  transport: VoiceConfig['jarvisLive']['transport'],
): VoiceConfig['jarvisLive']['transport'] {
  return VALID_JARVIS_LIVE_TRANSPORTS.has(transport)
    ? transport
    : DEFAULT_VOICE_CONFIG.jarvisLive.transport;
}

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
    // Upgrade one-time: quem ficou no TTS low-latency (tts-1) ganha a voz
    // natural alinhada ao realtime sem perder customização de provider.
    if (
      userConfig.tts.provider === 'openai' &&
      userConfig.tts.model === 'tts-1'
    ) {
      userConfig.tts = {
        ...userConfig.tts,
        model: 'gpt-4o-mini-tts',
        voice: DEFAULT_OPENAI_VOICE,
      };
      migrated = true;
      console.log('[voice] TTS migrado para gpt-4o-mini-tts (qualidade)');
    }
    if (
      userConfig.tts.provider === 'openai' &&
      userConfig.tts.model === 'gpt-4o-mini-tts' &&
      (userConfig.tts.voice === 'nova' || userConfig.tts.voice === 'marin') &&
      (userConfig.jarvisLive.openaiVoice === 'marin' ||
        userConfig.jarvisLive.openaiVoice === DEFAULT_VOICE_CONFIG.jarvisLive.openaiVoice)
    ) {
      userConfig.tts = {
        ...userConfig.tts,
        voice: DEFAULT_OPENAI_VOICE,
      };
      if (
        userConfig.jarvisLive.openaiVoice === 'marin' ||
        userConfig.jarvisLive.openaiVoice === 'nova'
      ) {
        userConfig.jarvisLive = {
          ...userConfig.jarvisLive,
          openaiVoice: DEFAULT_VOICE_CONFIG.jarvisLive.openaiVoice,
        };
      }
      migrated = true;
      console.log('[voice] TTS/realtime alinhados para voz masculina (ash)');
    }
    // Saves antigos promoviam o fallback macos-say para o TOPO da chain — a
    // voz ficava robótica para sempre, mesmo com key OpenAI. Restaure a chain
    // natural (openai → piper → say).
    if (userConfig.tts.provider === 'macos-say') {
      userConfig.tts = DEFAULT_VOICE_CONFIG.tts;
      migrated = true;
      console.log('[voice] TTS destravado do macos-say → chain natural (openai→piper→say)');
    }
    // O Gemini 3.1 Live mudou o contrato de texto/eventos e é o modelo atual
    // de baixa latência. Migre apenas o identificador 2.5 oficial anterior;
    // modelos customizados do usuário permanecem intocados.
    if (userConfig.jarvisLive.liveModel === LEGACY_GEMINI_LIVE_MODEL) {
      userConfig.jarvisLive = {
        ...userConfig.jarvisLive,
        liveModel: DEFAULT_GEMINI_LIVE_MODEL,
      };
      migrated = true;
      console.log('[voice] Gemini Live migrado de 2.5 para 3.1 (baixa latência)');
    }
    // Gacrux era o default feminino anterior — migra para Charon (masculino).
    if (userConfig.jarvisLive.voiceName === LEGACY_GEMINI_LIVE_VOICE) {
      userConfig.jarvisLive = {
        ...userConfig.jarvisLive,
        voiceName: DEFAULT_GEMINI_LIVE_VOICE,
      };
      migrated = true;
      console.log('[voice] voz Gemini Live migrada para Charon (masculina)');
    }
    // O Gemini 3.5 Transcribe passa a liderar a cadeia de STT (transcrição
    // literal, mais fiel que a tradução do Whisper). Sem esta migração o
    // provedor NÃO apareceria no seletor: as opções do dropdown derivam de
    // `info.stt.chain`, que vem desta config persistida, e `promoteProvider` é
    // no-op para provider que não é link da cadeia.
    //
    // SÓ instala em quem ainda está na cadeia PADRÃO (head groq, endpoint da
    // Groq). Um head trocado é escolha deliberada — `docs/voice.md` documenta
    // exatamente isso para quem quer offline/privacidade — e promover o Gemini
    // por cima mandaria o áudio dessa pessoa para o Google sem ela ter pedido:
    // uma chave Gemini costuma existir de qualquer forma, já que ele é o brain
    // padrão. "Gemini está ausente" não é o mesmo que "esta é a cadeia de
    // fábrica", e era só isso que a guarda antiga checava.
    const onShippedSttChain =
      userConfig.stt.provider === 'groq' &&
      (userConfig.stt.endpoint ?? '').includes('api.groq.com');
    if (
      onShippedSttChain &&
      !flattenChain(userConfig.stt).some((link) => link.provider === 'gemini')
    ) {
      // `outputMode` (e o `translate` que anda junto) são lidos SÓ do head —
      // é ali que mora a intenção CODE/CHAT do usuário. Herdar os defaults do
      // Gemini apagaria a escolha dele, e como o arquivo é reescrito logo
      // abaixo a perda seria permanente. A cadeia antiga vira FALLBACK, então
      // nada do que ele tinha abaixo é perdido ou reordenado.
      const keptOutputMode =
        userConfig.stt.outputMode ?? DEFAULT_VOICE_CONFIG.stt.outputMode;
      userConfig.stt = {
        ...DEFAULT_VOICE_CONFIG.stt,
        outputMode: keptOutputMode,
        translate: keptOutputMode === 'english',
        fallback: userConfig.stt,
      };
      migrated = true;
      console.log('[voice] STT: Gemini 3.5 Transcribe adicionado à cabeça da cadeia');
    }
    // O Grok Voice Transcribe 2.0 (xAI) entra logo após o ÚLTIMO link cloud
    // da cadeia persistida — nunca no head (a preferência do usuário manda) e
    // nunca em cadeias só-locais (offline/privacidade é escolha deliberada).
    // As opções do seletor derivam da cadeia persistida: um link fora dela
    // não pode ser escolhido — adicioná-lo não é promovê-lo.
    const sttLinks = flattenChain(userConfig.stt);
    const lastCloudIdx = sttLinks.reduce(
      (acc, link, i) => (classifyKind(link) === 'cloud' ? i : acc),
      -1,
    );
    if (
      lastCloudIdx >= 0 &&
      !sttLinks.some((link) => link.provider === 'xai')
    ) {
      userConfig.stt = relink([
        ...sttLinks.slice(0, lastCloudIdx + 1),
        DEFAULT_XAI_STT,
        ...sttLinks.slice(lastCloudIdx + 1),
      ]);
      migrated = true;
      console.log('[voice] STT: Grok Voice Transcribe 2.0 (xAI) adicionado à cadeia (seletor)');
    }
    // Gemini 3.8 Flash-Lite TTS (GA 22/09/2026) vira a voz padrão da Jarvis.
    // Mesma política do STT: só assume a cabeça de quem está na cadeia de
    // FÁBRICA (head OpenAI); cadeia trocada ganha o Gemini como opção depois do
    // último link cloud, e cadeia só-local não recebe nada (privacidade).
    const ttsLinks = flattenChain(userConfig.tts);
    if (!ttsLinks.some((link) => link.provider === 'gemini')) {
      const onShippedTtsChain =
        userConfig.tts.provider === 'openai' &&
        (userConfig.tts.endpoint ?? '').includes('api.openai.com');
      const lastCloudTtsIdx = ttsLinks.reduce(
        (acc, link, i) => (classifyKind(link) === 'cloud' ? i : acc),
        -1,
      );
      if (onShippedTtsChain) {
        userConfig.tts = { ...DEFAULT_GEMINI_TTS, fallback: userConfig.tts };
        migrated = true;
        console.log('[voice] TTS: Gemini 3.8 Flash-Lite na cabeça da cadeia');
      } else if (lastCloudTtsIdx >= 0) {
        userConfig.tts = relink([
          ...ttsLinks.slice(0, lastCloudTtsIdx + 1),
          DEFAULT_GEMINI_TTS,
          ...ttsLinks.slice(lastCloudTtsIdx + 1),
        ]);
        migrated = true;
        console.log('[voice] TTS: Gemini 3.8 Flash-Lite adicionado à cadeia (seletor)');
      }
    }
    // Keep focused-pane when the user (or peer ADE migration) chose dictation
    // into the active terminal — do not force Jarvis over NexusVoice-style PTT.
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
  if (patch.dictationOutputMode) {
    // O modo é autoridade da CONFIG; o request de ditado também o envia
    // explícito por turno, para valer em qualquer engine da cadeia/fallback.
    stt = {
      ...stt,
      outputMode: patch.dictationOutputMode,
      translate: patch.dictationOutputMode === 'english',
    };
  }
  let tts = current.tts;
  let jarvisBrain = current.jarvisBrain;
  if (patch.sttProvider) stt = promoteProvider(stt, patch.sttProvider);
  if (patch.ttsProvider) tts = promoteProvider(tts, patch.ttsProvider);
  if (patch.jarvisBrainProvider) {
    jarvisBrain = promoteJarvisBrainProvider(
      jarvisBrain,
      patch.jarvisBrainProvider,
    );
  }
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
      transport: stableJarvisLiveTransport(
        patch.jarvisLiveTransport ?? current.jarvisLive.transport,
      ),
      openaiModel: patch.jarvisLiveOpenaiModel ?? current.jarvisLive.openaiModel,
      openaiVoice: patch.jarvisLiveOpenaiVoice ?? current.jarvisLive.openaiVoice,
      voiceName: patch.jarvisLiveGeminiVoice ?? current.jarvisLive.voiceName,
    },
    persona: {
      assistantName:
        patch.personaAssistantName ?? current.persona.assistantName,
      userName:
        patch.personaUserName !== undefined
          ? patch.personaUserName || undefined
          : current.persona.userName,
      customInstructions:
        patch.personaCustomInstructions !== undefined
          ? patch.personaCustomInstructions || undefined
          : current.persona.customInstructions,
    },
    jarvisBrain,
    input: {
      ...current.input,
      shortcut,
      pushToTalkKey: { code: pushToTalkKeyCode },
    },
    stt,
    // Voz e modelo valem para a CABEÇA da cadeia; modelo Gemini só quando é
    // o Gemini que lidera (um id Gemini no OpenAI quebraria a fala).
    tts: {
      ...tts,
      ...(patch.ttsVoice ? { voice: patch.ttsVoice } : {}),
      ...(patch.ttsModel && tts.provider === 'gemini' ? { model: patch.ttsModel } : {}),
    },
  };

  current = next;
  persist(next);
  return next;
}

type SecretBearingProvider = {
  provider: string;
  auth?: { type?: 'api_key' | 'bearer' | 'none'; envVar?: string };
  fallback?: SecretBearingProvider;
};

function flattenSecretProviders(head: SecretBearingProvider): SecretBearingProvider[] {
  const out: SecretBearingProvider[] = [];
  let node: SecretBearingProvider | undefined = head;
  let guard = 0;
  while (node && guard < 32) {
    out.push(node);
    node = node.fallback;
    guard += 1;
  }
  return out;
}

function collectVoiceEnvVars(
  ...heads: Array<VoicePlugin | JarvisBrainProvider>
): VoiceApiKeyStatus[] {
  const byEnv = new Map<string, Set<string>>();
  for (const head of heads) {
    for (const plugin of flattenSecretProviders(head)) {
      const authType = plugin.auth?.type ?? 'api_key';
      const envVar = plugin.auth?.envVar;
      if (authType === 'none' || !envVar) continue;
      const providers = byEnv.get(envVar) ?? new Set<string>();
      providers.add(plugin.provider);
      byEnv.set(envVar, providers);
    }
  }
  // Call once — isSecureStorageAvailable may touch OS backends.
  const secureStorageAvailable = isVoiceSecretStorageAvailable();
  return [...byEnv.entries()].map(([envVar, providers]) => {
    // hasStoredKey must NOT decrypt (Keychain). Mask is presence-only on the
    // status snapshot — never call maskedVoiceApiKey here (it decrypts every key).
    const hasStored = hasStoredVoiceApiKey(envVar);
    return {
      envVar,
      providers: [...providers],
      hasEnv: typeof process.env[envVar] === 'string' && process.env[envVar]!.trim().length > 0,
      hasStoredKey: hasStored,
      keyMasked: hasStored ? '••••' : null,
      secureStorageAvailable,
    };
  });
}

/**
 * ITEM 5: the realtime transport authenticates with XAI_API_KEY (grok-realtime),
 * GEMINI_API_KEY (gemini-live) or OPENAI_API_KEY (openai-realtime) — keys the
 * STT/TTS/brain chains may not reference. Surfacing them as synthetic providers
 * guarantees a settings field (and a valid store target) for each, so the user
 * can paste the key that the engage gate then resolves, even on a config that
 * dropped the matching brain.
 *
 * A rota oficial precisa aparecer aqui PRIMEIRO: sem este campo o operador não
 * teria onde colar a chave da xAI e o Grok degradaria em silêncio para Gemini.
 */
const REALTIME_KEY_PROVIDERS: VoicePlugin[] = [
  { type: 'stt', provider: 'grok-realtime', auth: { type: 'api_key', envVar: 'XAI_API_KEY' } },
  { type: 'stt', provider: 'gemini-live', auth: { type: 'api_key', envVar: 'GEMINI_API_KEY' } },
  { type: 'stt', provider: 'openai-realtime', auth: { type: 'api_key', envVar: 'OPENAI_API_KEY' } },
];

function voiceKeyStatuses(): VoiceApiKeyStatus[] {
  return collectVoiceEnvVars(
    current.stt,
    current.tts,
    current.jarvisBrain,
    ...REALTIME_KEY_PROVIDERS,
  );
}

export function knownVoiceEnvVars(): Set<string> {
  return new Set(voiceKeyStatuses().map((key) => key.envVar));
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

function resolveJarvisBrainChain(head: JarvisBrainProvider): ResolvedChain {
  const links: ResolvedProvider[] = flattenJarvisBrainProviders(head).map((provider) => {
    const envVar = provider.auth.envVar;
    const available =
      provider.auth.type === 'none' || (envVar ? hasEnv(envVar) : false);
    return {
      provider: provider.provider,
      kind: 'cloud',
      available,
      model: provider.model,
      reason: available ? `ready (${envVar ?? 'no auth'})` : `${envVar ?? 'key'} not set`,
    };
  });
  const active = links.find((link) => link.available) ?? null;
  return { active, chain: links };
}

/** Build the secret-free snapshot for the renderer. */
export function buildRuntimeInfo(): VoiceRuntimeInfo {
  const probes = currentProbes();
  const pushToTalkKeyCode =
    current.input.pushToTalkKey?.code ?? keyCodeFromAccelerator(current.input.shortcut);
  const shortcut = current.input.shortcut;
  return {
    enabled: current.enabled,
    routing: current.routing,
    speakMode: current.speakMode,
    shortcut,
    pushToTalkKeyCode,
    hotkeyMode,
    hotkeyScope: isWindowScopedShortcut(shortcut) ? 'window' : 'global',
    wakeWordEnabled: current.wakeWord.enabled,
    dictationOutputMode:
      current.stt.outputMode === 'portuguese' ? 'portuguese' : 'english',
    jarvisLive: {
      enabled: current.jarvisLive.enabled,
      transport: current.jarvisLive.transport,
      openaiModel: current.jarvisLive.openaiModel,
      openaiVoice: current.jarvisLive.openaiVoice,
      voiceName: current.jarvisLive.voiceName,
      graceReuseMs: current.jarvisLive.graceReuseMs,
      dormantAfterMs: current.jarvisLive.dormantAfterMs,
      maxWindowTurns: current.jarvisLive.maxWindowTurns,
    },
    persona: {
      assistantName: current.persona.assistantName,
      userName: current.persona.userName,
      customInstructions: current.persona.customInstructions,
    },
    jarvisBrain: resolveJarvisBrainChain(current.jarvisBrain),
    // openWakeWord roda local e sem key — o campo fica por compat de UI.
    hasWakeKey: true,
    keys: voiceKeyStatuses(),
    stt: resolveChain(current.stt, probes),
    tts: resolveChain(current.tts, probes),
    ttsVoice: current.tts.voice,
    ttsProvider: current.tts.provider,
    ttsModel: current.tts.model,
  };
}
