import { useEffect, useRef, useState } from 'react';
import { useVoiceStore } from '../voice/voice-store';
import {
  clearEphemeralDraft,
  peekEphemeralDraft,
  saveEphemeralDraft,
} from '../state/ephemeral-draft-store';
import {
  accelFromCode,
  dictationEnPresetPatch,
  normalizeKeyCode,
  GEMINI_LIVE_VOICE_OPTIONS,
  OPENAI_REALTIME_VOICE_OPTIONS,
  OPENAI_TTS_VOICE_OPTIONS,
} from '../../shared/voice-config';
import type { JarvisLiveTransport } from '../../shared/voice-config';
import { credentialLinkForEnv } from '../../shared/credential-links';
import { openExternalFromAnchor } from '../lib/open-external';
import { CloseButton } from './CloseButton';
import { PixelIcon } from './PixelIcon';
import { playSpeakResult } from '../voice/voice-playback';
import type { JarvisRequest } from '../../shared/voice-ipc';
import {
  keyPlaceholder,
  keyStatusText,
  liveSmokeFailureMessage,
  providerOption,
} from './voice-settings-helpers';
import { createDraftHydrationBarrier } from '../lib/ui-overlay-policy';
import { isMac } from '../lib/platform';

type RealtimeTransport = Exclude<JarvisLiveTransport, 'classic'>;

/** Rota oficial da voz do produto (ver voice-config.ts). */
const DEFAULT_REALTIME_TRANSPORT: RealtimeTransport = 'grok-realtime';

const REALTIME_TRANSPORT_LABEL: Record<RealtimeTransport, string> = {
  'grok-realtime': 'Grok Voice',
  'gemini-live': 'Gemini Live',
  'openai-realtime': 'OpenAI Realtime',
};

type VoiceSettingsTab =
  | 'canal'
  | 'live'
  | 'voz'
  | 'atendimento'
  | 'fallback'
  | 'persona'
  | 'credenciais';

/** Session-only pocket for soft-close recovery (may include unsaved key fields). */
type VoiceSettingsDraft = {
  sttProvider: string;
  ttsProvider: string;
  jarvisBrainProvider: string;
  speakMode: string;
  routing: string;
  triggerKey: string;
  triggerAccel: string;
  wakeWordOn: boolean;
  jarvisLiveOn: boolean;
  liveRealtime: boolean;
  realtimeTransport: RealtimeTransport;
  assistantName: string;
  userName: string;
  customInstructions: string;
  openaiVoice: string;
  geminiVoice: string;
  ttsVoice: string;
  keyInputs: Record<string, string>;
  activeTab: VoiceSettingsTab;
};

const VOICE_TABS: Array<{
  id: VoiceSettingsTab;
  label: string;
  hint: string;
  icon: 'mic' | 'bolt' | 'sparkle' | 'users' | 'restart' | 'id-badge' | 'key';
}> = [
  { id: 'canal', label: 'Canal', hint: 'Estado e rota', icon: 'mic' },
  { id: 'live', label: 'Live', hint: 'Wake e realtime', icon: 'bolt' },
  { id: 'voz', label: 'Voz', hint: 'Timbre e fallbacks', icon: 'sparkle' },
  { id: 'atendimento', label: 'Atendimento', hint: 'Fala e atalho', icon: 'users' },
  { id: 'fallback', label: 'Fallback', hint: 'STT · TTS · cérebro', icon: 'restart' },
  { id: 'persona', label: 'Persona', hint: 'Nome e estilo', icon: 'id-badge' },
  { id: 'credenciais', label: 'Credenciais', hint: 'Chaves no cofre', icon: 'key' },
];

/**
 * Painel Jarvis: layout em abas (status → live → voz → operação → keys).
 * Inclui smoke tests de TTS/Live e persistência de keys + config.
 */

/**
 * Map a physical KeyboardEvent to a config key code. Strict on purpose:
 * letters, digits, F-keys and Space only — punctuation varies wildly across
 * layouts (ABNT2!) and bare modifiers are not a key. Returns null for
 * anything unsupported so the capture keeps listening.
 */
function codeFromKeyboardEvent(e: KeyboardEvent): string | null {
  const c = e.code;
  if (!c) return null;
  const letter = /^Key([A-Z])$/.exec(c);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(c);
  if (digit) return digit[1];
  if (/^F\d{1,2}$/.test(c)) return c;
  if (c === 'Space') return 'Space';
  return null;
}

/**
 * Turn the EXACT pressed combo into an Electron accelerator. Safety rails:
 * F-keys and bare Space may be window-scoped (NexusVoice-style); any other key
 * needs ⌘/⌃/⌥ — otherwise pressing it in a terminal would both type AND
 * trigger voice. Returns null (with a hint) while the combo is unsafe.
 */
function comboFromKeyboardEvent(
  e: KeyboardEvent,
): { accel: string; key: string } | { hint: string } | null {
  const key = codeFromKeyboardEvent(e);
  if (!key) return null;
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const isFKey = /^F\d{1,2}$/.test(key);
  const hasStrongMod = e.metaKey || e.ctrlKey || e.altKey;
  // Bare Space = window-scoped PTT (peer ADE NexusVoice). Never OS-global.
  if (key === 'Space' && !hasStrongMod && !e.shiftKey) {
    return { accel: 'Space', key: 'Space' };
  }
  if (!isFKey && !hasStrongMod) {
    return {
      hint: isMac()
        ? 'Combine com ⌘, ⌃ ou ⌥ (ex.: ⌘⇧Space), use Space sozinha (ditado na janela), ou uma tecla F (ex.: F6).'
        : 'Combine com Ctrl ou Alt (ex.: Ctrl+Shift+Space), use Space sozinha (ditado na janela), ou uma tecla F (ex.: F6).',
    };
  }
  return { accel: [...mods, key].join('+'), key };
}

