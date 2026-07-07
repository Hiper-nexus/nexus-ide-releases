import { useEffect, useRef } from 'react';
import { useVoiceStore } from './voice-store';
import { markVictory } from '../state/onboarding-store';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { VoiceCapture } from './voice-capture';
import { WakeMic } from './wake-mic';
import { classifyMicHealth, type MicHealth } from './wake-health';
import { LiveAudioPlayer, micFrameToBase64 } from './live-audio';
import { stripPromptEcho } from './response-echo';
import { isDiscardableTranscript, stripWakeAckEcho } from './transcript-filter';
import { onJarvisWakeRequest } from './manual-wake';
import {
  delay,
  noteAutoReplyOpened,
  resetAutoReplyLoop,
  REPLY_LISTEN_DELAY_MS,
  shouldReopenJarvisListening,
} from './jarvis-reply-loop';
import {
  bindWakeSuppressor,
  playAudioBase64,
  playSpeakResult,
  stopAllPlayback,
} from './voice-playback';
import {
  getThinkFillerCache,
  invalidateAckCacheIfPersonaChanged,
  playCachedWakeAck,
  playWakePrompt,
  THINK_FILLERS,
  warmAckCache,
  wakeGreetingText,
} from './voice-wake-ack';
import { getPaneSessionId, writeToPane } from '../terminal/terminal-host';
import { listPanes } from '../lib/split-tree';
import { useWorkspaceStore } from '../state/workspace-store';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useHomeStore } from '../state/home-store';
import { useFilesStore } from '../state/files-store';
import { useSettingsStore } from '../state/settings-store';
import { executeJarvisAction } from './jarvis-action-executor';
import type { AutoStopOptions } from './voice-capture';
import type {
  JarvisLiveTranscriptEvent,
  JarvisTurn,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';

/**
 * The Jarvis pipeline, renderer side. Wires the global PTT edges to:
 *   capture mic → transcribe+translate (main) → inject into focused pane →
 *   capture the agent's reply → speak it back (main TTS).
 *
 * Mounted once from App. All work is guarded so a missing mic / key / pane
 * surfaces a clear status instead of throwing.
 */

const RESPONSE_QUIET_MS = 1_500; // speak once the pane has been quiet this long
const RESPONSE_MAX_MS = 20_000; // hard cap on how long we wait for a reply
const MIN_SPEECH_SEC = 0.25; // ignore accidental taps shorter than this
const REALTIME_ACTION_BRIDGE_ENABLED = true;
const REALTIME_TRANSCRIPT_WAIT_MS = 4_500;
const WAKE_ACK_SUPPRESS_MS = 1_500;
const WAKE_PREROLL_MS = 2_500;
const WAKE_SILENCE_MS = 700; // wake-word capture: quiet time that ends the utterance
const WAKE_MAX_MS = 15_000; // wake-word capture: hard cap
const PTT_HOLD_MAX_MS = 60_000; // hold-to-talk sem keyup (tap morto) fecha aqui
const JARVIS_MEMORY_MS = 240_000; // 4 min: conversa continua sem recomeçar do zero

// Deadlines das invocações renderer→main (cinto E suspensório sobre os
// timeouts do main): se QUALQUER etapa pendurar além disto, o turno morre com
// erro falável em vez de deixar busy travado — "JARVIS não responde nunca
// mais" era exatamente um await sem deadline segurando o busy para sempre.
export const TRANSCRIBE_DEADLINE_MS = 60_000;
export const BRAIN_DEADLINE_MS = 35_000;
const SPEAK_DEADLINE_MS = 40_000;
// Turno preso além disto + novo "Hey Jarvis" = derruba o turno e atende.
// granted mas mudo além disso → "silent" (dispositivo morto/mudo, ex.: fifine)
const MIC_SILENT_THRESHOLD_MS = 12_000;
// re-avalia permissão + silêncio do mic a cada 5s (banner de saúde reage)
const MIC_HEALTH_CHECK_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} demorou demais (${Math.round(ms / 1000)}s)`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Memória curta da conversa com a JARVIS (renderer-local, por janela).
let jarvisHistory: JarvisTurn[] = [];
const wakeMic = new WakeMic();
bindWakeSuppressor((ms) => wakeMic.suppressWakeDetection(ms));
// Player do áudio realtime (OpenAI Realtime / Gemini Live): só instanciado sob demanda.
let livePlayer: LiveAudioPlayer | null = null;
function ensureLivePlayer(): LiveAudioPlayer {
  return (livePlayer ??= new LiveAudioPlayer());
}
// Decision is per utterance. Realtime provides fast duplex audio/transcript,
// but app actions still flow through the audited Classic Jarvis/MCP executor.
let realtimeTurnActive = false;
let suppressRealtimeAudioOut = false;
let pendingRealtimeTranscript:
  | {
      resolve: (text: string | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | null = null;
let jarvisLastTurnAt = 0;
let wakeOpenInProgress = false;
let activeCaptureReason: 'manual' | 'wake' | 'ptt' | 'reply' = 'manual';
// Início do turno em processamento (0 = nenhum) — o wake usa para detectar
// turno PRESO (fetch pendurado etc.) e retomar o controle.


function isJarvisLiveEnabled(): boolean {
  const info = useVoiceStore.getState().info;
  return Boolean(info?.jarvisLive.enabled && info.routing === 'jarvis');
}

/** Transporte realtime (áudio full-duplex OpenAI/Gemini) ligado? */
function isRealtimeLive(): boolean {
  const info = useVoiceStore.getState().info;
  const liveState = useVoiceStore.getState().liveState;
  return Boolean(
    isJarvisLiveEnabled() &&
      info?.jarvisLive.transport !== 'classic' &&
      liveState?.realtimeReady === true &&
      liveState.status !== 'error',
  );
}

function shouldStreamToRealtime(): boolean {
  const info = useVoiceStore.getState().info;
  const liveState = useVoiceStore.getState().liveState;
  return Boolean(
    realtimeTurnActive &&
      isJarvisLiveEnabled() &&
      info?.jarvisLive.transport !== 'classic' &&
      liveState?.status !== 'error',
  );
}

function resolvePendingRealtimeTranscript(text: string | null): void {
  const pending = pendingRealtimeTranscript;
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRealtimeTranscript = null;
  pending.resolve(text);
}

function waitForRealtimeTranscript(timeoutMs = REALTIME_TRANSCRIPT_WAIT_MS): Promise<string | null> {
  if (pendingRealtimeTranscript) resolvePendingRealtimeTranscript(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRealtimeTranscript?.resolve === resolve) {
        pendingRealtimeTranscript = null;
      }
      resolve(null);
    }, timeoutMs);
    pendingRealtimeTranscript = { resolve, timer };
  });
}

function onRealtimeTranscriptForActionBridge(event: JarvisLiveTranscriptEvent): void {
  if (!pendingRealtimeTranscript) return;
  if (!realtimeTurnActive || event.role !== 'user' || !event.final) return;
  const text = event.text.trim();
  if (!text) return;
  resolvePendingRealtimeTranscript(text);
}

function liveStatus(
  status: 'dormant' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error',
  error?: string,
): void {
  if (!isJarvisLiveEnabled()) return;
  void window.nexus.voice.liveStatus({ status, ...(error ? { error } : {}) });
}

function liveEndTurn(): void {
  if (!isJarvisLiveEnabled()) return;
  void window.nexus.voice
    .liveEndTurn()
    .then((state) => useVoiceStore.getState().setLiveState(state))
    .catch(() => {});
}

function personaUserName(): string {
  return useVoiceStore.getState().info?.persona.userName?.trim() ?? '';
}


interface ScreenSnapshot {
  context: string;
  wakePrompt: string;
}

function currentScreenSnapshot(): ScreenSnapshot {
  const workspace = useWorkspaceStore.getState().current;
  const { root, focusedPaneId, viewKind } = useLayoutStore.getState();
  const panes = listPanes(root);
  const focused = panes.find((p) => p.id === focusedPaneId);
  const orch = useOrchStore.getState();
  const wizard = useMissionWizardStore.getState();
  const files = useFilesStore.getState();
  const settings = useSettingsStore.getState();
  const homeVisible = useHomeStore.getState().visible;
  const voiceSettingsOpen = useVoiceStore.getState().settingsOpen;
  const wsName = workspace?.name ?? 'nenhum projeto';

  if (voiceSettingsOpen) {
    return {
      context: 'Configurações de voz abertas: pipeline, keys, wake word, live mode e persona.',
      wakePrompt: 'Estou nas configurações de voz. O que você quer ajustar agora?',
    };
  }
  if (settings.drawerOpen) {
    return {
      context: 'Drawer de configurações aberto: providers, contas, catálogo, mídia, shortcuts e módulos.',
      wakePrompt: 'Estou nas configurações. Quer ajustar providers, keys ou outro módulo?',
    };
  }
  if (wizard.open) {
    const mode = wizard.presetSquadId
      ? 'revisão de squad pronto'
      : wizard.variant === 'workspace'
        ? 'novo workspace'
        : 'nova missão';
    return {
      context: `Wizard aberto em ${mode}.`,
      wakePrompt: `Estou no assistente de ${mode}. Qual opção vamos escolher?`,
    };
  }
  if (homeVisible) {
    const squads = orch.squads.slice(0, 3).map((s) => s.name).join(', ');
    return {
      context:
        `Tela "Pronto para operar" no workspace ${wsName}. ` +
        `Ações visíveis: iniciar missão, squad sob medida, terminal` +
        (squads ? `, squads prontos (${squads})` : '') +
        '.',
      wakePrompt:
        'Estou na tela Pronto para operar. Quer iniciar uma missão, montar um squad sob medida ou usar um squad pronto?',
    };
  }
  if (files.open) {
    const file = files.openFile?.relPath;
    return {
      context: file
        ? `Painel de arquivos aberto no arquivo ${file}${files.openFile?.dirty ? ' com alterações não salvas' : ''}.`
        : 'Painel de arquivos aberto, sem arquivo selecionado.',
      wakePrompt: file
        ? `Estou no arquivo ${file}. Quer que eu leia, edite ou salve algo nele?`
        : 'Estou no painel de arquivos. Qual arquivo quer abrir?',
    };
  }
  if (orch.boardOpen) {
    return {
      context: `Ops Board aberto com ${orch.missions.length} missões no workspace ${wsName}.`,
      wakePrompt: 'Estou no quadro de missões. Quer ver status, abrir uma missão ou criar outra?',
    };
  }
  if (orch.panelOpen) {
    return {
      context: `Painel de orquestração aberto na aba ${orch.panelTab}.`,
      wakePrompt: `Estou no painel de orquestração, aba ${orch.panelTab}. O que quer verificar?`,
    };
  }

  return {
    context:
      `Workspace ${wsName} em modo ${viewKind}. ` +
      `${panes.length} pane${panes.length === 1 ? '' : 's'} aberto${panes.length === 1 ? '' : 's'}. ` +
      `Pane focado: ${focused?.title ?? 'nenhum'}.`,
    wakePrompt: focused
      ? `Estou no pane ${focused.title}. O que vamos fazer nele?`
      : `Estou no workspace ${wsName}. Quer abrir missão, terminal ou squad?`,
  };
}


/** Auto-stop padrão das capturas iniciadas por voz (sem tecla de soltar). */
function wakeAutoStop(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): AutoStopOptions {
  return {
    silenceMs: WAKE_SILENCE_MS,
    maxMs: WAKE_MAX_MS,
    onAutoStop: () => {
      if (isListening(capture)) void finishAndProcess(capture, busy);
    },
  };
}

export function useVoiceController(): void {
  const capture = useRef<VoiceCapture | null>(null);
  const busy = useRef(false);
  // Trava de narração proativa: garante uma fala ambiente por vez (anti-eco de
  // duas vozes sobrepostas).
  const narratingRef = useRef(false);

  useEffect(() => {
    capture.current = new VoiceCapture();
    // Nível de mic ao vivo → orb como visualizador REAL de amplitude.
    capture.current.onLevel = (level) => useVoiceStore.getState().setLevel(level);
    const store = useVoiceStore.getState();

    // Wake word ("Jarvis"): detection → ela RESPONDE ao chamado ("Pois não?")
    // e então abre a escuta hands-free (auto-stop por silêncio).
    const handleWake = async () => {
      if (wakeOpenInProgress) return;
      wakeOpenInProgress = true;
      try {
        markVictory('voiceEnabled');
        // BARGE-IN total: novo "Hey Jarvis" sempre retoma — turno preso deixava surda.
        stopAllPlayback();
        if (wakeMic.isUtteranceActive()) wakeMic.cancelUtterance();
        if (capture.current?.isCapturing()) {
          try {
            await capture.current.stop();
          } catch {
            // segue — o wake mic quente é o caminho principal
          }
        }
        busy.current = false;
        useVoiceStore.getState().setStatus('idle');
        useVoiceStore.getState().setError(null);

        const ack = wakeGreetingText(personaUserName());
        wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);
        // Escuta ANTES do ack terminar — senão a fala durante "Pois não?" se perde.
        await beginListening(
          capture.current!,
          wakeAutoStop(capture.current!, busy),
          'wake',
        );
        void playWakePrompt(ack).catch(() => playCachedWakeAck(personaUserName()));
      } finally {
        wakeOpenInProgress = false;
      }
    };
    const onWake = () => {
      void handleWake();
    };
    // Morte do stream do mic (AirPods trocados, sleep/wake): o WakeMic
    // reconstrói sozinho; se esgotar, a UI avisa em vez de ficar surda muda.
    // Auto-rearme: onDied NÃO é mais estado terminal — o WakeMic continua
    // tentando a cada 30s até o dispositivo voltar. Avisamos como nota
    // transitória, não como erro vermelho exigindo toggle manual.
    wakeMic.onDied = (reason) => {
      useVoiceStore
        .getState()
        .setNote(`Mic do wake rearmarando (${reason}) a cada 30s…`);
    };
    wakeMic.onRecovered = () => {
      useVoiceStore.getState().setNote('mic do wake reconectado');
    };

    // ── Saúde do mic: detecta permissão faltando / captura muda e avisa a UI ──
    // macOS entrega áudio mudo (zeros) sem erro quando falta permissão; sem isto
    // a JARVIS fica "surda" em silêncio. classifications → banner acionável.
    let lastMicHealth: MicHealth | null = null;
    const checkMicHealth = async (): Promise<void> => {
      if (!wakeMic.isRunning()) {
        if (lastMicHealth && lastMicHealth !== 'ok') {
          useVoiceStore.getState().setMicHealth('ok');
          lastMicHealth = 'ok';
        }
        return;
      }
      const perm = await wakeMic.checkPermission();
      const health = classifyMicHealth(
        perm,
        wakeMic.getSilentMs(),
        MIC_SILENT_THRESHOLD_MS,
      );
      if (health !== lastMicHealth) {
        useVoiceStore.getState().setMicHealth(health);
        lastMicHealth = health;
        if (health !== 'ok') {
          window.nexus.voice.logVoice({
            level: 'warn',
            event: 'mic.health',
            msg: health,
            data: { permission: perm },
          });
        }
      }
    };
    const micHealthTimer = setInterval(checkMicHealth, MIC_HEALTH_CHECK_MS);
    void checkMicHealth();
    const syncWakeWord = (info: VoiceRuntimeInfo) => {
      if (info.enabled && info.wakeWordEnabled) {
        invalidateAckCacheIfPersonaChanged(info);
        warmAckCache(info.persona.userName ?? '');
        void wakeMic.start().catch((err) => {
          useVoiceStore
            .getState()
            .setError(`Wake word indisponível: ${errMsg(err)}`);
        });
      } else {
        wakeMic.stop();
      }
    };

    void window.nexus.voice.getInfo().then((info) => {
      store.setInfo(info);
      syncWakeWord(info);
    });
    const unsubInfo = window.nexus.voice.onInfoChanged((info: VoiceRuntimeInfo) => {
      useVoiceStore.getState().setInfo(info);
      syncWakeWord(info);
    });
    const unsubLiveState = window.nexus.voice.onLiveState((state) => {
      useVoiceStore.getState().setLiveState(state);
    });
    const unsubLiveTranscript = window.nexus.voice.onLiveTranscript((event) => {
      useVoiceStore.getState().addLiveTranscript(event);
      onRealtimeTranscriptForActionBridge(event);
    });
    const unsubTranscriptAppend = window.nexus.voice.onTranscriptAppend((event) => {
      useVoiceStore.getState().addTranscriptAppend(event);
    });
    const unsubLiveToolCall = window.nexus.voice.onLiveToolCall((event) => {
      useVoiceStore.getState().setLiveTool(event);
    });
    const unsubLiveToolResult = window.nexus.voice.onLiveToolResult((event) => {
      useVoiceStore.getState().setLiveTool(event);
    });
    const unsubLiveInterrupted = window.nexus.voice.onLiveInterrupted((event) => {
      useVoiceStore.getState().setLiveInterrupted(event);
      // barge-in do servidor realtime: corta o áudio que está tocando.
      livePlayer?.stop();
    });
    // Áudio realtime (provider TTS PCM 24 kHz) → toca em fila contínua.
    const unsubLiveAudio = window.nexus.voice.onLiveAudioOut((b64) => {
      if (suppressRealtimeAudioOut) return;
      ensureLivePlayer().play(b64);
    });
    // Espelha o mic para o transporte realtime enquanto o comando é falado.
    wakeMic.setUtteranceFrameTap((frame, sampleRate) => {
      if (shouldStreamToRealtime()) {
        window.nexus.voice.liveMicIn(micFrameToBase64(frame, sampleRate));
      }
    });

    const onStart = () => {
      if (busy.current) return;
      // Hold-to-talk com guarda: se o keyup nunca chegar (event tap do uiohook
      // morto — o macOS desliga taps em silêncio), o deadline fecha o turno.
      const holdGuard: AutoStopOptions = {
        silenceMs: PTT_HOLD_MAX_MS, // nunca fecha por silêncio no hold
        maxMs: PTT_HOLD_MAX_MS,
        onAutoStop: () => {
          if (isListening(capture.current)) void finishAndProcess(capture.current!, busy);
        },
      };
      void beginListening(capture.current!, holdGuard, 'ptt');
    };
    const onStop = () => {
      if (!isListening(capture.current)) return;
      void finishAndProcess(capture.current!, busy);
    };

    // Toggle: o renderer decide — capturando? envia. Senão, começa a ouvir.
    const onToggle = () => {
      if (isListening(capture.current)) {
        onStop();
      } else {
        stopAllPlayback();
        if (busy.current && useVoiceStore.getState().status === 'speaking') {
          busy.current = false;
        }
        void beginListening(capture.current!, undefined, 'manual');
      }
    };

    const unsubStart = window.nexus.voice.onPttStart(onStart);
    const unsubStop = window.nexus.voice.onPttStop(onStop);
    const unsubToggle = window.nexus.voice.onPttToggle(onToggle);
    const unsubWake = window.nexus.voice.onWakeDetected(onWake);
    const unsubClickWake = onJarvisWakeRequest(onWake);
    // Narração proativa (handoff entregue/travado): fala só quando não há
    // turno de voz em andamento — aviso ambiente nunca atropela a conversa. É
    // SERIALIZADA (narratingRef): uma narração por vez, nunca duas vozes
    // sobrepostas. Marca 'speaking' enquanto fala para bloquear turnos e
    // narrações concorrentes; cancela qualquer playback pendente antes.
    const unsubNarrate = window.nexus.voice.onNarrate(({ text }) => {
      const status = useVoiceStore.getState().status;
      if (status !== 'idle' || narratingRef.current) {
        console.log('[voice] narração pulada (ocupado):', text.slice(0, 60));
        return;
      }
      narratingRef.current = true;
      const store = useVoiceStore.getState();
      store.setStatus('speaking');
      stopAllPlayback();
      void (async () => {
        try {
          const spoken = await window.nexus.voice.speak({ text, speakMode: 'full' });
          if (spoken.ok && spoken.mode === 'audio') {
            await playAudioBase64(spoken.audioBase64, spoken.format);
          }
        } catch (err) {
          console.warn('[voice] narração falhou:', err);
        } finally {
          narratingRef.current = false;
          if (useVoiceStore.getState().status === 'speaking') {
            useVoiceStore.getState().setStatus('idle');
          }
        }
      })();
    });

    return () => {
      clearInterval(micHealthTimer);
      unsubInfo();
      unsubStart();
      unsubStop();
      unsubToggle();
      unsubWake();
      unsubClickWake();
      unsubNarrate();
      unsubLiveState();
      unsubLiveTranscript();
      unsubTranscriptAppend();
      unsubLiveToolCall();
      unsubLiveToolResult();
      unsubLiveInterrupted();
      unsubLiveAudio();
      wakeMic.setUtteranceFrameTap(null);
      livePlayer?.dispose();
      livePlayer = null;
      wakeMic.stop();
    };
  }, []);
}

async function beginListening(
  capture: VoiceCapture,
  autoStop?: import('./voice-capture').AutoStopOptions,
  reason: 'manual' | 'wake' | 'ptt' | 'reply' = 'manual',
): Promise<void> {
  const store = useVoiceStore.getState();
  try {
    store.setNote(null);
    realtimeTurnActive = false;
    suppressRealtimeAudioOut = false;
    activeCaptureReason = reason;
    if (isJarvisLiveEnabled()) {
      const info = useVoiceStore.getState().info;
      realtimeTurnActive =
        REALTIME_ACTION_BRIDGE_ENABLED && info?.jarvisLive.transport !== 'classic';
      void window.nexus.voice.liveStart({ reason }).then((state) => {
        store.setLiveState(state);
      }).catch((err) => {
        realtimeTurnActive = false;
        console.warn('[voice] liveStart falhou (classic segue):', errMsg(err));
      });
    }
    // Padrao pendingMic: mic ANTES da sessao live ficar pronta — liveStart
    // nao pode bloquear a captura ou a fala inicial some do WAV.
    if (wakeMic.isRunning()) {
      wakeMic.beginUtterance(autoStop, reason === 'wake' ? WAKE_PREROLL_MS : 0);
    } else {
      await capture.start(autoStop);
    }
    store.setStatus('listening');
    liveStatus('listening');
  } catch (err) {
    store.setError(`Mic unavailable: ${errMsg(err)}`);
    liveStatus('error', errMsg(err));
  }
}

/** Está escutando por QUALQUER backend (mic quente do wake ou captura própria)? */
function isListening(capture: VoiceCapture | null): boolean {
  return Boolean(capture?.isCapturing() || wakeMic.isUtteranceActive());
}

async function finishAndProcess(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  busy.current = true;
  try {
    const result = wakeMic.isUtteranceActive()
      ? wakeMic.finishUtterance()
      : await capture.stop();
    if (
      !result.wavBase64 ||
      result.durationSec < MIN_SPEECH_SEC ||
      result.heardSpeech === false
    ) {
      if (result.heardSpeech === false) {
        console.log('[voice] captura sem fala real (silêncio/ruído) — descartada');
      }
      store.setStatus('idle');
      liveEndTurn();
      return;
    }

    const routing = store.info?.routing ?? 'focused-pane';

    if (routing === 'jarvis' && shouldStreamToRealtime()) {
      const tRealtime = Date.now();
      store.setStatus('transcribing');
      liveStatus('thinking');
      suppressRealtimeAudioOut = true;
      liveEndTurn();
      const liveTranscript = await waitForRealtimeTranscript();
      if (liveTranscript) {
        // The realtime model may start speaking after endTurn. For the action
        // bridge, Classic/MCP owns the response, so cancel provider audio first.
        livePlayer?.stop();
        stopAllPlayback();
        void window.nexus.voice.liveInterrupt('classic-action-bridge').catch(() => {});
        realtimeTurnActive = false;
        const transcript =
          activeCaptureReason === 'wake'
            ? stripWakeAckEcho(liveTranscript, personaUserName())
            : liveTranscript.trim();
        if (!transcript) {
          console.log(`[voice] realtime transcript descartado como eco wake: "${liveTranscript}"`);
          store.setStatus('idle');
          liveEndTurn();
          return;
        }
        const inConversation =
          jarvisHistory.length > 0 && Date.now() - jarvisLastTurnAt <= JARVIS_MEMORY_MS;
        if (isDiscardableTranscript(transcript, { inConversation })) {
          console.log(`[voice] realtime transcript lixo descartado: "${transcript}"`);
          store.setStatus('idle');
          liveEndTurn();
          return;
        }
        store.setTranscript(transcript);
        store.setNote(null);
        resetAutoReplyLoop();
        console.log(
          `[voice] realtime transcript (${Date.now() - tRealtime}ms): "${transcript}"`,
        );
        await runJarvisTurn(transcript, capture, busy);
        return;
      }
      console.log(
        `[voice] realtime sem transcript final em ${Date.now() - tRealtime}ms — fallback Classic STT`,
      );
      void window.nexus.voice.liveInterrupt('classic-action-bridge-timeout').catch(() => {});
      realtimeTurnActive = false;
    }

    // Feedback INSTANTÂNEO: um micro-filler do cache cobre o tempo de
    // STT+cérebro (fire-and-forget; echoCancellation filtra do próximo turno).
    if (routing === 'jarvis') {
      const filler = THINK_FILLERS[Math.floor(Math.random() * THINK_FILLERS.length)];
      const cached = getThinkFillerCache().get(filler);
      if (cached) void playAudioBase64(cached.audioBase64, cached.format).catch(() => {});
    }

    const tTurn = Date.now();
    store.setStatus('transcribing');
    if (routing === 'jarvis' && isJarvisLiveEnabled()) {
      liveStatus('thinking');
    }
    const stt = await withTimeout(
      window.nexus.voice.transcribe({
        audioBase64: result.wavBase64,
        mime: 'audio/wav',
        sampleRate: result.sampleRate,
        // Modo JARVIS conversa em PT — transcreve cru, sem traduzir para EN.
        ...(routing === 'jarvis' ? { translate: false, language: 'pt' } : {}),
      }),
      TRANSCRIBE_DEADLINE_MS,
      'transcrição',
    );
    if (!stt.ok) {
      store.setError(stt.error);
      liveStatus('error', stt.error);
      return;
    }
    // Eco do próprio TTS captado pelo mic (detectado no main via janela do que
    // acabou de ser falado) — descarte silencioso, mesmo tratamento do ghost.
    if (stt.discarded === 'echo') {
      console.log(`[voice] eco do TTS descartado: "${stt.text}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    const tStt = Date.now() - tTurn;
    const transcript =
      activeCaptureReason === 'wake'
        ? stripWakeAckEcho(stt.text, personaUserName())
        : stt.text.trim();
    if (!transcript) {
      const reason =
        activeCaptureReason === 'wake' ? 'eco do wake/ack' : 'transcrição vazia';
      console.log(`[voice] ${reason} descartado: "${stt.text}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    // Whisper ALUCINA frases fixas em silêncio/ruído ("you", "thank you",
    // "obrigado por assistir"…). Elas passam o gate de RMS quando há um
    // sussurro — descarta antes de virar turno (a JARVIS falando sozinha).
    const inConversation =
      jarvisHistory.length > 0 && Date.now() - jarvisLastTurnAt <= JARVIS_MEMORY_MS;
    if (isDiscardableTranscript(transcript, { inConversation })) {
      console.log(`[voice] transcrição-lixo do Whisper descartada: "${transcript}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    store.setTranscript(transcript);
    console.log(`[voice] transcrito (${tStt}ms): "${transcript}"`);
    resetAutoReplyLoop();
    // Surface throttle/quota fallbacks instead of failing silently.
    store.setNote(stt.fallbackNote ?? null);

    if (routing === 'jarvis') {
      await runJarvisTurn(transcript, capture, busy);
      return;
    }

    store.setStatus('routing');
    const paneId = routePrompt(transcript);
    if (!paneId) {
      store.setError('No focused pane to route the prompt into.');
      return;
    }

    // Jarvis: capture the agent's reply, then speak a condensed summary. The
    // transcribed prompt is passed so its PTY echo is stripped before speaking.
    const reply = await captureResponse(paneId, transcript);
    if (reply.trim()) {
      store.setStatus('speaking');
      const spoken = await withTimeout(
        window.nexus.voice.speak({ text: reply }),
        SPEAK_DEADLINE_MS,
        'TTS',
      );
      if (spoken.ok) {
        if (spoken.mode === 'audio') await playAudioBase64(spoken.audioBase64, spoken.format);
        store.setSpoken(reply);
      } else {
        store.setError(spoken.error);
        return;
      }
    }
    store.setStatus('idle');
  } catch (err) {
    store.setError(errMsg(err));
    liveStatus('error', errMsg(err));
  } finally {
    busy.current = false;
  }
}

