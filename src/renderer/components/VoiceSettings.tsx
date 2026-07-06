import { useEffect, useState } from 'react';
import { useVoiceStore } from '../voice/voice-store';
import {
  accelFromCode,
  normalizeKeyCode,
} from '../../shared/voice-config';
import { credentialLinkForEnv } from '../../shared/credential-links';
import { openExternalFromAnchor } from '../lib/open-external';
import { CloseButton } from './CloseButton';
import type {
  JarvisRequest,
  ResolvedProvider,
  SpeakResult,
  VoiceApiKeyStatus,
} from '../../shared/voice-ipc';

/**
 * Minimal voice settings: pick STT/TTS provider, speak mode, routing, and the
 * push-to-talk shortcut. Includes a "Test voice" that speaks a line through the
 * active TTS chain (macOS `say` needs no key) so users can confirm audio works.
 */

function providerOption(p: ResolvedProvider): string {
  const tag = p.available ? '' : ' (unavailable)';
  const model = p.model ? ` · ${p.model}` : '';
  return `${p.provider}${model}${tag} — ${p.reason}`;
}

function keyStatusText(key: VoiceApiKeyStatus): string {
  if (key.hasStoredKey) return `saved ${key.keyMasked ?? '••••'}`;
  if (key.hasEnv) return 'available from environment';
  if (!key.secureStorageAvailable) return 'Keychain unavailable';
  return 'not set';
}