export function VoiceSettings() {
  const draftHydrationBarrier = useRef(createDraftHydrationBarrier()).current;
  const open = useVoiceStore((s) => s.settingsOpen);
  const info = useVoiceStore((s) => s.info);
  const liveState = useVoiceStore((s) => s.liveState);
  const transcriptAppend = useVoiceStore((s) => s.transcriptAppend);
  const close = useVoiceStore((s) => s.closeSettings);
  const setInfo = useVoiceStore((s) => s.setInfo);
  const hudMode = useVoiceStore((s) => s.hud.mode);
  const setHudMode = useVoiceStore((s) => s.setHudMode);

  const [sttProvider, setSttProvider] = useState('');
  const [ttsProvider, setTtsProvider] = useState('');
  const [jarvisBrainProvider, setJarvisBrainProvider] = useState('');
  const [speakMode, setSpeakMode] = useState('summary');
  const [dictationMode, setDictationMode] = useState<'english' | 'portuguese'>('english');
  const [routing, setRouting] = useState('focused-pane');
  const [triggerKey, setTriggerKey] = useState('Space');
  const [wakeWordOn, setWakeWordOn] = useState(false);
  const [jarvisLiveOn, setJarvisLiveOn] = useState(false);
  const [liveRealtime, setLiveRealtime] = useState(false);
  const [realtimeTransport, setRealtimeTransport] =
    useState<RealtimeTransport>(DEFAULT_REALTIME_TRANSPORT);
  const [assistantName, setAssistantName] = useState('Jarvis');
  const [userName, setUserName] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [openaiVoice, setOpenaiVoice] = useState('ash');
  const [geminiVoice, setGeminiVoice] = useState('Charon');
  const [ttsVoice, setTtsVoice] = useState('ash');
  const [triggerAccel, setTriggerAccel] = useState('CommandOrControl+Shift+Space');
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const [capturingKey, setCapturingKey] = useState(false);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testingJarvis, setTestingJarvis] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<VoiceSettingsTab>('canal');

  // Combo capture: while armed, the next SAFE pressed combo (⌘⇧Space, ⌥F,
  // F6 alone…) becomes the trigger exactly as pressed. Esc cancels. Listens
  // in the capture phase so the drawer's own shortcuts never swallow it.
  useEffect(() => {
    if (!capturingKey) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setCapturingKey(false);
        setCaptureHint(null);
        return;
      }
      const combo = comboFromKeyboardEvent(e);
      if (!combo) return; // bare modifier / unsupported key — keep listening
      if ('hint' in combo) {
        setCaptureHint(combo.hint);
        return; // unsafe combo — explain and keep listening
      }
      setTriggerKey(combo.key);
      setTriggerAccel(combo.accel);
      setCaptureHint(null);
      setCapturingKey(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturingKey]);

  // Hydrate once per open session. Do NOT re-run when `info` changes mid-edit
  // (live toggle / setInfo) — that used to re-apply a stale draft and undo the
  // user's in-progress changes (HIGH: soft-draft vs optimistic live config).
  const hydratedForOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      hydratedForOpenRef.current = false;
      setCapturingKey(false);
      return;
    }
    if (hydratedForOpenRef.current) return;

    const draft = peekEphemeralDraft<VoiceSettingsDraft>('voice-settings');
    if (draft) {
      draftHydrationBarrier.markHydrating();
      hydratedForOpenRef.current = true;
      setSttProvider(draft.sttProvider);
      setTtsProvider(draft.ttsProvider);
      setJarvisBrainProvider(draft.jarvisBrainProvider);
      setSpeakMode(draft.speakMode);
      setRouting(draft.routing);
      setTriggerKey(draft.triggerKey);
      setTriggerAccel(draft.triggerAccel);
      setWakeWordOn(draft.wakeWordOn);
      setJarvisLiveOn(draft.jarvisLiveOn);
      setLiveRealtime(draft.liveRealtime);
      setRealtimeTransport(draft.realtimeTransport);
      setAssistantName(draft.assistantName);
      setUserName(draft.userName);
      setCustomInstructions(draft.customInstructions);
      setOpenaiVoice(draft.openaiVoice);
      setGeminiVoice(draft.geminiVoice);
      setTtsVoice(draft.ttsVoice);
      setKeyInputs(draft.keyInputs);
      setActiveTab(draft.activeTab);
      setCaptureHint(null);
      setError(null);
      setTestResult(null);
      return;
    }
    // Wait for runtime info before first hydrate from disk.
    if (!info) return;
    draftHydrationBarrier.markHydrating();
    hydratedForOpenRef.current = true;
    setSttProvider(info.stt.active?.provider ?? info.stt.chain[0]?.provider ?? '');
    setTtsProvider(info.tts.active?.provider ?? info.tts.chain[0]?.provider ?? '');
    setJarvisBrainProvider(
      info.jarvisBrain.active?.provider ?? info.jarvisBrain.chain[0]?.provider ?? '',
    );
    setSpeakMode(info.speakMode);
    setDictationMode(info.dictationOutputMode ?? 'english');
    setRouting(info.routing);
    setTriggerKey(info.pushToTalkKeyCode);
    setTriggerAccel(info.shortcut);
    setWakeWordOn(info.wakeWordEnabled);
    setJarvisLiveOn(info.jarvisLive.enabled);
    setLiveRealtime(info.jarvisLive.transport !== 'classic');
    // Gemini Live é o transporte prioritário do produto; classic também
    // pré-seleciona Gemini para o próximo enable de realtime.
    // Preserva a rota que está gravada. O colapso anterior ("openai se
    // explícito, senão gemini") reescrevia em silêncio qualquer transporte
    // novo — com o Grok existindo, abrir as configurações rebaixaria a escolha
    // do operador para Gemini sem ele pedir.
    setRealtimeTransport(
      info.jarvisLive.transport === 'classic'
        ? DEFAULT_REALTIME_TRANSPORT
        : info.jarvisLive.transport,
    );
    setAssistantName(info.persona.assistantName);
    setUserName(info.persona.userName ?? '');
    setCustomInstructions(info.persona.customInstructions ?? '');
    setOpenaiVoice(info.jarvisLive.openaiVoice || 'ash');
    setGeminiVoice(info.jarvisLive.voiceName || 'Charon');
    setTtsVoice(info.ttsVoice || 'ash');
    setCaptureHint(null);
    setKeyInputs(
      Object.fromEntries(info.keys.map((key) => [key.envVar, ''])),
    );
    setError(null);
    setTestResult(null);
  }, [open, info, draftHydrationBarrier]);

  // Persist in-progress edits continuously (session only).
  useEffect(() => {
    if (!open) return;
    if (draftHydrationBarrier.shouldSkipPersist()) return;
    saveEphemeralDraft<VoiceSettingsDraft>('voice-settings', {
      sttProvider,
      ttsProvider,
      jarvisBrainProvider,
      speakMode,
      routing,
      triggerKey,
      triggerAccel,
      wakeWordOn,
      jarvisLiveOn,
      liveRealtime,
      realtimeTransport,
      assistantName,
      userName,
      customInstructions,
      openaiVoice,
      geminiVoice,
      ttsVoice,
      keyInputs,
      activeTab,
    });
  }, [
    open,
    sttProvider,
    ttsProvider,
    jarvisBrainProvider,
    speakMode,
    routing,
    triggerKey,
    triggerAccel,
    wakeWordOn,
    jarvisLiveOn,
    liveRealtime,
    realtimeTransport,
    assistantName,
    userName,
    customInstructions,
    openaiVoice,
    geminiVoice,
    ttsVoice,
    keyInputs,
    activeTab,
  ]);

  if (!open) return null;

  const save = async () => {
    if (!info) return;
    setSaving(true);
    setError(null);
    try {
      for (const key of info.keys) {
        const value = keyInputs[key.envVar]?.trim() ?? '';
        if (!value) continue;
        const result = await window.nexus.voice.setKey({
          envVar: key.envVar,
          key: value,
        });
        if (!result.ok) {
          setError(result.error ?? `Could not save ${key.envVar}`);
          return;
        }
      }
      const normalizedKey = normalizeKeyCode(triggerKey);
      // Só envia provider se o USUÁRIO mudou o dropdown — reenviar o "ativo"
      // re-fixava o fallback (say) no topo da chain para sempre.
      const sttInitial = info.stt.active?.provider ?? info.stt.chain[0]?.provider ?? '';
      const ttsInitial = info.tts.active?.provider ?? info.tts.chain[0]?.provider ?? '';
      const brainInitial =
        info.jarvisBrain.active?.provider ?? info.jarvisBrain.chain[0]?.provider ?? '';
      const next = await window.nexus.voice.setConfig({
        ...(sttProvider !== sttInitial ? { sttProvider } : {}),
        ...(ttsProvider !== ttsInitial ? { ttsProvider } : {}),
        ...(jarvisBrainProvider !== brainInitial
          ? {
              jarvisBrainProvider: jarvisBrainProvider as
                | 'gemini'
                | 'openai'
                | 'groq',
            }
          : {}),
        speakMode: speakMode as 'summary' | 'full' | 'off',
        dictationOutputMode: dictationMode,
        routing: (jarvisLiveOn ? 'jarvis' : routing) as
          | 'jarvis'
          | 'focused-pane'
          | 'orchestrator'
          | 'ask',
        // The captured combo IS the accelerator (F6 alone, ⌥Space, ⌘⇧J…).
        shortcut: triggerAccel || accelFromCode(normalizedKey),
        pushToTalkKeyCode: normalizedKey,
        wakeWordEnabled: wakeWordOn,
        jarvisLiveEnabled: jarvisLiveOn,
        jarvisLiveTransport: liveRealtime ? realtimeTransport : 'classic',
        personaAssistantName: assistantName.trim() || 'Jarvis',
        personaUserName: userName.trim(),
        personaCustomInstructions: customInstructions.trim(),
        jarvisLiveOpenaiVoice: openaiVoice,
        jarvisLiveGeminiVoice: geminiVoice,
        ttsVoice,
      });
      setInfo(next);
      clearEphemeralDraft('voice-settings');
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Jarvis Live e Áudio realtime persistem NA HORA (otimista), sem depender do
  // botão "Salvar". Sem isto, marcar o toggle e fechar pelo X/Esc/backdrop
  // perdia a marcação — ao reabrir, o useEffect ressincronizava do config
  // salvo e o botão "desmarcava" sozinho. (bug: "coloco live live e não fica").
  const persistLive = async (patch: {
    jarvisLiveEnabled?: boolean;
    jarvisLiveTransport?: JarvisLiveTransport;
  }) => {
    try {
      const next = await window.nexus.voice.setConfig(patch);
      setInfo(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleJarvisLive = (on: boolean) => {
    setJarvisLiveOn(on);
    // Ligar Live com realtime preferido → Gemini (não OpenAI).
    const transport: JarvisLiveTransport = !on
      ? 'classic'
      : liveRealtime
        ? realtimeTransport
        : 'classic';
    void persistLive({
      jarvisLiveEnabled: on,
      ...(on ? { jarvisLiveTransport: transport } : {}),
    });
  };

  const toggleRealtime = (on: boolean) => {
    setLiveRealtime(on);
    if (on) {
      setJarvisLiveOn(true);
      // A escolha do operador no seletor manda; o default do produto (Grok
      // Voice) já é o valor inicial do estado. Reescrever aqui era como o
      // seletor perdia rotas novas.
      const transport: RealtimeTransport = realtimeTransport;
      setRealtimeTransport(transport);
      void persistLive({
        jarvisLiveEnabled: true,
        jarvisLiveTransport: transport,
      });
      return;
    }
    void persistLive({
      jarvisLiveEnabled: jarvisLiveOn,
      jarvisLiveTransport: 'classic',
    });
  };

  const chooseRealtimeTransport = (transport: RealtimeTransport) => {
    setRealtimeTransport(transport);
    setLiveRealtime(true);
    setJarvisLiveOn(true);
    void persistLive({
      jarvisLiveEnabled: true,
      jarvisLiveTransport: transport,
    });
  };

  /** Persist voice pickers immediately so the next Live session picks them up. */
  const persistVoicePick = async (patch: {
    jarvisLiveOpenaiVoice?: string;
    jarvisLiveGeminiVoice?: string;
    ttsVoice?: string;
  }) => {
    try {
      const next = await window.nexus.voice.setConfig(patch);
      setInfo(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const testVoice = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const spoken = await window.nexus.voice.speak({
        text: 'Voz do NexusIDE online. Modo Jarvis pronto.',
        speakMode: 'full',
      });
      if (!spoken.ok) {
        setError(spoken.error);
        return;
      }
      await playSpeakResult(spoken);
      const fallback = spoken.fallbackNote ? ` ${spoken.fallbackNote}` : '';
      setTestResult(`TTS ok via ${spoken.provider}.${fallback}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const testJarvis = async () => {
    setTestingJarvis(true);
    setError(null);
    setTestResult(null);
    try {
      const req: JarvisRequest = {
        transcript:
          'diagnóstico rápido da jarvis: responda em uma frase curta que está online',
        context: {
          workspace: null,
          screen: 'Painel de configurações de voz aberto.',
          recents: [],
          squads: [],
          panes: [],
          focusedPane: null,
          orchestrator: null,
          missions: [],
        },
        history: [],
      };
      if (jarvisLiveOn && liveRealtime) {
        // Diagnostic-only: claim live, run probe, then hard-teardown so Settings
        // does not leave a sticky live owner that blocks other windows.
        const hadLiveSession = Boolean(
          liveState?.sessionId && liveState.status !== 'off',
        );
        try {
          await window.nexus.voice.liveStart({ reason: 'manual' });
          const result = await window.nexus.voice.liveSmokeTest({
            text: req.transcript,
          });
          if (result.ok) {
            setTestResult(
              `Realtime confirmado: reprodução de áudio iniciada em ${result.latencyMs} ms.`,
            );
          } else {
            setError(liveSmokeFailureMessage(result.reason, realtimeTransport));
          }
        } finally {
          if (!hadLiveSession) {
            await window.nexus.voice.liveHardTeardown().catch(() => null);
          }
        }
        return;
      }
      const reply = await window.nexus.voice.jarvis(req);
      if (reply.say.trim()) {
        const spoken = await window.nexus.voice.speak({
          text: reply.say,
          speakMode: 'full',
        });
        if (!spoken.ok) {
          setError(`JARVIS pensou, mas TTS falhou: ${spoken.error}`);
          return;
        }
        await playSpeakResult(spoken);
        const fallback = spoken.fallbackNote ? ` ${spoken.fallbackNote}` : '';
        setTestResult(`JARVIS ok: "${reply.say}"${fallback}`);
        return;
      }
      setTestResult('JARVIS respondeu sem fala audível.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingJarvis(false);
    }
  };

  const clearKey = async (envVar: string) => {
    setError(null);
    const result = await window.nexus.voice.setKey({ envVar, key: '' });
    if (!result.ok) {
      setError(result.error ?? `Could not clear ${envVar}`);
      return;
    }
    setKeyInputs((prev) => ({ ...prev, [envVar]: '' }));
    setInfo(await window.nexus.voice.getInfo());
  };

  const patchKeyInput = (envVar: string, value: string) => {
    setKeyInputs((prev) => ({ ...prev, [envVar]: value }));
  };

  const activeStt = info?.stt.active?.provider ?? info?.stt.chain[0]?.provider ?? 'offline';
  const activeTts = info?.tts.active?.provider ?? info?.tts.chain[0]?.provider ?? 'system';
  const activeBrain =
    info?.jarvisBrain.active?.provider ?? info?.jarvisBrain.chain[0]?.provider ?? 'fallback';
  const realtimeActive = Boolean(jarvisLiveOn && liveRealtime && liveState?.realtimeReady);
  const liveTransportLabel = REALTIME_TRANSPORT_LABEL[realtimeTransport];
  const realtimeConfigured = Boolean(jarvisLiveOn && liveRealtime);
  const liveConnectionTone = realtimeActive
    ? 'online'
    : realtimeConfigured
      ? 'connecting'
      : 'idle';
  const liveConnectionLabel = realtimeActive
    ? `${liveTransportLabel} conectado`
    : realtimeConfigured
      ? `${liveTransportLabel} conectando`
      : jarvisLiveOn
        ? 'Jarvis Live clássico'
        : 'Jarvis em modo manual';
  const liveConnectionDetail = realtimeActive
    ? `Wake word e conversa seguem direto pelo ${liveTransportLabel}. O TTS clássico só entra como fallback.`
    : realtimeConfigured
      ? `O canal ${liveTransportLabel} será usado assim que a sessão terminar de conectar.`
      : jarvisLiveOn
        ? 'A sessão contínua está ativa, mas usa o pipeline clássico de voz.'
        : 'Ative Jarvis Live para manter uma sessão de voz contínua.';
  const wakeMode =
    wakeWordOn && info?.wakeLockHolderPid
      ? `wake word preso pelo PID ${info.wakeLockHolderPid}`
      : wakeWordOn
        ? 'wake word on'
        : 'wake word off';

return (
    <div
      className="agent-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Configurações da Jarvis"
    >
      <div className="agent-picker__overlay" onClick={close} />
      <div className="agent-picker__panel agent-picker__panel--voice voice-settings">
        <header className="voice-settings__hero">
          <div
            className={`voice-settings__orb voice-settings__orb--${liveConnectionTone}`}
            aria-hidden
          >
            <span className="voice-settings__orb-core">J</span>
            <span className="voice-settings__orb-ring" />
            <span className="voice-settings__orb-ring voice-settings__orb-ring--delay" />
          </div>
          <div className="voice-settings__hero-copy">
            <div className="voice-settings__title-row">
              <h3 className="voice-settings__title">Jarvis</h3>
              <span
                className={`voice-settings__connection voice-settings__connection--${liveConnectionTone}`}
                aria-live="polite"
              >
                <span aria-hidden />
                {liveConnectionLabel}
              </span>
            </div>
            <p className="voice-settings__subtitle">
              Console de voz: Live, wake word, persona e fallbacks.
            </p>
          </div>
          <CloseButton
            className="voice-settings__close"
            onClick={close}
            label="Fechar configurações de voz"
          />
        </header>

        {!info ? (
          <p className="agent-picker__empty">Carregando pipeline de voz…</p>
        ) : (
          <div className="voice-settings__shell">
            <nav className="voice-settings__nav" aria-label="Seções da Jarvis">
              {VOICE_TABS.map((tab) => {
                if (tab.id === 'credenciais' && info.keys.length === 0) return null;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`voice-settings__nav-item ${
                      activeTab === tab.id ? 'voice-settings__nav-item--on' : ''
                    }`}
                    aria-current={activeTab === tab.id ? 'page' : undefined}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <span className="voice-settings__nav-icon" aria-hidden>
                      <PixelIcon name={tab.icon} size={14} />
                    </span>
                    <strong>{tab.label}</strong>
                    <span>{tab.hint}</span>
                  </button>
                );
              })}
            </nav>

            <div className="voice-settings__stage">
              {activeTab === 'canal' && (
                <section className="voice-settings__pane" aria-label="Canal de voz">
                  <div className="voice-settings__signal">
                    <div className="voice-settings__signal-summary">
                      <span>Canal de voz</span>
                      <strong>{liveConnectionLabel}</strong>
                      <p>{liveConnectionDetail}</p>
                    </div>
                    <div className="voice-settings__route" aria-label="Rota de atendimento">
                      <span>Wake</span>
                      <i aria-hidden>→</i>
                      <strong>
                        {realtimeConfigured ? liveTransportLabel : 'Pipeline clássico'}
                      </strong>
                      <i aria-hidden>→</i>
                      <span>
                        {realtimeConfigured ? 'áudio ao vivo' : 'resposta por TTS'}
                      </span>
                    </div>
                    <div
                      className="voice-settings__fallback-strip"
                      aria-label="Fallbacks configurados"
                    >
                      <span>
                        <b>STT</b>
                        {activeStt}
                      </span>
                      <span>
                        <b>TTS</b>
                        {activeTts}
                      </span>
                      <span>
                        <b>Cérebro</b>
                        {activeBrain}
                      </span>
                    </div>
                  </div>

                  {transcriptAppend.length > 0 && (
                    <div className="voice-settings__card" aria-label="Transcrição live">
                      <div className="voice-settings__card-head">
                        <h4>Atividade recente</h4>
                        <span>{Math.min(transcriptAppend.length, 6)} eventos</span>
                      </div>
                      <div className="voice-settings__transcript-list">
                        {transcriptAppend.slice(-6).map((line, index) => (
                          <p
                            className="voice-settings__transcript-line"
                            key={`${line.ts}-${index}`}
                          >
                            <span>{line.role === 'user' ? 'Você' : 'Jarvis'}</span>
                            <strong>{line.text}</strong>
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              )}

              {activeTab === 'live' && (
                <section className="voice-settings__pane" aria-label="Live e wake">
                  <div className="voice-settings__card-head voice-settings__card-head--block">
                    <h4>Sessão Live</h4>
                    <p>Aplicado na hora. Demais ajustes usam Salvar.</p>
                  </div>
                  <div className="voice-settings__toggle-stack">
                    <label
                      className={`voice-settings__toggle voice-settings__toggle--primary ${
                        jarvisLiveOn ? 'voice-settings__toggle--selected' : ''
                      }`}
                    >
                      <span>
                        <strong>Jarvis Live</strong>
                        <span>
                          Sessão contínua, contexto curto e voz sem reiniciar a conversa.
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        checked={jarvisLiveOn}
                        onChange={(e) => toggleJarvisLive(e.target.checked)}
                      />
                    </label>

                    <label className="voice-settings__toggle">
                      <span>
                        <strong>Wake word</strong>
                        <span>Diga “Hey Jarvis”; detecção local no Mac.</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={wakeWordOn}
                        onChange={(e) => setWakeWordOn(e.target.checked)}
                      />
                    </label>

                    {jarvisLiveOn && (
                      <label
                        className={`voice-settings__toggle ${
                          liveRealtime ? 'voice-settings__toggle--selected' : ''
                        }`}
                      >
                        <span>
                          <strong>Áudio realtime</strong>
                          <span>
                            {liveTransportLabel}
                            {realtimeActive ? ' · conectado' : ' · em espera'}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={liveRealtime}
                          onChange={(e) => toggleRealtime(e.target.checked)}
                          aria-label="Áudio realtime"
                        />
                      </label>
                    )}

                    {jarvisLiveOn && liveRealtime && (
                      <label className="agent-picker__label voice-settings__transport-field">
                        Transporte realtime
                        <select
                          className="agent-picker__select"
                          value={realtimeTransport}
                          onChange={(e) =>
                            chooseRealtimeTransport(
                              e.target.value as RealtimeTransport,
                            )
                          }
                        >
                          <option value="grok-realtime">Grok Voice (principal)</option>
                          <option value="gemini-live">Gemini Live (fallback)</option>
                          <option value="openai-realtime">
                            OpenAI Realtime (fallback)
                          </option>
                        </select>
                      </label>
                    )}
                  </div>
                  <p className="voice-settings__mode-hint">
                    {jarvisLiveOn
                      ? realtimeConfigured
                        ? 'Live tem prioridade desde o wake. Em silêncio, volta a pronta sem trocar de voz.'
                        : 'Live clássico reabre a escuta após cada resposta e entra em espera no silêncio.'
                      : info.hotkeyMode === 'hold'
                        ? `Segure ${info.shortcut} para falar e solte para enviar.`
                        : `Pressione ${info.shortcut} para falar e de novo para enviar.`}{' '}
                    Estado: {wakeMode}.
                  </p>
                </section>
              )}

              {activeTab === 'voz' && (
                <section className="voice-settings__pane" aria-label="Voz da Jarvis">
                  <div className="voice-settings__card-head voice-settings__card-head--block">
                    <h4>Timbre</h4>
                    <p>
                      <strong>Gemini Live</strong> é o canal principal no dia a dia.
                    </p>
                  </div>
                  <label className="agent-picker__label voice-settings__voice-primary">
                    Voz Gemini Live
                    <select
                      className="agent-picker__select"
                      value={geminiVoice}
                      onChange={(e) => {
                        const v = e.target.value;
                        setGeminiVoice(v);
                        void persistVoicePick({ jarvisLiveGeminiVoice: v });
                      }}
                    >
                      {GEMINI_LIVE_VOICE_OPTIONS.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <details className="voice-settings__fallback-voices" open>
                    <summary>Fallbacks se o Live cair</summary>
                    <div className="voice-settings__form-grid">
                      <label className="agent-picker__label">
                        OpenAI Realtime
                        <select
                          className="agent-picker__select"
                          value={openaiVoice}
                          onChange={(e) => {
                            const v = e.target.value;
                            setOpenaiVoice(v);
                            void persistVoicePick({ jarvisLiveOpenaiVoice: v });
                          }}
                        >
                          {OPENAI_REALTIME_VOICE_OPTIONS.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="agent-picker__label">
                        TTS clássico
                        <select
                          className="agent-picker__select"
                          value={ttsVoice}
                          onChange={(e) => {
                            const v = e.target.value;
                            setTtsVoice(v);
                            void persistVoicePick({ ttsVoice: v });
                          }}
                        >
                          {OPENAI_TTS_VOICE_OPTIONS.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </details>
                </section>
              )}

              {activeTab === 'atendimento' && (
                <section className="voice-settings__pane" aria-label="Atendimento">
                  <div className="voice-settings__card-head voice-settings__card-head--block">
                    <h4>Como atende</h4>
                    <p>Fala, destino do áudio e atalho global.</p>
                  </div>
                  <div className="voice-settings__form-grid voice-settings__form-grid--compact">
                    <label className="agent-picker__label">
                      Modo de fala
                      <select
                        className="agent-picker__select"
                        value={speakMode}
                        onChange={(e) => setSpeakMode(e.target.value)}
                      >
                        <option value="summary">resumo (1-3 frases)</option>
                        <option value="full">completo</option>
                        <option value="off">desligado (só ditado)</option>
                      </select>
                    </label>
                    <label className="agent-picker__label">
                      Roteamento
                      <select
                        className="agent-picker__select"
                        value={routing}
                        onChange={(e) => setRouting(e.target.value)}
                      >
                        <option value="jarvis">JARVIS (conversa)</option>
                        <option value="focused-pane">pane focado</option>
                        <option value="orchestrator">orquestrador</option>
                        <option value="ask">perguntar</option>
                      </select>
                    </label>
                    <label className="agent-picker__label">
                      Saída do ditado
                      <select
                        className="agent-picker__select"
                        value={dictationMode}
                        onChange={(e) =>
                          setDictationMode(
                            e.target.value as 'english' | 'portuguese',
                          )
                        }
                      >
                        <option value="english">
                          inglês otimizado p/ execução (paridade ClockVoice)
                        </option>
                        <option value="portuguese">português literal</option>
                      </select>
                    </label>
                  </div>

                  <div className="voice-settings__dictation-preset">
                    <button
                      type="button"
                      className="agent-picker__btn"
                      disabled={saving}
                      title="Segure Space, fale em português, o texto em inglês vai para o terminal focado (Groq)."
                      onClick={() => {
                        const preset = dictationEnPresetPatch();
                        setRouting(preset.routing);
                        setSpeakMode(preset.speakMode);
                        setTriggerAccel(preset.shortcut);
                        setTriggerKey(preset.pushToTalkKeyCode);
                        setWakeWordOn(preset.wakeWordEnabled);
                        setJarvisLiveOn(preset.jarvisLiveEnabled);
                        setLiveRealtime(false);
                        setSttProvider(preset.sttProvider);
                        setError(null);
                        setSaving(true);
                        void window.nexus.voice
                          .setConfig({
                            ...preset,
                            jarvisLiveTransport: 'classic',
                          })
                          .then((next) => {
                            setInfo(next);
                            setTestResult(
                              'Ditado EN ativo: segure Space → fale → solte. Texto em inglês no pane focado.',
                            );
                          })
                          .catch((err) => {
                            setError(
                              err instanceof Error ? err.message : String(err),
                            );
                          })
                          .finally(() => setSaving(false));
                      }}
                    >
                      Ditado EN (Space + Groq)
                    </button>
                    <p className="voice-settings__hint">
                      Paridade NexusVoice: segura Espaço no terminal, fala, solta —
                      prompt em inglês no pane ativo. Requer <code>GROQ_API_KEY</code>.
                      Com este modo, Space não digita espaço no terminal.
                    </p>
                  </div>

                  <div className="voice-settings__shortcut-row">
                    <label className="agent-picker__label">
                      Atalho
                      <button
                        type="button"
                        className={`agent-picker__select voice-settings__keycap ${
                          capturingKey ? 'voice-settings__keycap--capturing' : ''
                        }`}
                        onClick={() => {
                          setCaptureHint(null);
                          setCapturingKey((v) => !v);
                        }}
                        title="Clique e pressione o combo (ex.: Cmd+Shift+Space). Esc cancela."
                      >
                        {capturingKey
                          ? 'Pressione o atalho… (Esc cancela)'
                          : triggerAccel}
                      </button>
                    </label>
                    <span className="voice-settings__shortcut-preview">
                      {info.hotkeyScope === 'window' ? (
                        <span title="Atalho só nesta janela (estilo NexusVoice).">
                          na janela
                        </span>
                      ) : info.hotkeyArmed === false ? (
                        <span
                          className="voice-settings__shortcut-warn"
                          title="Atalho global não registrou: provável conflito. Escolha outro combo."
                        >
                          não registrado
                        </span>
                      ) : (
                        'ativo'
                      )}
                    </span>
                  </div>
                  {captureHint && (
                    <p className="agent-picker__hint voice-settings__capture-hint">
                      {captureHint}
                    </p>
                  )}

                  <div className="voice-settings__toggle voice-settings__hud-row">
                    <span>
                      <strong>Exibição da JARVIS</strong>
                      <span>
                        HUD arrastável nos cantos; em “só áudio” a voz roda sem visual.
                      </span>
                    </span>
                    <span
                      className="voice-settings__hud-modes"
                      role="radiogroup"
                      aria-label="Modo de exibição do HUD"
                    >
                      {(
                        [
                          ['expanded', 'EXPANDIDA'],
                          ['mini', 'MINI'],
                          ['hidden', 'SÓ ÁUDIO'],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={hudMode === mode}
                          className={`voice-settings__hud-mode ${
                            hudMode === mode ? 'voice-settings__hud-mode--on' : ''
                          }`}
                          onClick={() => setHudMode(mode)}
                        >
                          {label}
                        </button>
                      ))}
                    </span>
                  </div>
                </section>
              )}

              {activeTab === 'fallback' && (
                <section className="voice-settings__pane" aria-label="Fallback clássico">
                  <div className="voice-settings__card-head voice-settings__card-head--block">
                    <h4>Pipeline clássico</h4>
                    <p>Só quando o canal Live não estiver disponível.</p>
                  </div>
                  <div className="voice-settings__form-grid">
                    <label className="agent-picker__label">
                      STT
                      <select
                        className="agent-picker__select"
                        value={sttProvider}
                        onChange={(e) => setSttProvider(e.target.value)}
                      >
                        {info.stt.chain.map((p) => (
                          <option key={p.provider} value={p.provider}>
                            {providerOption(p)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="agent-picker__label">
                      TTS
                      <select
                        className="agent-picker__select"
                        value={ttsProvider}
                        onChange={(e) => setTtsProvider(e.target.value)}
                      >
                        {info.tts.chain.map((p) => (
                          <option key={p.provider} value={p.provider}>
                            {providerOption(p)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="agent-picker__label">
                      Cérebro
                      <select
                        className="agent-picker__select"
                        value={jarvisBrainProvider}
                        onChange={(e) => setJarvisBrainProvider(e.target.value)}
                      >
                        {info.jarvisBrain.chain.map((p) => (
                          <option key={p.provider} value={p.provider}>
                            {providerOption(p)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </section>
              )}

              {activeTab === 'persona' && (
                <section className="voice-settings__pane" aria-label="Persona Jarvis">
                  <div className="voice-settings__card-head voice-settings__card-head--block">
                    <h4>Persona</h4>
                    <p>Como a Jarvis se apresenta e fala com você.</p>
                  </div>
                  <div className="voice-settings__persona">
                    <label className="agent-picker__label">
                      <span>Seu nome</span>
                      <input
                        className="settings-input"
                        value={userName}
                        placeholder="como a JARVIS te chama"
                        maxLength={48}
                        onChange={(e) => setUserName(e.target.value)}
                      />
                    </label>
                    <label className="agent-picker__label">
                      <span>Nome do assistente</span>
                      <input
                        className="settings-input"
                        value={assistantName}
                        placeholder="Jarvis"
                        maxLength={48}
                        onChange={(e) => setAssistantName(e.target.value)}
                      />
                    </label>
                    <label className="agent-picker__label voice-settings__persona-prompt">
                      <span>Instruções personalizadas</span>
                      <textarea
                        className="settings-input"
                        value={customInstructions}
                        rows={4}
                        placeholder='ex.: "sempre responda curto e direto"'
                        maxLength={2000}
                        onChange={(e) => setCustomInstructions(e.target.value)}
                      />
                    </label>
                  </div>
                </section>
              )}

              {activeTab === 'credenciais' && info.keys.length > 0 && (
                <section className="voice-settings__pane" aria-label="Credenciais">
                  <div className="voice-settings__card-head voice-settings__card-head--block">
                    <h4>Cofre local</h4>
                    <p>Chaves protegidas neste Mac. Colar substitui a salva.</p>
                  </div>
                  {info.keys.map((key) => {
                    const credentialLink = credentialLinkForEnv(key.envVar);
                    return (
                      <div className="voice-settings__key-row" key={key.envVar}>
                        <label className="agent-picker__label voice-settings__key-label">
                          {key.envVar}
                          <input
                            className="agent-picker__select"
                            type="password"
                            value={keyInputs[key.envVar] ?? ''}
                            placeholder={keyPlaceholder(key)}
                            onChange={(e) => patchKeyInput(key.envVar, e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <span className="voice-settings__key-meta">
                            {key.providers.join(' / ')} · {keyStatusText(key)}
                            {credentialLink && (
                              <>
                                {' · '}
                                <a
                                  className="settings-link"
                                  href={credentialLink.url}
                                  onClick={(e) =>
                                    openExternalFromAnchor(e, credentialLink.url)
                                  }
                                >
                                  obter key em {credentialLink.label}
                                </a>
                              </>
                            )}
                          </span>
                        </label>
                        <button
                          className="agent-picker__btn voice-settings__clear"
                          onClick={() => void clearKey(key.envVar)}
                          disabled={!key.hasStoredKey}
                        >
                          Clear
                        </button>
                      </div>
                    );
                  })}
                </section>
              )}

              {error && <p className="agent-picker__error">{error}</p>}
              {testResult && <p className="voice-settings__mode-hint">{testResult}</p>}
            </div>
          </div>
        )}

        {info && (
          <div className="agent-picker__actions voice-settings__actions">
            <button className="agent-picker__btn" onClick={testVoice} disabled={testing}>
              {testing ? 'Testando TTS…' : 'Testar TTS'}
            </button>
            <button
              className="agent-picker__btn"
              onClick={testJarvis}
              disabled={testingJarvis}
              title={
                jarvisLiveOn && liveRealtime
                  ? 'Reinicia a sessão realtime para isolar o teste.'
                  : undefined
              }
            >
              {testingJarvis
                ? 'Testando Live…'
                : realtimeConfigured
                  ? `Testar ${liveTransportLabel}`
                  : 'Testar Jarvis'}
            </button>
            <div className="voice-settings__actions-spacer" />
            <button className="agent-picker__btn" onClick={close} disabled={saving}>
              Cancelar
            </button>
            <button
              className="agent-picker__btn agent-picker__btn--primary"
              onClick={save}
              disabled={saving}
            >
              {saving ? 'Salvando…' : 'Salvar alterações'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