/**
 * Um turno da conversa com a JARVIS: fala transcrita → cérebro (main) →
 * executa a ação no app → fala a resposta → se ela terminou perguntando,
 * reabre a escuta sozinha (o loop "viva").
 */
async function runJarvisTurn(
  transcript: string,
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  const now = Date.now();
  if (now - jarvisLastTurnAt > JARVIS_MEMORY_MS) jarvisHistory = [];
  jarvisLastTurnAt = now;

  const { root, focusedPaneId } = useLayoutStore.getState();
  const panes = listPanes(root);
  const orchPaneId = findOrchestratorPane(root);
  const orchPane = panes.find((p) => p.id === orchPaneId) ?? null;
  const focusedPane = panes.find((p) => p.id === focusedPaneId) ?? null;
  const screen = currentScreenSnapshot();
  const context = {
    workspace: useWorkspaceStore.getState().current?.name ?? null,
    userName: personaUserName() || null,
    screen: screen.context,
    recents: useWorkspaceStore.getState().recents.map((r) => r.name).slice(0, 10),
    squads: useOrchStore.getState().squads.map((s) => s.name),
    panes: panes
      .map((p) => {
        const tag =
          p.id === orchPaneId
            ? '[orquestrador] '
            : p.kind === 'shell'
              ? '[shell] '
              : '[agente] ';
        return `${tag}${p.title}`;
      })
      .slice(0, 20),
    focusedPane: focusedPane?.title ?? null,
    focusedPaneKind: focusedPane?.kind ?? null,
    focusedPaneUrl: focusedPane?.browserUrl ?? null,
    orchestrator: orchPane?.title ?? null,
    missions: useOrchStore
      .getState()
      .missions.filter((m) => m.status !== 'done')
      .map((m) => `${m.title} (${m.status})`)
      .slice(0, 10),
  };

  store.setStatus('routing');
  const tBrain = Date.now();
  const reply = await withTimeout(
    window.nexus.voice.jarvis({
      transcript,
      context,
      history: jarvisHistory,
    }),
    BRAIN_DEADLINE_MS,
    'cérebro',
  );
  console.log(`[voice] cérebro: ${Date.now() - tBrain}ms`);
  jarvisHistory.push({ role: 'user', content: transcript });
  jarvisHistory.push({ role: 'assistant', content: reply.say });
  const maxTurns = isJarvisLiveEnabled()
    ? (useVoiceStore.getState().info?.jarvisLive.maxWindowTurns ?? 12)
    : 10;
  if (jarvisHistory.length > maxTurns * 2) {
    jarvisHistory = jarvisHistory.slice(-(maxTurns * 2));
  }

  const exec = await executeJarvisAction(reply, context);
  let sayText = exec.sayText;
  if (exec.expectReply !== undefined) reply.expectReply = exec.expectReply;
  const toolResult = exec.toolResult;

  if (toolResult && isJarvisLiveEnabled()) {
    window.nexus.voice.liveToolResult(toolResult);
  }

  if (!sayText.trim()) {
    store.setSpoken('');
    store.setStatus('idle');
    liveEndTurn();
    return;
  }

  store.setStatus('speaking');
  liveStatus('speaking');
  // Pipelining por sentença (LiveKit playbook): sintetiza e toca a PRIMEIRA
  // frase enquanto o resto ainda está sendo gerado — corta o time-to-first-audio.
  // Uma só chamada TTS em respostas curtas — duas frases = duas vozes/timbres.
  const split = sayText.length > 120 ? splitFirstSentence(sayText) : { first: sayText, rest: '' };
  const tTts = Date.now();
  const first = await withTimeout(
    window.nexus.voice.speak({ text: split.first, speakMode: 'full' }),
    SPEAK_DEADLINE_MS,
    'TTS',
  );
  console.log(`[voice] tts 1ª frase: ${Date.now() - tTts}ms`);
  if (!first.ok) {
    store.setError(first.error);
    return;
  }
  const restPromise =
    split.rest && first.mode === 'audio'
      ? window.nexus.voice.speak({ text: split.rest, speakMode: 'full' })
      : null;
  await playSpeakResult(first);
  if (split.rest) {
    const rest = await withTimeout(
      restPromise ?? window.nexus.voice.speak({ text: split.rest, speakMode: 'full' }),
      SPEAK_DEADLINE_MS,
      'TTS',
    );
    if (!rest.ok) {
      store.setError(rest.error);
      return;
    }
    await playSpeakResult(rest);
  }
  store.setSpoken(sayText);
  store.setStatus('idle');
  void window.nexus.voice.recordEcho(sayText);

  // Classic: só reabre escuta quando o cérebro pediu resposta de verdade.
  // jarvisLive.enabled no painel NÃO é full-duplex — reabrir sempre gerava loop
  // (TTS ecoando no mic → "não entendi" → TTS → …).
  const wantsReply = shouldReopenJarvisListening({
    expectReply: reply.expectReply === true,
    sayText,
    realtimeTurnActive,
    isRealtimeLive: isRealtimeLive(),
  });
  if (wantsReply) {
    busy.current = false;
    wakeMic.suppressWakeDetection(REPLY_LISTEN_DELAY_MS + 500);
    await delay(REPLY_LISTEN_DELAY_MS);
    noteAutoReplyOpened();
    void beginListening(capture, wakeAutoStop(capture, busy), 'reply');
  } else {
    liveEndTurn();
  }
}

