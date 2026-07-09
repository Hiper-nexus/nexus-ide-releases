/**
 * finishAndProcess — the main audio→transcript→brain pipeline.
 * Extracted from voice-controller for the 800-line Akita budget.
 *
 * Deps (beginListening, isListening, wakeAutoStop) are injected to avoid
 * circular imports with voice-controller.ts.
 */
import type React from 'react';
import { useVoiceStore } from './voice-store';
import { hasUsableLocalSpeech, shouldDiscardBeforeRealtime } from './capture-gate';
import {
  isDiscardableTranscript,
  isWakeAckOnlyTranscript,
  stripWakeAckEcho,
} from './transcript-filter';
import { isLikelyNoiseTranscript } from '../../shared/voice-noise';
import { discardSpokenEchoIfNeeded, transcriptInConversation } from './voice-echo-guard';
import { resetAutoReplyLoopForCapture } from './jarvis-reply-loop';
import { classicSuppressedByRealtimeOwner } from './realtime-ownership';
import { playAudioBase64 } from './voice-playback';
import { getThinkFillerCache, THINK_FILLERS } from './voice-wake-ack';
import {
  errMsg,
  liveEndTurn,
  liveStatus,
  logVoiceEvent,
} from './voice-live-ipc';
import {
  REALTIME_PROVIDER_AUDIO_ENABLED,
  activeCaptureReason,
  jarvisLastTurnAt,
  jarvisHistory,
  lastRealtimeNativeToolAt,
  pendingLiveStartSettle,
  realtimeAudioPlayedCounter,
  realtimeAudioSuppressedCounter,
  realtimeNativeToolInFlight,
  realtimeTranscriptWaiter,
  resetPendingRealtimeAudioOut,
  setSuppressRealtimeAudioOut,
  setRealtimeTurnActive,
  turnExecution,
  wakeMic,
  livePlayer,
} from './voice-session-state';
import { openLiveAudioGate } from './voice-live-audio-out';
import { shouldOpenGateOnTurnExit } from './turn-gate';
import { classifyConfirmationReply, peekPendingDelegation } from './delegation-confirm';
import {
  canAttemptRealtime,
  isJarvisLiveEnabled,
  isRealtimeLive,
  shouldStreamToRealtime,
} from './voice-realtime-gates';
import { realtimeTranscriptWaitMs } from './realtime-transcript-wait';
import { shouldLetRealtimeProviderAnswer, shouldUseClassicActionBridge } from './realtime-bridge-policy';
import { releaseAfterLiveProviderAnswer } from './live-followup';
import { hasRealtimeProviderAudioAnswer } from './live-wake-greeting';
import { personaUserName } from './jarvis-screen-context';
import { withTimeout } from './voice-speak-pipeline';
import { runJarvisTurn, routePrompt, captureResponse, type RunJarvisTurnDeps } from './voice-run-jarvis-turn';
import { MIN_WAKE_SUPPRESSION_MS } from './voice-suppression-window';
import type { VoiceCapture, AutoStopOptions } from './voice-capture';
import type { JarvisCaptureReason } from './jarvis-reply-loop';

const TRANSCRIBE_DEADLINE_MS_LOCAL = 60_000;
const SPEAK_DEADLINE_MS_LOCAL = 40_000;
const LIVE_START_SETTLE_MS_LOCAL = 3_000;
const JARVIS_MEMORY_MS_LOCAL = 300_000;
const WAKE_STT_BUDGET_MS = 8_000;
const MIN_SPEECH_SEC = 0.25;

/** Injected callbacks to avoid circular imports with voice-controller. */
export interface FinishAndProcessDeps extends RunJarvisTurnDeps {
  wakeAutoStop: (
    capture: VoiceCapture,
    busy: React.MutableRefObject<boolean>,
    reason: 'wake' | 'click',
  ) => AutoStopOptions;
}

function isAckGatedCapture(reason: JarvisCaptureReason = activeCaptureReason): boolean {
  return reason === 'wake' || reason === 'click';
}

function hasRealtimeNativeToolSince(since: number): boolean {
  return realtimeNativeToolInFlight > 0 || lastRealtimeNativeToolAt >= since;
}

