import { useEffect, useRef } from 'react';
import { useVoiceStore } from './voice-store';
import { markVictory } from '../state/onboarding-store';
import { VoiceCapture } from './voice-capture';
import { classifyMicHealth, type MicHealth } from './wake-health';
import {
  STATUS_WATCHDOG_POLL_MS,
  statusWatchdogAction,
} from './status-watchdog';
import { micFrameToBase64 } from './live-audio';
import {
  isWakeAckOnlyTranscript,
  stripWakeAckEcho,
} from './transcript-filter';
import { onJarvisWakeRequest } from './manual-wake';
import { type JarvisCaptureReason } from './jarvis-reply-loop';
import {
  clearLocalAudioGate,
  isLocalAudioAudible,
  markLocalAudioPlaying,
  setLocalAudioWithholdUntil,
} from './live-local-audio-gate';
import { playAudioBase64, stopAllPlayback } from './voice-playback';
import {
  invalidateAckCacheIfPersonaChanged,
  playCachedWakeAck,
  playWakePrompt,
  warmAckCache,
  wakeGreetingText,
} from './voice-wake-ack';
import { voiceHudStatusFromLiveState } from './live-hud-state';
import type { AutoStopOptions } from './voice-capture';
import type {
  JarvisLiveTranscriptEvent,
  VoiceRuntimeInfo,
} from '../../shared/voice-ipc';
// Extracted modules
import {
  errMsg,
  liveStatus,
  liveContextText,
  sendLiveContextSnapshot,
  queueLiveContextRefresh,
  logVoiceEvent,
} from './voice-live-ipc';
import {
  openLiveAudioGate,
  playRealtimeAudioOut,
  queuePendingRealtimeAudioOut,
  resetPendingRealtimeAudioOut,
} from './voice-live-audio-out';
import {
  isJarvisLiveEnabled,
  isRealtimeLive,
  canAttemptRealtime,
  shouldStreamToRealtime,
  shouldSkipClassicWakeAck,
  shouldIgnoreLiveReWake,
} from './voice-realtime-gates';
import {
  wakeMic,
  livePlayer,
  setLivePlayer,
  realtimeTurnActive,
  setRealtimeTurnActive,
  suppressRealtimeAudioOut,
  setSuppressRealtimeAudioOut,
  setPendingLiveStartSettle,
  finishRealtimeCapture,
  setFinishRealtimeCapture,
  activeCaptureReason,
  setActiveCaptureReason,
  wakeOpenInProgress,
  setWakeOpenInProgress,
  pendingRealtimeAudioOut,
  realtimeTranscriptWaiter,
  turnExecution,
  realtimeAudioPlayedCounter,
  realtimeAudioSuppressedCounter,
  liveWakeGreetingInjectedAt,
  setLiveWakeGreetingInjectedAt,
  REALTIME_ACTION_BRIDGE_ENABLED,
  REALTIME_PROVIDER_AUDIO_ENABLED,
} from './voice-session-state';
import { personaUserName } from './jarvis-screen-context';
import { executeRealtimeToolCall } from './voice-realtime-tools';
import { finishAndProcess, type FinishAndProcessDeps } from './voice-finish-and-process';
import {
  liveWakeGreetingText,
  liveWakeInjectPrompt,
  shouldSendLiveWakeGreeting,
} from './live-wake-greeting';
import { cancelLiveFollowUp } from './live-followup';

/**
 * Jarvis voice pipeline. Mounted once from App.
 * Large sub-functions live in voice-{speak-pipeline,realtime-tools,run-jarvis-turn,finish-and-process}.ts
 */

const WAKE_ACK_SUPPRESS_MS = 8_000;
const WAKE_PREROLL_MS = 2_500;
const WAKE_SILENCE_MS = 700;
const WAKE_MIN_LISTEN_MS = 1_500;
const CLICK_WAKE_SILENCE_MS = 1_050;
const CLICK_WAKE_MIN_LISTEN_MS = 1_125;
const WAKE_MAX_MS = 15_000;
const CLICK_WAKE_MAX_MS = 22_000;
const PTT_HOLD_MAX_MS = 60_000;
/** Hold mic off the Live socket until greeting audio starts (or this ceiling).
 * Kept just above LIVE_WAKE_GREETING_SILENT_MS so the silent-timeout handler
 * releases the mic before the ceiling — 12s was far too long (user couldn't
 * speak their command for 12 seconds if Gemini didn't respond). */
