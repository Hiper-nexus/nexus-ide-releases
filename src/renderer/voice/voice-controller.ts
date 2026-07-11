import { useEffect, useRef } from 'react';
import { useVoiceStore } from './voice-store';
import { markVictory } from '../state/onboarding-store';
import { VoiceCapture } from './voice-capture';
import type { PassiveWakeUtterance } from './wake-mic';
import { classifyMicHealth, type MicHealth } from './wake-health';
import {
  STATUS_WATCHDOG_POLL_MS,
  speakingHasAudioProgress,
  statusWatchdogAction,
} from './status-watchdog';
import { micFrameToBase64 } from './live-audio';
import { shouldPublishVoiceLevel } from './voice-level';
import {
  isWakeAckOnlyTranscript,
  stripWakeAckEcho,
} from './transcript-filter';
import { onJarvisWakeRequest } from './manual-wake';
import { type JarvisCaptureReason } from './jarvis-reply-loop';
import {
  clearLocalAudioGate,
  isLocalAudioAudible,
} from './live-local-audio-gate';
import { playAudioBase64, stopAllPlayback } from './voice-playback';
import { isResponseMuted } from './response-output-gate';
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
  shouldReserveWakeForRealtime,
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
  setLastRealtimeNativeToolCallId,
  REALTIME_ACTION_BRIDGE_ENABLED,
  REALTIME_PROVIDER_AUDIO_ENABLED,
} from './voice-session-state';
import { personaUserName } from './jarvis-screen-context';
import { executeRealtimeToolCall } from './voice-realtime-tools';
import { cancelRealtimeToolExecution } from './realtime-tool-execution';
import { finishAndProcess, type FinishAndProcessDeps } from './voice-finish-and-process';
import { cancelLiveFollowUp, notifyLiveToolTurnComplete } from './live-followup';
import {
  markLiveMicFrameOffered,
  resetOfferedLiveMicFramesThisTurn,
} from './live-mute-rescue';
import { NarrationQueue } from './narration-queue';
import { matchPassiveWakeWord } from './passive-wake-matcher';
import { PassiveWakeDeadline } from './passive-wake-deadline';
import { pttStartAction } from './ptt-barge-in';
import { shouldOfferLiveMicFrame } from './live-mic-offer-gate';

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
// After a Live response, a person naturally needs a moment to formulate the
// next request. Keep the warm Gemini turn open long enough to feel conversational
// without leaving the mic in an indefinite ambient-capture state.
const REPLY_MAX_LISTEN_MS = 22_000;
export const TRANSCRIBE_DEADLINE_MS = 60_000;
export const BRAIN_DEADLINE_MS = 35_000;
const MIC_SILENT_THRESHOLD_MS = 12_000;
const MIC_HEALTH_CHECK_MS = 5_000;
/** Deadline curto: fallback textual só serve se continuar parecendo um wake. */
const PASSIVE_WAKE_STT_BUDGET_MS = 3_500;
const PASSIVE_WAKE_RENDERER_DEADLINE_MS = PASSIVE_WAKE_STT_BUDGET_MS + 500;