function keyPlaceholder(key: VoiceApiKeyStatus): string {
  if (key.hasStoredKey) return `Stored ${key.keyMasked ?? 'key'}; paste to replace`;
  if (key.hasEnv) return 'Already set in environment; paste to override';
  return `Paste ${key.envVar}`;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function playAudioBase64(base64: string): Promise<void> {
  const bytes = base64ToBytes(base64);
  const ctx = new AudioContext();
  try {
    const arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  } finally {
    void ctx.close();
  }
}

async function playSpeakResult(result: SpeakResult): Promise<void> {
  if (result.ok && result.mode === 'audio') {
    await playAudioBase64(result.audioBase64);
  }
}

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
 * F-keys may be bare (F6 alone can't collide with typing); any other key
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
  if (!isFKey && !hasStrongMod) {
    return {
      hint: 'Combine com ⌘, ⌃ ou ⌥ (ex.: ⌘⇧Space) — ou use uma tecla F sozinha (ex.: F6).',
    };
  }
  return { accel: [...mods, key].join('+'), key };
}

export function VoiceSettings() {
  const open = useVoiceStore((s) => s.settingsOpen);
  const info = useVoiceStore((s) => s.info);
  const close = useVoiceStore((s) => s.closeSettings);
  const setInfo = useVoiceStore((s) => s.setInfo);
  const hudMode = useVoiceStore((s) => s.hud.mode);
  const setHudMode = useVoiceStore((s) => s.setHudMode);

  const [sttProvider, setSttProvider] = useState('');
  const [ttsProvider, setTtsProvider] = useState('');
  const [jarvisBrainProvider, setJarvisBrainProvider] = useState('');
  const [speakMode, setSpeakMode] = useState('summary');
  const [routing, setRouting] = useState('focused-pane');
  const [triggerKey, setTriggerKey] = useState('Space');
  const [wakeWordOn, setWakeWordOn] = useState(false);
  const [jarvisLiveOn, setJarvisLiveOn] = useState(false);
  const [liveRealtime, setLiveRealtime] = useState(false);
  const [assistantName, setAssistantName] = useState('Jarvis');
  const [userName, setUserName] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [triggerAccel, setTriggerAccel] = useState('CommandOrControl+Shift+Space');
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const [capturingKey, setCapturingKey] = useState(false);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testingJarvis, setTestingJarvis] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!open) {
      setCapturingKey(false);
      return;
    }
    if (!info) return;
    setSttProvider(info.stt.active?.provider ?? info.stt.chain[0]?.provider ?? '');
    setTtsProvider(info.tts.active?.provider ?? info.tts.chain[0]?.provider ?? '');
    setJarvisBrainProvider(
      info.jarvisBrain.active?.provider ?? info.jarvisBrain.chain[0]?.provider ?? '',
    );
    setSpeakMode(info.speakMode);
    setRouting(info.routing);
    setTriggerKey(info.pushToTalkKeyCode);
    setTriggerAccel(info.shortcut);
    setWakeWordOn(info.wakeWordEnabled);
    setJarvisLiveOn(info.jarvisLive.enabled);
    setLiveRealtime(info.jarvisLive.transport === 'gemini-live');
    setAssistantName(info.persona.assistantName);
    setUserName(info.persona.userName ?? '');
    setCustomInstructions(info.persona.customInstructions ?? '');
    setCaptureHint(null);
    setKeyInputs(
      Object.fromEntries(info.keys.map((key) => [key.envVar, ''])),
    );
    setError(null);
    setTestResult(null);
  }, [open, info]);

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
        jarvisLiveTransport: liveRealtime ? 'gemini-live' : 'classic',
        personaAssistantName: assistantName.trim() || 'Jarvis',
        personaUserName: userName.trim(),
        personaCustomInstructions: customInstructions.trim(),
      });
      setInfo(next);
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
    void persistLive({ jarvisLiveEnabled: on });
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
      setTestResult(`TTS ok via ${spoken.provider}.`);
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
        setTestResult(`JARVIS ok: "${reply.say}"`);
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
  const liveMode = jarvisLiveOn
    ? liveRealtime
      ? 'live realtime'
      : 'live classic'
    : 'push-to-talk';
  const wakeMode =
    wakeWordOn && info?.wakeLockHolderPid
      ? `wake word preso pelo PID ${info.wakeLockHolderPid}`
      : wakeWordOn
        ? 'wake word on'
        : 'wake word off';

  return (
    <div className="agent-picker" role="dialog" aria-label="Voice settings">
      <div className="agent-picker__overlay" onClick={close} />
      <div className="agent-picker__panel agent-picker__panel--voice voice-settings">
        <header className="voice-settings__hero">
          <span className="voice-settings__mark" aria-hidden>
            J
          </span>
          <div className="voice-settings__hero-copy">
            <span className="voice-settings__eyebrow">VOICE CONTROL</span>
            <h3 className="voice-settings__title">Jarvis</h3>
            <p className="voice-settings__subtitle">
              Pipeline de voz, wake word, live mode e persona em um painel único.
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
          <>
            <div className="voice-settings__status-grid" aria-label="Estado do Jarvis">
              <span className="voice-settings__status-card">
                <span>STT</span>
                <strong>{activeStt}</strong>
              </span>
              <span className="voice-settings__status-card">
                <span>TTS</span>
                <strong>{activeTts}</strong>
              </span>
              <span className="voice-settings__status-card">
                <span>BRAIN</span>
                <strong>{activeBrain}</strong>
              </span>
              <span className="voice-settings__status-card voice-settings__status-card--accent">
                <span>MODE</span>
                <strong>{liveMode}</strong>
              </span>
            </div>

            <section className="voice-settings__section" aria-label="Pipeline de voz">
              <h4 className="voice-settings__section-title">Pipeline</h4>
              <div className="voice-settings__form-grid">
                <label className="agent-picker__label">
                  STT · traduz PT→EN
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
                  TTS · voz de saída
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
                  Cérebro Jarvis
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

            {info.keys.length > 0 && (
              <section className="voice-settings__section" aria-label="Voice API keys">
                <h4 className="voice-settings__section-title">Credenciais</h4>
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

            <section className="voice-settings__section" aria-label="Operação Jarvis">
              <h4 className="voice-settings__section-title">Operação</h4>
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
                    <option value="jarvis">JARVIS (assistente conversacional)</option>
                    <option value="focused-pane">pane focado</option>
                    <option value="orchestrator">orquestrador</option>
                    <option value="ask">perguntar</option>
                  </select>
                </label>
              </div>

              <div className="voice-settings__shortcut-row">
                <label className="agent-picker__label">
                  Atalho do Jarvis
                  <button
                    type="button"
                    className={`agent-picker__select voice-settings__keycap ${capturingKey ? 'voice-settings__keycap--capturing' : ''}`}
                    onClick={() => {
                      setCaptureHint(null);
                      setCapturingKey((v) => !v);
                    }}
                    title="Clique e pressione o COMBO desejado (ex.: Cmd+Shift+Space, Alt+J) ou uma tecla F sozinha (ex.: F6). Esc cancela."
                  >
                    {capturingKey
                      ? 'Pressione o atalho... (Esc cancela)'
                      : triggerAccel}
                  </button>
                </label>
                <span className="voice-settings__shortcut-preview">
                  {info.hotkeyArmed === false ? (
                    <span
                      className="voice-settings__shortcut-warn"
                      title="O atalho global não registrou no sistema: provável conflito com outro app. Escolha outro combo."
                    >
                      nao registrado
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

              <div className="voice-settings__toggle-stack">
                <label className="voice-settings__toggle">
                  <span>
                    <strong>Wake word</strong>
                    <span>Diga "Hey Jarvis"; detecção local/offline via openWakeWord.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={wakeWordOn}
                    onChange={(e) => setWakeWordOn(e.target.checked)}
                  />
                </label>

                <label className="voice-settings__toggle">
                  <span>
                    <strong>Jarvis Live</strong>
                    <span>Sessão contínua com grace reuse, contexto curto e barge-in.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={jarvisLiveOn}
                    onChange={(e) => toggleJarvisLive(e.target.checked)}
                  />
                </label>

                {jarvisLiveOn && (
                  <label className="voice-settings__toggle">
                    <span>
                      <strong>Áudio realtime</strong>
                      <span>
                        Temporariamente bloqueado: o Live atual usa o loop
                        Classic, que executa ações no Nexus. O realtime ainda
                        não dirige ferramentas com segurança.
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={false}
                      disabled
                      aria-label="Áudio realtime temporariamente indisponível"
                    />
                  </label>
                )}

                <div className="voice-settings__toggle voice-settings__hud-row">
                  <span>
                    <strong>Exibição da JARVIS</strong>
                    <span>
                      O HUD é arrastável e ancora nos cantos; em "só áudio" a voz
                      funciona sem visual nenhum.
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
              </div>

              <p className="agent-picker__hint voice-settings__mode-hint">
                {jarvisLiveOn
                  ? 'No Live, a JARVIS reabre a escuta depois de cada resposta e entra em dormant quando você fica em silêncio.'
                  : info.hotkeyMode === 'hold'
                  ? `Segure ${info.shortcut} para falar e solte para enviar.`
                  : `Pressione ${info.shortcut} para começar a falar e pressione de novo para enviar.`}{' '}
                Estado atual: {wakeMode}.
              </p>
            </section>

            <section className="voice-settings__section" aria-label="Persona Jarvis">
              <h4 className="voice-settings__section-title">Persona</h4>
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
                    rows={2}
                    placeholder='ex.: "sempre responda curto e direto"'
                    maxLength={2000}
                    onChange={(e) => setCustomInstructions(e.target.value)}
                  />
                </label>
              </div>
            </section>

            {error && <p className="agent-picker__error">{error}</p>}
            {testResult && <p className="voice-settings__mode-hint">{testResult}</p>}

            <div className="agent-picker__actions">
              <button className="agent-picker__btn" onClick={testVoice} disabled={testing}>
                {testing ? 'Falando…' : 'Testar voz'}
              </button>
              <button
                className="agent-picker__btn"
                onClick={testJarvis}
                disabled={testingJarvis}
              >
                {testingJarvis ? 'Diagnosticando…' : 'Testar JARVIS'}
              </button>
              <button className="agent-picker__btn" onClick={close} disabled={saving}>
                Cancel
              </button>
              <button
                className="agent-picker__btn agent-picker__btn--primary"
                onClick={save}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