const LIVE_WAKE_GREETING_MIC_HOLD_MS = 4_500;
/** Wait for Live audio after inject; on mute prefer silence (never Classic marin). */
const LIVE_WAKE_GREETING_SILENT_MS = 3_500;
/** After Live greeting audio starts, keep mic held this long (anti-echo of Olá). */
const LIVE_WAKE_GREETING_AUDIO_TAIL_MS = 1_800;
export const TRANSCRIBE_DEADLINE_MS = 60_000;
export const BRAIN_DEADLINE_MS = 35_000;
const MIC_SILENT_THRESHOLD_MS = 12_000;
const MIC_HEALTH_CHECK_MS = 5_000;

type WakeSource = 'voice' | 'click';

function isAckGatedCapture(reason: JarvisCaptureReason = activeCaptureReason): boolean {
  return reason === 'wake' || reason === 'click';
}

function commandFromRealtimeTranscript(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  if (isAckGatedCapture() && isWakeAckOnlyTranscript(raw, personaUserName())) return null;
  const transcript = isAckGatedCapture()
    ? stripWakeAckEcho(raw, personaUserName())
    : raw;
  return transcript.trim() || null;
}

function onRealtimeTranscriptForActionBridge(event: JarvisLiveTranscriptEvent): void {
  if (!realtimeTurnActive || event.role !== 'user' || !event.final) return;
  const text = commandFromRealtimeTranscript(event.text);
  if (!text) {
    if (isAckGatedCapture()) {
      console.log(`[voice] realtime wake/click só ack/eco: "${event.text.trim()}"`);
    }
    return;
  }
  if (realtimeTranscriptWaiter.deliver(text)) return;
  window.setTimeout(() => finishRealtimeCapture?.(), 80);
}

/** Está escutando por QUALQUER backend (mic quente do wake ou captura própria)? */
function isListening(capture: VoiceCapture | null): boolean {
  return Boolean(capture?.isCapturing() || wakeMic.isUtteranceActive());
}

/** Auto-stop padrão das capturas iniciadas por voz. */
function wakeAutoStop(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
  reason: 'wake' | 'click' = 'wake',
): AutoStopOptions {
  return {
    silenceMs: reason === 'click' ? CLICK_WAKE_SILENCE_MS : WAKE_SILENCE_MS,
    minListenMs: reason === 'click' ? CLICK_WAKE_MIN_LISTEN_MS : WAKE_MIN_LISTEN_MS,
    maxMs: reason === 'click' ? CLICK_WAKE_MAX_MS : WAKE_MAX_MS,
    onAutoStop: () => {
      if (isListening(capture)) void finishAndProcessFacade(capture, busy);
    },
  };
}

/** Façade that creates injected deps inline — avoids circular imports. */
function finishAndProcessFacade(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
): Promise<void> {
  const deps: FinishAndProcessDeps = {
    beginListening,
    isListening,
    wakeAutoStop,
    finishAndProcess: finishAndProcessFacade,
  };
  return finishAndProcess(capture, busy, deps);
}

/** Idempotent mount: HMR / remount must replace listeners, never stack them. */
let voiceControllerCleanup: (() => void) | null = null;