type WakeSource = 'voice' | 'voice-barge' | 'click';

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
  const activeTurnId = String(turnExecution.currentToken);
  if (event.turnId && event.turnId !== activeTurnId) {
    logVoiceEvent('info', 'jarvis.staleRealtimeTranscript', 'final antigo ignorado', {
      turnId: event.turnId,
      activeTurnId,
    });
    return;
  }
  const text = commandFromRealtimeTranscript(event.text);
  if (!text) {
    if (isAckGatedCapture()) {
      console.log(`[voice] realtime wake/click só ack/eco: "${event.text.trim()}"`);
    }
    return;
  }
  if (realtimeTranscriptWaiter.deliver(text, event.turnId)) return;
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
  const baseMinListenMs =
    reason === 'click' ? CLICK_WAKE_MIN_LISTEN_MS : WAKE_MIN_LISTEN_MS;
  const minListenMs = baseMinListenMs;
  return {
    silenceMs: reason === 'click' ? CLICK_WAKE_SILENCE_MS : WAKE_SILENCE_MS,
    minListenMs,
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

  useEffect(() => {
    // Drop any prior subscription (HMR leaves preload Sets with stale cbs →
    // every audio/transcript event fires twice → mute races + double tools).
    voiceControllerCleanup?.();
    voiceControllerCleanup = null;

    capture.current = new VoiceCapture();
    const publishVoiceLevel = (level: number) => {
      const current = useVoiceStore.getState();
      if (shouldPublishVoiceLevel(current.status, level, current.level)) {
        current.setLevel(level);
      }
    };
    capture.current.onLevel = publishVoiceLevel;
    wakeMic.onLevel = publishVoiceLevel;
    const streamLiveMicFrame = (frame: Float32Array, sampleRate: number) => {
      if (
        shouldOfferLiveMicFrame({
          realtimeActive: shouldStreamToRealtime(),
          localAudioAudible: isLocalAudioAudible(Date.now()),
          providerPlaybackRemainingMs: livePlayer?.remainingMs() ?? 0,
          status: useVoiceStore.getState().status,
        })
      ) {
        window.nexus.voice.liveMicIn(micFrameToBase64(frame, sampleRate));
        // Renderer-side safety signal: zero means no IPC frame was even offered.
        // A positive count is not proof the provider accepted it; that path
        // degrades to Classic instead of risking a duplicate realtime replay.
        markLiveMicFrameOffered();
      }
    };
    capture.current.onFrame = streamLiveMicFrame;
    const store = useVoiceStore.getState();
    const passiveWakeDeadline = new PassiveWakeDeadline(PASSIVE_WAKE_RENDERER_DEADLINE_MS);

    const handleWake = async (source: WakeSource, preRollSeed?: Float32Array[]) => {
      if (wakeOpenInProgress) return;
      setWakeOpenInProgress(true);
      passiveWakeDeadline.invalidate();
      try {
        markVictory('voiceEnabled');
        stopAllPlayback();
        wakeMic.cancelPassiveWake();
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

        // Gemini gets the first audible word even on a cold socket.  Otherwise
        // the Classic OpenAI acknowledgement leaks into the live mic turn.
        const skipClassicAck = shouldReserveWakeForRealtime();

        // Turn reset: cancel only the in-flight response/capture state. The
        // healthy Gemini socket remains warm across wakes and follow-ups.
        cancelLiveFollowUp();
        setPendingLiveStartSettle(null);
        setRealtimeTurnActive(false);
        setSuppressRealtimeAudioOut(false);
        resetPendingRealtimeAudioOut();
        clearLocalAudioGate();
        livePlayer?.stop();
        realtimeTranscriptWaiter.supersede();
        await window.nexus.voice.liveInterrupt('wake-barge-in').catch(() => {});
        logVoiceEvent('info', 'jarvis.wakeTurnReset', 'wake reutilizando sessão Live saudável', {
          source,
          realtime: skipClassicAck,
        });

        const wakePreRoll =
          source !== 'click'
            ? preRollSeed?.map((frame) => Float32Array.from(frame)) ??
              wakeMic.snapshotPreRoll(WAKE_PREROLL_MS)
            : [];
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

    const onWake = (source: WakeSource = 'voice', preRollSeed?: Float32Array[]) => {
      if (wakeOpenInProgress) {
        console.log('[voice] wake ignorado (turno em andamento)');
        return;
      }
      const voiceStatus = useVoiceStore.getState().status;
      // Barge-in while she speaks is intentional full-duplex (voice → voice-barge).
      // Only ignore in fragile gaps (routing / suppressed burst) via the gate.
      if (
        (source === 'voice' || source === 'voice-barge') &&
        shouldIgnoreLiveReWake({ status: voiceStatus })
      ) {
        console.log('[voice] wake ignorado (Live em gap frágil)');
        logVoiceEvent('info', 'jarvis.wakeIgnoredLiveBusy', 'wake ignorado — Live em gap frágil', {
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
      const bargeSource: WakeSource =
        voiceStatus === 'speaking' && source === 'voice' ? 'voice-barge' : source;
      void handleWake(bargeSource, preRollSeed);
    };

    const handlePassiveWake = async (utterance: PassiveWakeUtterance): Promise<void> => {
      if (passiveWakeDeadline.isChecking() || wakeOpenInProgress) return;
      const info = useVoiceStore.getState().info;
      if (!info?.enabled || !info.wakeWordEnabled || info.routing !== 'jarvis') return;
      const voiceStatus = useVoiceStore.getState().status;
      // Live já está escutando comando (follow-up): NÃO re-acordar nem roubar o mic.
      // Exigir "Jarvis" de novo quebrava a sequência (logs: "inicia a missao" → miss).
      if (voiceStatus === 'listening' || voiceStatus === 'transcribing') {
        logVoiceEvent('info', 'wake.passiveSkippedLiveListening', 'passivo ignorado — Live já escuta', {
          status: voiceStatus,
        });
        return;
      }
      const isVerifiedBargeCandidate = voiceStatus === 'speaking';
      if (
        shouldIgnoreLiveReWake({ status: voiceStatus }) &&
        !isVerifiedBargeCandidate
      ) {
        logVoiceEvent('info', 'wake.passiveSkippedLiveBusy', 'checagem passiva pulada durante áudio Live', {
          status: voiceStatus,
        });
        return;
      }

      const startedAt = Date.now();
      logVoiceEvent('info', 'wake.passiveChecking', 'checando frase curta via STT', {
        durationSec: Number(utterance.durationSec.toFixed(2)),
        rawSpeechMs: Math.round(utterance.rawSpeechMs),
      });
      try {
        const request = await passiveWakeDeadline.run(() =>
          window.nexus.voice.transcribe({
            audioBase64: utterance.wavBase64,
            mime: 'audio/wav',
            sampleRate: utterance.sampleRate,
            translate: false,
            language: 'pt',
            purpose: 'passive-wake',
            passiveWakeWord: info.persona.assistantName,
            budgetMs: PASSIVE_WAKE_STT_BUDGET_MS,
          }),
        );
        const latencyMs = Date.now() - startedAt;
        if (request.kind === 'timeout') {
          logVoiceEvent('warn', 'wake.passiveSttTimeout', 'STT passivo excedeu deadline local', {
            latencyMs,
          });
          return;
        }
        if (request.kind !== 'completed') return;
        const result = request.value;
        if (!result.ok) {
          logVoiceEvent('warn', 'wake.passiveSttFail', 'STT passivo não concluiu', {
            latencyMs,
            stalled: result.stalled ?? false,
            providers: result.attempts.map((attempt) => attempt.provider),
          });
          return;
        }
        if (result.discarded === 'echo') {
          logVoiceEvent('info', 'wake.passiveEchoDiscarded', 'frase passiva era eco do app', {
            latencyMs,
            provider: result.provider,
          });
          return;
        }

        const latestInfo = useVoiceStore.getState().info;
        if (
          !latestInfo?.enabled ||
          !latestInfo.wakeWordEnabled ||
          latestInfo.routing !== 'jarvis'
        ) {
          return;
        }
        const match = matchPassiveWakeWord(result.text, latestInfo.persona.assistantName);
        if (!match) {
          // Nunca persista a frase; só um fingerprint seguro (tokens normalizados
          // truncados) para diagnosticar miss sem gravar conversa ambiente.
          const tokens = result.text
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 4)
            .map((t) =>
              t
                .toLocaleLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '')
                .slice(0, 6),
            );
          logVoiceEvent('info', 'wake.passiveMiss', 'STT não confirmou o nome da Jarvis', {
            latencyMs,
            provider: result.provider,
            tokenCount: result.text.trim().split(/\s+/).filter(Boolean).length,
            fingerprint: tokens.join('|'),
            charLen: result.text.trim().length,
          });
          return;
        }

        logVoiceEvent('info', 'wake.passiveDetected', 'wake textual confirmado', {
          latencyMs,
          provider: result.provider,
          commandWords: match.command ? match.command.split(/\s+/).length : 0,
        });
        onWake(
          isVerifiedBargeCandidate ? 'voice-barge' : 'voice',
          utterance.preRoll,
        );
      } catch (error) {
        logVoiceEvent('warn', 'wake.passiveSttError', 'falha no STT passivo', {
          latencyMs: Date.now() - startedAt,
          error: errMsg(error),
        });
      }
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
      const health = classifyMicHealth(perm, wakeMic.getSilentMs(), MIC_SILENT_THRESHOLD_MS, {
        zeroMs: wakeMic.getZeroMs(),
      });
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
      // Fala longa (Live OU clássica) é progresso, não travamento: enquanto há
      // áudio tocando/pendente o relógio re-arma (senão uma resposta contínua
      // de 90s+ dispararia force-idle no meio da frase). Follow-up 5: o TTS
      // clássico conta via isLocalAudioAudible.
      if (
        watchedStatus === 'speaking' &&
        speakingHasAudioProgress({
          liveRemainingMs: livePlayer?.remainingMs() ?? 0,
          pendingLiveChunks: pendingRealtimeAudioOut.length,
          localAudioAudible: isLocalAudioAudible(Date.now()),
        })
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
      const shouldUsePassiveWake =
        info.enabled && info.wakeWordEnabled && info.routing === 'jarvis';
      wakeMic.onPassiveUtterance = shouldUsePassiveWake
        ? (utterance) => {
            void handlePassiveWake(utterance);
          }
        : null;
      if (!shouldUsePassiveWake) wakeMic.cancelPassiveWake();
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
    const unsubLiveToolCancelled = window.nexus.voice.onLiveToolCancelled((event) => {
      const result = cancelRealtimeToolExecution(event);
      logVoiceEvent('warn', 'jarvis.realtimeActionCancelReceived', event.summary, {
        callId: event.callId,
        reason: event.reason,
        known: result.known,
        effectMayHaveCommitted: result.effectMayHaveCommitted,
      });
    });
    const unsubLiveToolResult = window.nexus.voice.onLiveToolResult((event) => {
      useVoiceStore.getState().setLiveTool(event);
    });
    const unsubLiveToolTurnComplete = window.nexus.voice.onLiveToolTurnComplete((event) => {
      notifyLiveToolTurnComplete(event);
    });
    const unsubLiveInterrupted = window.nexus.voice.onLiveInterrupted((event) => {
      useVoiceStore.getState().setLiveInterrupted(event);
      livePlayer?.stop();
    });
    const unsubLiveAudio = window.nexus.voice.onLiveAudioOut((event) => {
      if (suppressRealtimeAudioOut) {
        queuePendingRealtimeAudioOut(event);
        return;
      }
      playRealtimeAudioOut(event);
    });
    // Both capture paths must feed Live. VoiceCapture is used when wake word is
    // disabled; WakeMic owns the hot stream when wake word is enabled.
    wakeMic.setUtteranceFrameTap(streamLiveMicFrame);

    const narrationQueue = new NarrationQueue({
      canPlay: () =>
        useVoiceStore.getState().status === 'idle' && !isListening(capture.current),
      play: async (text) => {
        if (isResponseMuted()) return;
        const storeNarrate = useVoiceStore.getState();
        storeNarrate.setStatus('speaking');
        stopAllPlayback();
        try {
          const spoken = await window.nexus.voice.speak({ text, speakMode: 'full' });
          if (spoken.ok && spoken.mode === 'audio') {
            await playAudioBase64(spoken.audioBase64, spoken.format);
          }
        } finally {
          if (useVoiceStore.getState().status === 'speaking') {
            useVoiceStore.getState().setStatus('idle');
          }
        }
      },
      onError: (error) => console.warn('[voice] narração falhou:', error),
    });
    const unsubNarrationState = useVoiceStore.subscribe((state) => {
      if (state.status === 'idle') narrationQueue.kick();
    });

    const onStart = () => {
      const action = pttStartAction({
        isListening: isListening(capture.current),
        isBusy: busy.current,
        status: useVoiceStore.getState().status,
      });
      if (action === 'ignore') return;

      if (action === 'barge-in') {
        // PTT is an explicit gesture, unlike passive wake. Cut both local and
        // Live output first, then immediately use the existing explicit-capture
        // path. WakeMic's beginUtterance keeps passive detection disabled while
        // this hold capture is active.
        cancelLiveFollowUp();
        wakeMic.cancelPassiveWake();
        realtimeTranscriptWaiter.supersede();
        setPendingLiveStartSettle(null);
        setRealtimeTurnActive(false);
        setSuppressRealtimeAudioOut(true);
        resetPendingRealtimeAudioOut();
        clearLocalAudioGate();
        livePlayer?.stop();
        stopAllPlayback('ptt-barge-in');
        busy.current = false;
        useVoiceStore.getState().setStatus('idle');
        logVoiceEvent('info', 'jarvis.pttBargeIn', 'PTT interrompeu a fala da Jarvis');
      }

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
      narrationQueue.enqueue(text);
    });

    const cleanup = () => {
      clearInterval(micHealthTimer);
      clearInterval(statusWatchdogTimer);
      unsubStatusWatchdog();
      unsubNarrationState();
      narrationQueue.dispose();
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
      unsubLiveToolCancelled();
      unsubLiveToolResult();
      unsubLiveToolTurnComplete();
      unsubLiveInterrupted();
      unsubLiveAudio();
      wakeMic.setUtteranceFrameTap(null);
      wakeMic.onPassiveUtterance = null;
      wakeMic.cancelPassiveWake();
      passiveWakeDeadline.invalidate();
      wakeMic.onLevel = null;
      if (capture.current) capture.current.onLevel = null;
      if (capture.current) capture.current.onFrame = null;
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
    resetOfferedLiveMicFramesThisTurn();
    setRealtimeTurnActive(false);
    setLastRealtimeNativeToolCallId(null);
    const turnId = String(turnExecution.beginTurn());
    realtimeTranscriptWaiter.beginTurn(turnId);
    window.nexus.voice.liveTurnBegin(turnId);
    setActiveCaptureReason(reason);
    // C3 (follow-up 4a): a pendência de missão NÃO é mais limpa aqui — "Hey
    // Jarvis, sim" agora CONFIRMA em vez de descartar mudo. As guardas contra
    // despacho espúrio são o matcher estrito (afirmativa isolada), o consumo
    // na primeira fala (runJarvisTurn) e o TTL de 15s.
    // C3 Fase 1: o re-wake com "sim" SECO funciona — com pendência viva o
    // stripper poupa o padrão ['sim'] (transcript-filter, protectConfirmation)
    // e um strip-pra-vazio re-pergunta em vez de morrer mudo (delegation-reask).
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
      // The configured Live route owns wake from cold start onward, so do not
      // mute or interrupt it merely because setup has not completed yet.
      if (!shouldReserveWakeForRealtime()) {
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
        // The first user utterance must be the only new Live turn. Injecting a
        // spoken "Olá" concurrently with microphone frames raced Gemini's turn
        // queue and made the app fall back to Classic after 4.8s.
        const liveContext = liveContextText();
        // Seed main before provider creation so Gemini 3.1 receives the first
        // screen snapshot in setup. Later snapshots stay queryable through the
        // read-only consultar/ler tools instead of becoming synthetic turns.
        window.nexus.voice.liveContextIn(liveContext);
        setPendingLiveStartSettle(
          window.nexus.voice
            .liveStart({ reason })
            .then((state) => {
              store.setLiveState(state);
              if (!state.realtimeReady) {
                setRealtimeTurnActive(false);
              }
            })
            .catch((err) => {
              setRealtimeTurnActive(false);
              console.warn('[voice] liveStart falhou (classic segue):', errMsg(err));
            }),
        );
      }
    }

    const captureAutoStop =
      reason === 'reply' && autoStop
        ? { ...autoStop, maxMs: Math.min(autoStop.maxMs, REPLY_MAX_LISTEN_MS) }
        : autoStop;
    if (wakeMic.isRunning()) {
      wakeMic.beginUtterance(
        captureAutoStop,
        reason === 'wake' ? WAKE_PREROLL_MS : 0,
        preRollSeed,
      );
    } else {
      await capture.start(captureAutoStop);
    }
    store.setStatus('listening');
    liveStatus('listening');
  } catch (err) {
    store.setError(`Mic unavailable: ${errMsg(err)}`);
    liveStatus('error', errMsg(err));
  }
}