export async function finishAndProcess(
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
  deps: FinishAndProcessDeps,
): Promise<void> {
  const store = useVoiceStore.getState();
  busy.current = true;
  const turnToken = turnExecution.currentToken;
  let realtimeMuteDegrade = false;
  try {
    const result = wakeMic.isUtteranceActive()
      ? wakeMic.finishUtterance()
      : await capture.stop();
    const routing = store.info?.routing ?? 'focused-pane';

    if (pendingLiveStartSettle) {
      await withTimeout(
        pendingLiveStartSettle,
        LIVE_START_SETTLE_MS_LOCAL,
        'settle do socket realtime',
      ).catch(() => {});
    }
    const shouldTryRealtimeTranscript = routing === 'jarvis' && shouldStreamToRealtime();
    const captureGate = {
      wavBase64: result.wavBase64,
      durationSec: result.durationSec,
      heardSpeech: result.heardSpeech,
      maxRms: result.maxRms,
      maxPeak: result.maxPeak,
      minSpeechSec: MIN_SPEECH_SEC,
    };
    const allowWeakSpeech = isAckGatedCapture();
    const localSpeechUsable = hasUsableLocalSpeech(captureGate, { allowWeakSpeech });
    if (
      shouldDiscardBeforeRealtime(captureGate, {
        shouldTryRealtime: shouldTryRealtimeTranscript,
        hasQueuedRealtimeTranscript: realtimeTranscriptWaiter.hasQueued(),
        allowWeakSpeech,
      })
    ) {
      if (result.heardSpeech === false) {
        console.log('[voice] captura sem fala real (silêncio/ruído) — descartada');
      }
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    if (allowWeakSpeech && result.heardSpeech === false && localSpeechUsable) {
      logVoiceEvent(
        'info',
        'jarvis.weakSpeechAccepted',
        'wake/click enviado ao STT por sinal fraco',
        {
          reason: activeCaptureReason,
          durationSec: Number(result.durationSec.toFixed(2)),
          maxRms: Number((result.maxRms ?? 0).toFixed(5)),
          maxPeak: Number((result.maxPeak ?? 0).toFixed(5)),
        },
      );
    }

    if (shouldTryRealtimeTranscript) {
      const tRealtime = Date.now();
      const realtimeIsOwner = classicSuppressedByRealtimeOwner({
        captureReason: activeCaptureReason,
        isRealtimeLive: isRealtimeLive(),
      });
      const transcriptWaitMs = realtimeTranscriptWaitMs(activeCaptureReason, {
        localSpeechUsable,
        realtimeIsOwner,
      });
      store.setStatus('transcribing');
      liveStatus('thinking');
      // CRITICAL: while Live owns the session, NEVER mute provider audio during
      // the transcript wait. Mute+early-return left suppress stuck ON → total
      // silence (log: audioSuppressed climbing to 300+ with zero play).
      // Mute only when Classic may speak (degraded / non-owner path).
      if (!realtimeIsOwner) {
        setSuppressRealtimeAudioOut(true);
      } else {
        openLiveAudioGate();
      }
      const wait = await realtimeTranscriptWaiter.wait(transcriptWaitMs);
      if (wait.superseded) {
        console.log('[voice] wait de transcript superseded por novo turno — sem mute');
        if (realtimeIsOwner) openLiveAudioGate();
        return;
      }
      const liveTranscript = wait.text;
      if (hasRealtimeNativeToolSince(tRealtime)) {
        // Tool already owns narration — keep Live audio open, don't mute.
        openLiveAudioGate();
        store.setStatus('idle');
        console.log('[voice] realtime tool-call resolveu o turno; Classic pulado');
        releaseAfterLiveProviderAnswer({
          busy,
          capture,
          beginListening: deps.beginListening,
          wakeAutoStop: deps.wakeAutoStop,
        });
        return;
      }
      if (liveTranscript) {
        const rawTranscript = liveTranscript.trim();
        if (isAckGatedCapture() && isWakeAckOnlyTranscript(rawTranscript, personaUserName())) {
          console.log(`[voice] realtime wake/click só ack/eco: "${liveTranscript}"`);
          store.setStatus('idle');
          resetPendingRealtimeAudioOut();
          void window.nexus.voice.liveInterrupt('ack-only-transcript').catch(() => {});
          liveEndTurn();
          return;
        }
        const transcript = isAckGatedCapture()
          ? stripWakeAckEcho(rawTranscript, personaUserName())
          : rawTranscript;
        if (!transcript) {
          console.log(
            `[voice] realtime transcript descartado como eco wake: "${liveTranscript}"`,
          );
          store.setStatus('idle');
          resetPendingRealtimeAudioOut();
          void window.nexus.voice.liveInterrupt('empty-transcript').catch(() => {});
          return;
        }
        if (
          discardSpokenEchoIfNeeded(
            transcript,
            activeCaptureReason,
            {
              log: (source, t, reason) => {
                console.log(`[voice] eco do TTS descartado (${source}): "${t}"`);
                logVoiceEvent('info', 'stt.echoDiscarded', 'eco do TTS descartado', {
                  source,
                  text: t.slice(0, 120),
                  reason,
                });
              },
              endTurn: liveEndTurn,
            },
            'realtime',
          )
        ) {
          resetPendingRealtimeAudioOut();
          void window.nexus.voice.liveInterrupt('spoken-echo').catch(() => {});
          return;
        }
        const inConversation = transcriptInConversation(
          activeCaptureReason,
          jarvisHistory.length,
          jarvisLastTurnAt,
          JARVIS_MEMORY_MS_LOCAL,
        );
        if (isDiscardableTranscript(transcript, { inConversation })) {
          console.log(`[voice] realtime transcript lixo descartado: "${transcript}"`);
          store.setStatus('idle');
          resetPendingRealtimeAudioOut();
          void window.nexus.voice.liveInterrupt('discarded-transcript').catch(() => {});
          return;
        }
        store.setTranscript(transcript);
        store.setNote(null);
        resetAutoReplyLoopForCapture(activeCaptureReason);
        const realtimeMs = Date.now() - tRealtime;
        console.log(`[voice] realtime transcript (${realtimeMs}ms): "${transcript}"`);
        logVoiceEvent('info', 'jarvis.realtimeTranscript', transcript, {
          latencyMs: realtimeMs,
          reason: activeCaptureReason,
        });

        // Overclock parity: while Live is hot, NEVER Classic-bridge / interrupt.
        // App actions (squad, terminal, …) go through Live tools; Classic only
        // when Live is down. Interrupting here cut TTS mid-sentence and killed
        // the confirmation step after design_squad.
        // C3: resposta a um "Confirmo?" pendente NUNCA vai pro provider Live —
        // desce pro caminho Classic, onde runJarvisTurn intercepta e resolve.
        const isPendingDelegationReply =
          peekPendingDelegation(Date.now()) !== null &&
          classifyConfirmationReply(transcript) !== 'other';
        if (
          !isPendingDelegationReply &&
          REALTIME_PROVIDER_AUDIO_ENABLED &&
          shouldLetRealtimeProviderAnswer(transcript, { isRealtimeLive: isRealtimeLive() }) &&
          isRealtimeLive()
        ) {
          const claimed = turnExecution.claim('realtime-audio', turnToken);
          // Even if tool/classic already claimed: Live must stay audible.
          openLiveAudioGate();
          if (!claimed) {
            console.log(
              '[voice] turno já reivindicado (tool/classic) — Live audio gate aberto, sem Classic',
            );
            logVoiceEvent('info', 'jarvis.liveAudioGateRecovered', 'claim perdido — gate aberto', {
              owner: turnExecution.owner,
              reason: activeCaptureReason,
            });
          } else {
            wakeMic.suppressWakeDetection(MIN_WAKE_SUPPRESSION_MS);
            logVoiceEvent('info', 'jarvis.liveProviderAnswer', 'provider realtime', {
              reason: activeCaptureReason,
              transcript: transcript.slice(0, 180),
            });
          }
          // FIX B+C: keep realtimeTurnActive=true (chunks keep arriving),
          // release busy and arm follow-up instead of liveEndTurn.
          releaseAfterLiveProviderAnswer({
            busy,
            capture,
            beginListening: deps.beginListening,
            wakeAutoStop: deps.wakeAutoStop,
          });
          return;
        }

        setSuppressRealtimeAudioOut(true);
        resetPendingRealtimeAudioOut();
        livePlayer?.stop();
        void window.nexus.voice.liveInterrupt('classic-live-bridge').catch(() => {});
        liveStatus('thinking');
        if (shouldUseClassicActionBridge(transcript)) {
          logVoiceEvent('info', 'jarvis.actionBridge', 'classic executor', {
            reason: 'app_action',
            transcript: transcript.slice(0, 180),
          });
        } else {
          logVoiceEvent('info', 'jarvis.liveBridge', 'classic executor', {
            reason: 'conversation',
            transcript: transcript.slice(0, 180),
          });
        }
        setRealtimeTurnActive(false);
        if (!turnExecution.claim('classic-brain', turnToken)) {
          console.log('[voice] turno já reivindicado por tool-call realtime; Classic pulado');
          openLiveAudioGate();
          store.setStatus('idle');
          return;
        }
        await runJarvisTurn(transcript, capture, busy, turnToken, deps);
        return;
      }
      if (!localSpeechUsable) {
        console.log(
          `[voice] realtime sem transcript final em ${Date.now() - tRealtime}ms (janela ${transcriptWaitMs}ms) e captura local sem fala — descartada`,
        );
        if (realtimeIsOwner) openLiveAudioGate();
        store.setStatus('idle');
        liveEndTurn();
        return;
      }
      const heldAnswerChunks = realtimeAudioSuppressedCounter.total;
      const playedAnswerChunks = realtimeAudioPlayedCounter.total;
      if (
        realtimeIsOwner &&
        hasRealtimeProviderAudioAnswer({
          heldChunks: heldAnswerChunks,
          playedChunks: playedAnswerChunks,
        })
      ) {
        const claimed = turnExecution.claim('realtime-audio', turnToken);
        openLiveAudioGate();
        if (claimed) {
          wakeMic.suppressWakeDetection(MIN_WAKE_SUPPRESSION_MS);
          logVoiceEvent(
            'info',
            'jarvis.liveProviderAnswer',
            'provider realtime (áudio sem transcript final)',
            {
              reason: activeCaptureReason,
              waitedMs: Date.now() - tRealtime,
              heldChunks: heldAnswerChunks,
              playedChunks: playedAnswerChunks,
            },
          );
        }
        // FIX C: don't set realtimeTurnActive=false; release + arm follow-up
        releaseAfterLiveProviderAnswer({
          busy,
          capture,
          beginListening: deps.beginListening,
          wakeAutoStop: deps.wakeAutoStop,
        });
        return;
      }
      // ONE VOICE / FIX D: while Live owns the session, mute ≠ Classic STT.
      // Classic on wake/reply produced marin flip + garbage ("o ônibus") while
      // the Live socket was still healthy. Keep socket alive for re-wake.
      if (realtimeIsOwner) {
        const event =
          activeCaptureReason === 'reply' ? 'jarvis.replyMuteIdle' : 'jarvis.liveMuteIdle';
        const message =
          activeCaptureReason === 'reply'
            ? 'follow-up sem resposta Live — voltando a idle (sem Classic)'
            : 'Live mudo (sem áudio/transcript) — idle sem Classic';
        logVoiceEvent('info', event, message, {
          reason: activeCaptureReason,
          waitedMs: Date.now() - tRealtime,
        });
        openLiveAudioGate();
        setRealtimeTurnActive(false);
        store.setStatus('idle');
        return;
      }
      // Live not owner → legitimate degradation to Classic STT.
      realtimeMuteDegrade = true;
      logVoiceEvent(
        'warn',
        'jarvis.realtimeMuteDegraded',
        'realtime mudo (sem áudio/transcript) — Classic STT assume',
        { reason: activeCaptureReason, waitedMs: Date.now() - tRealtime },
      );
      console.log(
        `[voice] realtime sem transcript final em ${Date.now() - tRealtime}ms (janela ${transcriptWaitMs}ms) — fallback Classic STT (degradado)`,
      );
      setSuppressRealtimeAudioOut(true);
      resetPendingRealtimeAudioOut();
      void window.nexus.voice.liveInterrupt('classic-action-bridge-timeout').catch(() => {});
      setRealtimeTurnActive(false);
    }

    if (
      !realtimeMuteDegrade &&
      classicSuppressedByRealtimeOwner({
        captureReason: activeCaptureReason,
        isRealtimeLive: isRealtimeLive(),
      })
    ) {
      console.log(
        '[voice] realtime dona a conversa — Classic STT/cérebro/TTS suprimido (sem racer)',
      );
      logVoiceEvent(
        'info',
        'jarvis.classicSuppressed',
        'realtime dona — Classic off (sem racer)',
        { reason: activeCaptureReason },
      );
      store.setStatus('idle');
      return;
    }

    // ONE VOICE: Classic think-fillers (marin) must not play while Live/Charon
    // owns the session — that was the woman/man flip mid-turn.
    if (routing === 'jarvis' && !canAttemptRealtime(store.info)) {
      const filler = THINK_FILLERS[Math.floor(Math.random() * THINK_FILLERS.length)];
      const cached = getThinkFillerCache().get(filler);
      if (cached) {
        void window.nexus.voice.recordEcho(filler).catch(() => {});
        void playAudioBase64(cached.audioBase64, cached.format).catch(() => {});
      }
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
        ...(routing === 'jarvis' ? { translate: false, language: 'pt' } : {}),
        ...(isAckGatedCapture() ? { budgetMs: WAKE_STT_BUDGET_MS } : {}),
      }),
      TRANSCRIBE_DEADLINE_MS_LOCAL,
      'transcrição',
    );
    if (!stt.ok) {
      store.setError(stt.error);
      liveStatus('error', stt.error);
      return;
    }
    if (stt.discarded === 'echo') {
      console.log(`[voice] eco do TTS descartado: "${stt.text}"`);
      logVoiceEvent('info', 'stt.echoDiscarded', 'eco do TTS descartado', {
        source: 'classic',
        text: stt.text.slice(0, 120),
        reason: activeCaptureReason,
      });
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    const tStt = Date.now() - tTurn;
    if (isAckGatedCapture() && isWakeAckOnlyTranscript(stt.text, personaUserName())) {
      console.log(`[voice] turno wake/click só ack/eco descartado: "${stt.text}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    const transcript = isAckGatedCapture()
      ? stripWakeAckEcho(stt.text, personaUserName())
      : stt.text.trim();
    if (!transcript) {
      const reason = isAckGatedCapture() ? 'eco do wake/click/ack' : 'transcrição vazia';
      console.log(`[voice] ${reason} descartado: "${stt.text}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    if (
      discardSpokenEchoIfNeeded(
        transcript,
        activeCaptureReason,
        {
          log: (source, t, reason) => {
            console.log(`[voice] eco do TTS descartado (${source}): "${t}"`);
            logVoiceEvent('info', 'stt.echoDiscarded', 'eco do TTS descartado', {
              source,
              text: t.slice(0, 120),
              reason,
            });
          },
          endTurn: liveEndTurn,
        },
        'classic',
      )
    ) {
      return;
    }
    const inConversation = transcriptInConversation(
      activeCaptureReason,
      jarvisHistory.length,
      jarvisLastTurnAt,
      JARVIS_MEMORY_MS_LOCAL,
    );
    if (isDiscardableTranscript(transcript, { inConversation })) {
      console.log(`[voice] transcrição-lixo do Whisper descartada: "${transcript}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    if (activeCaptureReason === 'reply' && isLikelyNoiseTranscript(transcript)) {
      console.log(`[voice] reply-lixo descartado antes do cérebro: "${transcript}"`);
      logVoiceEvent('info', 'jarvis.replyNoiseDiscarded', 'reply ruído/eco garbled descartado', {
        text: transcript.slice(0, 120),
        reason: activeCaptureReason,
      });
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    store.setTranscript(transcript);
    console.log(`[voice] transcrito (${tStt}ms): "${transcript}"`);
    logVoiceEvent('info', 'jarvis.classicTranscript', transcript, {
      latencyMs: tStt,
      reason: activeCaptureReason,
    });
    resetAutoReplyLoopForCapture(activeCaptureReason);
    store.setNote(stt.fallbackNote ?? null);

    if (routing === 'jarvis') {
      if (!turnExecution.claim('classic-brain', turnToken)) {
        console.log('[voice] turno já reivindicado por tool-call realtime; Classic pulado');
        store.setStatus('idle');
        return;
      }
      await runJarvisTurn(transcript, capture, busy, turnToken, deps);
      return;
    }

    store.setStatus('routing');
    const paneId = routePrompt(transcript);
    if (!paneId) {
      store.setError('No focused pane to route the prompt into.');
      return;
    }

    const reply = await captureResponse(paneId, transcript);
    if (reply.trim()) {
      store.setStatus('speaking');
      const spoken = await withTimeout(
        window.nexus.voice.speak({ text: reply }),
        SPEAK_DEADLINE_MS_LOCAL,
        'TTS',
      );
      if (spoken.ok) {
        if (spoken.fallbackNote) store.setNote(spoken.fallbackNote);
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
    // INVARIANTE DE MUTE (C2): nenhuma saída deste turno pode deixar
    // suppressRealtimeAudioOut preso em true. Só o turno atual toca o gate;
    // um turno mais novo (superseded) é dono da própria supressão.
    if (shouldOpenGateOnTurnExit(turnExecution.currentToken, turnToken)) {
      openLiveAudioGate();
    }
    // Live provider answer already cleared busy via releaseAfterLiveProviderAnswer
    // and may be waiting to re-arm follow-up while status is still 'speaking'.
    // Do not leave busy stuck true on early Live returns.
    const status = useVoiceStore.getState().status;
    if (status !== 'listening') {
      busy.current = false;
    }
  }
}