export function useVoiceController(): void {
  const capture = useRef<VoiceCapture | null>(null);
  const busy = useRef(false);
  const narratingRef = useRef(false);

  useEffect(() => {
    // Drop any prior subscription (HMR leaves preload Sets with stale cbs →
    // every audio/transcript event fires twice → mute races + double tools).
    voiceControllerCleanup?.();
    voiceControllerCleanup = null;

    capture.current = new VoiceCapture();
    capture.current.onLevel = (level) => useVoiceStore.getState().setLevel(level);
    wakeMic.onLevel = (level) => useVoiceStore.getState().setLevel(level);
    const store = useVoiceStore.getState();

    const handleWake = async (source: WakeSource) => {
      if (wakeOpenInProgress) return;
      setWakeOpenInProgress(true);
      try {
        markVictory('voiceEnabled');
        stopAllPlayback();
        if (wakeMic.isUtteranceActive()) wakeMic.cancelUtterance();
        if (capture.current?.isCapturing()) {
          try {
            await capture.current.stop();
          } catch {
            // segue
          }
        }
        busy.current = true;
        useVoiceStore.getState().setStatus('idle');
        useVoiceStore.getState().setError(null);

        const skipClassicAck = shouldSkipClassicWakeAck();

        // SYNC RESET: tear down the ENTIRE previous Live session before anything.
        // Kills zombie sockets, stops mic streaming, clears pending audio.
        cancelLiveFollowUp();
        setPendingLiveStartSettle(null);
        setRealtimeTurnActive(false);
        setLiveWakeGreetingInjectedAt(0);
        setSuppressRealtimeAudioOut(false);
        resetPendingRealtimeAudioOut();
        clearLocalAudioGate();
        livePlayer?.stop();
        realtimeTranscriptWaiter.supersede();
        if (skipClassicAck) {
          await window.nexus.voice.liveHardTeardown().catch(() => {});
          logVoiceEvent('info', 'jarvis.wakeSyncReset', 'hard teardown before fresh wake', { source });
        } else {
          void window.nexus.voice.liveInterrupt('wake-ack').catch(() => {});
        }

        let wakePreRoll =
          source === 'voice' ? wakeMic.snapshotPreRoll(WAKE_PREROLL_MS) : [];
        const ack = wakeGreetingText(personaUserName());
        if (!skipClassicAck) {
          void window.nexus.voice.recordEcho(ack).catch(() => {});
        }
        wakeMic.suppressWakeDetection(
          skipClassicAck ? 1_200 : WAKE_ACK_SUPPRESS_MS,
        );

        if (source === 'click') {
          if (!skipClassicAck) {
            await playWakePrompt(ack).catch(() => playCachedWakeAck(personaUserName()));
            wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);
          }
          await beginListening(
            capture.current!,
            wakeAutoStop(capture.current!, busy, 'click'),
            'click',
            [],
            busy,
          );
          return;
        }
        const listenPromise = beginListening(
          capture.current!,
          wakeAutoStop(capture.current!, busy, 'wake'),
          'wake',
          wakePreRoll,
          busy,
        );
        if (!skipClassicAck) {
          await playWakePrompt(ack).catch(() => playCachedWakeAck(personaUserName()));
          wakeMic.suppressWakeDetection(WAKE_ACK_SUPPRESS_MS);
        }
        await listenPromise;
      } catch (err) {
        busy.current = false;
        useVoiceStore.getState().setError(`Wake falhou: ${errMsg(err)}`);
      } finally {
        setWakeOpenInProgress(false);
      }
    };

    const onWake = (source: WakeSource = 'voice') => {
      if (wakeOpenInProgress) {
        console.log('[voice] wake ignorado (turno em andamento)');
        return;
      }
      const voiceStatus = useVoiceStore.getState().status;
      // Voice re-wake during Live reply → suppress+burst flush (stutter) and
      // reopens mic into ambient noise. Click-wake still barges in on purpose.
      if (source === 'voice' && shouldIgnoreLiveReWake({ status: voiceStatus })) {
        console.log('[voice] wake ignorado (Live falando / áudio pendente)');
        logVoiceEvent('info', 'jarvis.wakeIgnoredLiveBusy', 'wake ignorado — Live em resposta', {
          status: voiceStatus,
          remainingMs: livePlayer?.remainingMs() ?? 0,
          pendingChunks: pendingRealtimeAudioOut.length,
        });
        return;
      }
      if (
        busy.current &&
        !['idle', 'listening', 'speaking', 'transcribing', 'routing'].includes(voiceStatus)
      ) {
        console.log('[voice] wake ignorado (pipeline ocupado)');
        return;
      }
      void handleWake(source);
    };

    wakeMic.onDied = (reason) => {
      useVoiceStore.getState().setNote(`Mic do wake rearmarando (${reason}) a cada 30s…`);
    };
    wakeMic.onRecovered = () => {
      useVoiceStore.getState().setNote('mic do wake reconectado');
    };

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
      const health = classifyMicHealth(perm, wakeMic.getSilentMs(), MIC_SILENT_THRESHOLD_MS);
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

    // Watchdog de status preso (C1b): força idle se uma fase passar do
    // deadline da etapa — STT falho não pode deixar 'transcribing' eterno.
    let watchedStatus = useVoiceStore.getState().status;
    let watchedStatusAt = Date.now();
    const unsubStatusWatchdog = useVoiceStore.subscribe((s) => {
      if (s.status !== watchedStatus) {
        watchedStatus = s.status;
        watchedStatusAt = Date.now();
      }
    });
    const statusWatchdogTimer = setInterval(() => {
      // Fala longa do Live é progresso, não travamento: enquanto há áudio
      // tocando ou pendente, o relógio do watchdog re-arma (senão uma resposta
      // contínua de 90s+ dispararia force-idle no meio da frase).
      if (
        watchedStatus === 'speaking' &&
        ((livePlayer?.remainingMs() ?? 0) > 0 || pendingRealtimeAudioOut.length > 0)
      ) {
        watchedStatusAt = Date.now();
        return;
      }

      const stuckMs = Date.now() - watchedStatusAt;
      if (statusWatchdogAction(watchedStatus, stuckMs) === 'force-idle') {
        logVoiceEvent('warn', 'voice.statusWatchdog', 'status preso — forçando idle', {
          status: watchedStatus,
          stuckMs,
        });
        busy.current = false;
        useVoiceStore.getState().setStatus('idle');
      }
    }, STATUS_WATCHDOG_POLL_MS);

    const syncWakeWord = (info: VoiceRuntimeInfo) => {
      if (info.enabled && info.wakeWordEnabled) {
        invalidateAckCacheIfPersonaChanged(info);
        if (!canAttemptRealtime(info)) {
          warmAckCache(info.persona.userName ?? '');
        }
        void wakeMic.start().catch((err) => {
          useVoiceStore.getState().setError(`Wake word indisponível: ${errMsg(err)}`);
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
      const hudStatus = voiceHudStatusFromLiveState(state, isListening(capture.current));
      if (hudStatus) useVoiceStore.getState().setStatus(hudStatus);
      if (state.status === 'error' && state.error) {
        useVoiceStore.getState().setNote(state.error);
      }
    });
    const unsubLiveTranscript = window.nexus.voice.onLiveTranscript((event) => {
      useVoiceStore.getState().addLiveTranscript(event);
      if (
        event.role === 'assistant' &&
        event.final &&
        event.text.trim() &&
        !suppressRealtimeAudioOut
      ) {
        useVoiceStore.getState().setSpoken(event.text.trim());
        void window.nexus.voice.recordEcho(event.text).catch(() => {});
      }
      onRealtimeTranscriptForActionBridge(event);
    });
    const unsubTranscriptAppend = window.nexus.voice.onTranscriptAppend((event) => {
      useVoiceStore.getState().addTranscriptAppend(event);
    });
    const unsubLiveToolCall = window.nexus.voice.onLiveToolCall((event) => {
      useVoiceStore.getState().setLiveTool(event);
      if (event.source === 'realtime') {
        void executeRealtimeToolCall(event);
      }
    });
    const unsubLiveToolResult = window.nexus.voice.onLiveToolResult((event) => {
      useVoiceStore.getState().setLiveTool(event);
    });
    const unsubLiveInterrupted = window.nexus.voice.onLiveInterrupted((event) => {
      useVoiceStore.getState().setLiveInterrupted(event);
      livePlayer?.stop();
    });
    const unsubLiveAudio = window.nexus.voice.onLiveAudioOut((b64) => {
      if (suppressRealtimeAudioOut) {
        queuePendingRealtimeAudioOut(b64);
        return;
      }
      playRealtimeAudioOut(b64);
    });
    // FIX E (mic frame tap): shouldStreamToRealtime now includes 'reply' reason.
    wakeMic.setUtteranceFrameTap((frame, sampleRate) => {
      if (shouldStreamToRealtime() && !isLocalAudioAudible(Date.now())) {
        window.nexus.voice.liveMicIn(micFrameToBase64(frame, sampleRate));
      }
    });

    const onStart = () => {
      if (busy.current) return;
      const holdGuard: AutoStopOptions = {
        silenceMs: PTT_HOLD_MAX_MS,
        maxMs: PTT_HOLD_MAX_MS,
        onAutoStop: () => {
          if (isListening(capture.current)) void finishAndProcessFacade(capture.current!, busy);
        },
      };
      void beginListening(capture.current!, holdGuard, 'ptt', undefined, busy);
    };
    const onStop = () => {
      if (!isListening(capture.current)) return;
      void finishAndProcessFacade(capture.current!, busy);
    };
    const onToggle = () => {
      if (isListening(capture.current)) {
        onStop();
      } else {
        stopAllPlayback();
        if (busy.current && useVoiceStore.getState().status === 'speaking') {
          busy.current = false;
        }
        void beginListening(capture.current!, undefined, 'manual', undefined, busy);
      }
    };

    const unsubStart = window.nexus.voice.onPttStart(onStart);
    const unsubStop = window.nexus.voice.onPttStop(onStop);
    const unsubToggle = window.nexus.voice.onPttToggle(onToggle);
    const unsubWake = window.nexus.voice.onWakeDetected(() => onWake('voice'));
    const unsubClickWake = onJarvisWakeRequest(() => onWake('click'));
    const unsubNarrate = window.nexus.voice.onNarrate(({ text }) => {
      const status = useVoiceStore.getState().status;
      if (status !== 'idle' || narratingRef.current) {
        console.log('[voice] narração pulada (ocupado):', text.slice(0, 60));
        return;
      }
      narratingRef.current = true;
      const storeNarrate = useVoiceStore.getState();
      storeNarrate.setStatus('speaking');
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

    const cleanup = () => {
      clearInterval(micHealthTimer);
      clearInterval(statusWatchdogTimer);
      unsubStatusWatchdog();
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
      setLivePlayer(null);
      wakeMic.stop();
    };
    voiceControllerCleanup = cleanup;
    return () => {
      if (voiceControllerCleanup === cleanup) voiceControllerCleanup = null;
      cleanup();
    };
  }, []);
}

async function beginListening(
  capture: VoiceCapture,
  autoStop?: AutoStopOptions,
  reason: JarvisCaptureReason = 'manual',
  preRollSeed?: Float32Array[],
  busy?: React.MutableRefObject<boolean>,
): Promise<void> {
  const store = useVoiceStore.getState();
  try {
    store.setNote(null);
    realtimeTranscriptWaiter.resetQueued();
    resetPendingRealtimeAudioOut();
    realtimeAudioPlayedCounter.reset();
    realtimeAudioSuppressedCounter.reset();
    setRealtimeTurnActive(false);
    turnExecution.beginTurn();
    setActiveCaptureReason(reason);
    setFinishRealtimeCapture(
      busy
        ? () => {
            if (isListening(capture)) void finishAndProcessFacade(capture, busy);
          }
        : null,
    );

    // FIX E: reply stays hot — no liveInterrupt, keep audio flowing.
    // Always open the gate via openLiveAudioGate so any held chunks flush.
    if (reason === 'reply') {
      openLiveAudioGate();
      // Don't interrupt — session stays engaged for follow-up streaming.
    } else if (isAckGatedCapture(reason)) {
      // FIX F: skip interrupt if Live owns the voice (Classic ack not playing).
      if (!shouldSkipClassicWakeAck()) {
        setSuppressRealtimeAudioOut(true);
        void window.nexus.voice.liveInterrupt('wake-listen').catch(() => {});
      } else {
        openLiveAudioGate();
      }
    } else {
      openLiveAudioGate();
    }

    // FIX E: include 'reply' in allowRealtimeBridge so follow-up streams live.
    const allowRealtimeBridge =
      REALTIME_PROVIDER_AUDIO_ENABLED &&
      REALTIME_ACTION_BRIDGE_ENABLED &&
      isJarvisLiveEnabled();
    setPendingLiveStartSettle(null);
    if (allowRealtimeBridge) {
      const info = useVoiceStore.getState().info;
      if (reason === 'reply' && isRealtimeLive()) {
        // FIX E: session is already hot — re-arm mic streaming without liveStart.
        setRealtimeTurnActive(canAttemptRealtime(info));
        queueLiveContextRefresh();
      } else {
        setRealtimeTurnActive(canAttemptRealtime(info));
        // Pre-hold mic BEFORE liveStart settles: beginUtterance otherwise streams
        // ambient/pre-roll into the socket and races the [wake] Olá inject
        // (RESTART_REGRESSION_RECOVERY: micFrames 1..76 same ms as liveWakeGreeting).
        const willInjectWakeGreeting = shouldSendLiveWakeGreeting(
          reason,
          shouldSkipClassicWakeAck(),
        );
        if (willInjectWakeGreeting) {
          markLocalAudioPlaying(LIVE_WAKE_GREETING_MIC_HOLD_MS, Date.now());
          wakeMic.suppressWakeDetection(LIVE_WAKE_GREETING_MIC_HOLD_MS);
        }
        const liveContext = liveContextText();
        setPendingLiveStartSettle(
          window.nexus.voice
            .liveStart({ reason, forceFresh: willInjectWakeGreeting })
            .then((state) => {
              store.setLiveState(state);
              if (!state.realtimeReady) {
                setRealtimeTurnActive(false);
                if (willInjectWakeGreeting) clearLocalAudioGate();
              }
              if (state.realtimeReady) {
                const willGreet = shouldSendLiveWakeGreeting(reason, shouldSkipClassicWakeAck());
                if (!willGreet) {
                  window.nexus.voice.liveContextIn(liveContext);
                  window.setTimeout(sendLiveContextSnapshot, 120);
                }
                if (willGreet) {
                  const greeting = liveWakeGreetingText(personaUserName());
                  const prompt = liveWakeInjectPrompt(personaUserName());
                  const injectedAt = Date.now();
                  const playedBefore = realtimeAudioPlayedCounter.total;
                  setLiveWakeGreetingInjectedAt(injectedAt);
                  markLocalAudioPlaying(LIVE_WAKE_GREETING_MIC_HOLD_MS, injectedAt);
                  wakeMic.suppressWakeDetection(LIVE_WAKE_GREETING_MIC_HOLD_MS);
                  logVoiceEvent('info', 'jarvis.liveWakeGreeting', 'Gemini Live wake greeting (fresh socket)', {
                    reason,
                    greeting,
                    mode: 'inject',
                    micHoldMs: LIVE_WAKE_GREETING_MIC_HOLD_MS,
                  });
                  window.nexus.voice.liveContextIn(prompt);
                  window.setTimeout(() => {
                    window.nexus.voice.liveContextIn(liveContext);
                    sendLiveContextSnapshot();
                  }, 800);
                  const releasePoll = window.setInterval(() => {
                    if (liveWakeGreetingInjectedAt !== injectedAt) {
                      window.clearInterval(releasePoll);
                      return;
                    }
                    if (realtimeAudioPlayedCounter.total <= playedBefore) return;
                    window.clearInterval(releasePoll);
                    const reopenAt = Date.now() + LIVE_WAKE_GREETING_AUDIO_TAIL_MS;
                    setLocalAudioWithholdUntil(reopenAt);
                    wakeMic.suppressWakeDetection(LIVE_WAKE_GREETING_AUDIO_TAIL_MS);
                    logVoiceEvent('info', 'jarvis.liveWakeGreetingAudio', 'Live greeting audio — mic hold → tail', {
                      tailMs: LIVE_WAKE_GREETING_AUDIO_TAIL_MS,
                      rttMs: Date.now() - injectedAt,
                    });
                  }, 50);
                  window.setTimeout(() => window.clearInterval(releasePoll), LIVE_WAKE_GREETING_MIC_HOLD_MS + 500);
                  // Single retry: if silent after timeout, ONE hard rebuild
                  window.setTimeout(() => {
                    if (liveWakeGreetingInjectedAt !== injectedAt) return;
                    const played = realtimeAudioPlayedCounter.total;
                    const remaining = livePlayer?.remainingMs() ?? 0;
                    const pending = pendingRealtimeAudioOut.length;
                    if (played > playedBefore || remaining > 80 || pending > 0) return;
                    logVoiceEvent(
                      'warn',
                      'jarvis.liveWakeGreetingSilent',
                      'Live mudo após inject — hard rebuild (single retry)',
                      { waitedMs: LIVE_WAKE_GREETING_SILENT_MS, greeting },
                    );
                    void window.nexus.voice
                      .liveHardRebuild()
                      .then((rebuildState) => {
                        store.setLiveState(rebuildState);
                        if (!rebuildState.realtimeReady) {
                          clearLocalAudioGate();
                          return;
                        }
                        const hardAt = Date.now();
                        setLiveWakeGreetingInjectedAt(hardAt);
                        markLocalAudioPlaying(LIVE_WAKE_GREETING_MIC_HOLD_MS, hardAt);
                        wakeMic.suppressWakeDetection(LIVE_WAKE_GREETING_MIC_HOLD_MS);
                        logVoiceEvent('info', 'jarvis.liveWakeHardRebuildInject', 're-inject [wake] após hard rebuild', {
                          greeting,
                        });
                        window.nexus.voice.liveContextIn(prompt);
                      })
                      .catch(() => clearLocalAudioGate());
                  }, LIVE_WAKE_GREETING_SILENT_MS);
                } else if (willInjectWakeGreeting) {
                  clearLocalAudioGate();
                }
              }
            })
            .catch((err) => {
              setRealtimeTurnActive(false);
              if (willInjectWakeGreeting) clearLocalAudioGate();
              console.warn('[voice] liveStart falhou (classic segue):', errMsg(err));
            }),
        );
      }
    }

    if (wakeMic.isRunning()) {
      wakeMic.beginUtterance(
        autoStop,
        reason === 'wake' ? WAKE_PREROLL_MS : 0,
        preRollSeed,
      );
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