/** Primeira sentença (mín. 12 chars) + resto — para o TTS pipelined. */
function splitFirstSentence(text: string): { first: string; rest: string } {
  const t = text.trim();
  const m = /[.!?…](\s|$)/.exec(t.slice(12));
  if (!m || m.index + 13 >= t.length) return { first: t, rest: '' };
  const cut = 12 + m.index + 1;
  return { first: t.slice(0, cut).trim(), rest: t.slice(cut).trim() };
}

/**
 * Inject the transcribed prompt into the target pane's PTY (same path as typing).
 * Returns the pane id used, or null when nothing is focused. Routing modes other
 * than 'focused-pane' currently resolve to the focused pane (orchestrator routing
 * arrives with the MCP squad work in a later phase).
 */
function routePrompt(text: string): string | null {
  const { focusedPaneId, root } = useLayoutStore.getState();
  const routing = useVoiceStore.getState().info?.routing ?? 'focused-pane';
  const targetPaneId =
    routing === 'orchestrator'
      ? findOrchestratorPane(root) ?? focusedPaneId
      : focusedPaneId;
  if (!targetPaneId) return null;
  const ok = writeToPane(targetPaneId, `${text}\n`);
  return ok ? targetPaneId : null;
}

function findOrchestratorPane(root: ReturnType<typeof useLayoutStore.getState>['root']): string | null {
  const panes = listPanes(root);
  const pane = panes.find(
    (p) => p.orchRequestId?.startsWith('squad-') || /(^|[ ·])orq\b/i.test(p.title),
  );
  return pane?.id ?? null;
}

/**
 * Accumulate the pane's PTY output after injection and resolve with the agent's
 * reply. End-of-turn is detected by three signals, strongest first:
 *   1. The pane returns from 'busy' → 'idle' (tracked by phase 2b via
 *      useSessionStateStore). This is the reliable signal for TUI agents like
 *      Claude Code / Codex that continuously redraw a spinner and so never fall
 *      quiet — pure silence detection would always hit the hard cap and speak a
 *      truncated dump.
 *   2. The PTY has been quiet for RESPONSE_QUIET_MS (non-agent panes that emit no
 *      idle/busy state events).
 *   3. RESPONSE_MAX_MS hard cap.
 * The captured buffer starts with the PTY echo of the injected prompt (plus
 * spinner); `promptEcho` is stripped so we speak the RESPONSE, not the command.
 */
function captureResponse(paneId: string, promptEcho: string): Promise<string> {
  return new Promise((resolve) => {
    const sessionId = getPaneSessionId(paneId);
    if (!sessionId) {
      resolve('');
      return;
    }
    let buffer = '';
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let sawBusy = false;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardCap);
      unsubData();
      unsubState();
      resolve(stripPromptEcho(buffer, promptEcho));
    };

    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, RESPONSE_QUIET_MS);
    };

    const unsubData = window.nexus.pty.onData(sessionId, (data) => {
      buffer += data;
      armQuiet();
    });
    // Strong end-of-turn signal: finish as soon as the pane goes back to 'idle'
    // after having been 'busy'. Falls back to the quiet timer for panes that
    // never report state (no cli-agent adapter tracking them).
    const unsubState = useSessionStateStore.subscribe((s) => {
      const state = s.paneStates.get(paneId);
      if (state === 'busy') sawBusy = true;
      else if (state === 'idle' && sawBusy) finish();
    });
    const hardCap = setTimeout(finish, RESPONSE_MAX_MS);
    armQuiet();
  });
}

/** Decode + play TTS audio bytes via Web Audio. */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
