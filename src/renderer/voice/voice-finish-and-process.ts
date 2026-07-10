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
import {
  discardSpokenEchoIfNeeded,
  transcriptInConversation,
} from './voice-echo-guard';
import { resetAutoReplyLoopForCapture } from './jarvis-reply-loop';
import {
  classicSuppressedByRealtimeOwner,
  shouldFallbackClassicAfterRealtimeMute,
} from './realtime-ownership';
import { playAudioBase64 } from './voice-playback';
import { getThinkFillerCache, THINK_FILLERS } from './voice-wake-ack';
import {
  errMsg,
  liveEndUserAudio,
  liveEndTurn,
  liveStatus,
  logVoiceEvent,
  quiesceLiveForClassic,
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
import { clearPendingDelegation, peekPendingDelegation } from './delegation-confirm';
import { reaskPendingDelegation } from './delegation-reask';
import {
  canAttemptRealtime,
  isJarvisLiveEnabled,
  isRealtimeLive,
  shouldStreamToRealtime,
} from './voice-realtime-gates';
import { realtimeTranscriptWaitMs } from './realtime-transcript-wait';
import {
  ZERO_FRAMES_TRANSCRIPT_WAIT_MS,
  markLiveMuteRescueAttempt,
  offeredLiveMicFramesThisTurn,
  resetLiveMuteRescues,
  shouldAttemptLiveMuteRescue,
  waitForLiveRescueEvidence,
} from './live-mute-rescue';
import { shouldLetRealtimeProviderAnswer, shouldUseClassicActionBridge } from './realtime-bridge-policy';
import { releaseAfterLiveProviderAnswer } from './live-followup';
import { hasRealtimeProviderAudioAnswer } from './live-wake-greeting';
import { personaUserName } from './jarvis-screen-context';
import { withTimeout } from './voice-speak-pipeline';
import { runJarvisTurn, routePrompt, captureResponse, type RunJarvisTurnDeps } from './voice-run-jarvis-turn';
import { MIN_WAKE_SUPPRESSION_MS } from './voice-suppression-window';
import type { VoiceCapture, AutoStopOptions } from './voice-capture';
import type { TranscribeResult } from '../../shared/voice-ipc';
import {
  filteredLiveRescueTranscript,
  hasRealtimeNativeToolSince,
  isAckGatedCapture,
  JARVIS_MEMORY_MS_LOCAL,
  LIVE_START_SETTLE_MS_LOCAL,
  MIN_SPEECH_SEC,
  SPEAK_DEADLINE_MS_LOCAL,
  TRANSCRIBE_DEADLINE_MS_LOCAL,
  WAKE_STT_BUDGET_MS,
} from './voice-finish-helpers';

/** Injected callbacks to avoid circular imports with voice-controller. */
export interface FinishAndProcessDeps extends RunJarvisTurnDeps {
  wakeAutoStop: (
    capture: VoiceCapture,
    busy: React.MutableRefObject<boolean>,
    reason: 'wake' | 'click',
  ) => AutoStopOptions;
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
  let cachedStt: TranscribeResult | null = null;
  let cachedSttLatencyMs = 0;
  try {
    const result = wakeMic.isUtteranceActive()
      ? wakeMic.finishUtterance()
      : await capture.stop();
    const routing = store.info?.routing ?? 'focused-pane';
    const shouldTryRealtimeTranscript =
      routing === 'jarvis' && shouldStreamToRealtime();
    // A paused stream must emit audioStreamEnd promptly; otherwise Gemini can
    // retain cached PCM while this pipeline waits for its transcript.
    if (shouldTryRealtimeTranscript) liveEndUserAudio();
    const transcribeCapture = async (): Promise<TranscribeResult> => {
      const startedAt = Date.now();
      const transcribed = await withTimeout(
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
      cachedSttLatencyMs = Date.now() - startedAt;
      return transcribed;
    };

    if (pendingLiveStartSettle) {
      await withTimeout(
        pendingLiveStartSettle,
        LIVE_START_SETTLE_MS_LOCAL,
        'settle do socket realtime',
      ).catch(() => {});
    }
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
      const heldChunksBaseline = realtimeAudioSuppressedCounter.total;
      const playedChunksBaseline = realtimeAudioPlayedCounter.total;
      const offeredFrames = offeredLiveMicFramesThisTurn();
      const transcriptWaitMs =
        realtimeIsOwner && offeredFrames === 0
          ? ZERO_FRAMES_TRANSCRIPT_WAIT_MS
          : realtimeTranscriptWaitMs(activeCaptureReason, {
              localSpeechUsable,
              realtimeIsOwner,
            });
      if (realtimeIsOwner && offeredFrames === 0) {
        logVoiceEvent(
          'warn',
          'jarvis.zeroOfferedFrames',
          'nenhum frame do turno foi oferecido ao transporte realtime',
          { reason: activeCaptureReason, localSpeechUsable },
        );
      }
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
      const wait = await realtimeTranscriptWaiter.wait(
        transcriptWaitMs,
        String(turnToken),
      );
      if (wait.superseded) {
        console.log('[voice] wait de transcript superseded por novo turno — sem mute');
        if (realtimeIsOwner) openLiveAudioGate();
        return;
      }
      const liveTranscript = wait.text;
      if (hasRealtimeNativeToolSince(tRealtime)) {
        // Tool already owns narration — keep Live audio open, don't mute.
        openLiveAudioGate();
        resetLiveMuteRescues();
        store.setStatus('idle');
        console.log('[voice] realtime tool-call resolveu o turno; Classic pulado');
        // C3: a primeira fala consome a pendência mesmo quando o turno é
        // resolvido por tool nativa do Live — senão um "sim" isolado depois,
        // dentro do TTL, despacharia a missão obsoleta respondendo outra
        // pergunta que não tem nada a ver com a delegação.
        if (peekPendingDelegation(Date.now()) !== null) {
          clearPendingDelegation();
          store.setNote('Missão pro squad descartada — o turno virou outra ação.');
          logVoiceEvent(
            'info',
            'jarvis.delegationDropped',
            'pendência descartada — turno resolvido por tool nativa',
            {},
          );
        }
        releaseAfterLiveProviderAnswer({
          busy,
          capture,
          beginListening: deps.beginListening,
          wakeAutoStop: deps.wakeAutoStop,
        });
        return;
      }
      if (liveTranscript) {
        resetLiveMuteRescues();
        const rawTranscript = liveTranscript.trim();
        // C3 Fase 1: com pendência viva, o "sim" seco de um re-wake é a
        // resposta do usuário — o stripper poupa o padrão ['sim'] neste turno.
        const stripOpts = {
          protectConfirmation:
            isAckGatedCapture() && peekPendingDelegation(Date.now()) !== null,
        };
        if (
          isAckGatedCapture() &&
          isWakeAckOnlyTranscript(rawTranscript, personaUserName(), stripOpts)
        ) {
          console.log(`[voice] realtime wake/click só ack/eco: "${liveTranscript}"`);
          resetPendingRealtimeAudioOut();
          if (
            stripOpts.protectConfirmation &&
            (await reaskPendingDelegation(capture, busy, turnToken, deps))
          ) {
            return;
          }
          store.setStatus('idle');
          void window.nexus.voice.liveInterrupt('ack-only-transcript').catch(() => {});
          liveEndTurn();
          return;
        }
        const transcript = isAckGatedCapture()
          ? stripWakeAckEcho(rawTranscript, personaUserName(), stripOpts)
          : rawTranscript;
        if (!transcript) {
          console.log(
            `[voice] realtime transcript descartado como eco wake: "${liveTranscript}"`,
          );
          resetPendingRealtimeAudioOut();
          if (
            stripOpts.protectConfirmation &&
            (await reaskPendingDelegation(capture, busy, turnToken, deps))
          ) {
            return;
          }
          store.setStatus('idle');
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
        // C3: a PRIMEIRA fala após "Confirmo?" É a resposta — force-a pro caminho
        // Classic (runJarvisTurn resolve sim/não/outro e SEMPRE limpa a
        // pendência). Sem isso um comando Live não relacionado nunca consumiria a
        // pendência e ela vazaria até o TTL.
        const isPendingDelegationReply = peekPendingDelegation(Date.now()) !== null;
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
        await quiesceLiveForClassic('classic-live-bridge');
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
      const heldAnswerChunks =
        realtimeAudioSuppressedCounter.total - heldChunksBaseline;
      const playedAnswerChunks = realtimeAudioPlayedCounter.total - playedChunksBaseline;
      if (
        realtimeIsOwner &&
        hasRealtimeProviderAudioAnswer({
          heldChunks: heldAnswerChunks,
          playedChunks: playedAnswerChunks,
        })
      ) {
        const claimed = turnExecution.claim('realtime-audio', turnToken);
        openLiveAudioGate();
        resetLiveMuteRescues();
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
      const explicitCapture = shouldFallbackClassicAfterRealtimeMute(
        activeCaptureReason,
      );
      if (
        shouldAttemptLiveMuteRescue({
          realtimeIsOwner,
          localSpeechUsable,
          explicitCapture,
          offeredFrames,
        }) &&
        peekPendingDelegation(Date.now()) === null
      ) {
        cachedStt = await transcribeCapture();
        const rescueTranscript =
          cachedStt.ok && cachedStt.discarded !== 'echo'
            ? filteredLiveRescueTranscript(cachedStt.text)
            : null;
        if (rescueTranscript) {
          const attempt = markLiveMuteRescueAttempt();
          const rescueStartedAt = Date.now();
          const rescueTurnId = `${turnToken}:${rescueStartedAt}`;
          const rescuePlayedBaseline = realtimeAudioPlayedCounter.total;
          const rescueHeldBaseline = realtimeAudioSuppressedCounter.total;
          logVoiceEvent(
            'warn',
            'jarvis.liveMuteRescue',
            'turno realtime sem frames — STT local reenviado como texto',
            {
              reason: activeCaptureReason,
              attempt,
              offeredFrames,
              turnId: rescueTurnId,
              durationSec: Number(result.durationSec.toFixed(2)),
            },
          );
          store.setNote('Reprocessando sua fala…');
          wakeMic.suppressWakeDetection(MIN_WAKE_SUPPRESSION_MS);
          openLiveAudioGate();
          const accepted = await window.nexus.voice.liveRescueIn({
            turnId: rescueTurnId,
            text: rescueTranscript,
          });
          if (accepted.accepted && accepted.turnId === rescueTurnId) {
            const evidence = await waitForLiveRescueEvidence({
              turnToken,
              startedAt: rescueStartedAt,
              playedBaseline: rescuePlayedBaseline,
              heldBaseline: rescueHeldBaseline,
              read: () => ({
                turnToken: turnExecution.currentToken,
                playedAudioChunks: realtimeAudioPlayedCounter.total,
                heldAudioChunks: realtimeAudioSuppressedCounter.total,
                toolInFlight: realtimeNativeToolInFlight,
                lastToolAt: lastRealtimeNativeToolAt,
              }),
            });
            if (evidence === 'superseded') return;
            if (evidence === 'audio' || evidence === 'tool') {
              if (evidence === 'audio') {
                turnExecution.claim('realtime-audio', turnToken);
              }
              resetLiveMuteRescues();
              store.setNote(null);
              logVoiceEvent(
                'info',
                'jarvis.liveMuteRescueRecovered',
                'resgate confirmado por evidência do provider',
                { turnId: rescueTurnId, evidence },
              );
              releaseAfterLiveProviderAnswer({
                busy,
                capture,
                beginListening: deps.beginListening,
                wakeAutoStop: deps.wakeAutoStop,
              });
              return;
            }
          }
          logVoiceEvent(
            'warn',
            'jarvis.liveMuteRescueTimeout',
            'resgate sem evidência — teardown antes do Classic',
            { turnId: rescueTurnId },
          );
          store.setNote(null);
          await window.nexus.voice.liveHardTeardown().catch(() => null);
        }
      }
      // Automatic reply capture can be ambient noise/echo; never turn that
      // into a Classic self-talk loop. Explicit wake/click/PTT/manual capture,
      // however, must degrade when Live produced neither audio nor transcript.
      if (
        realtimeIsOwner &&
        !explicitCapture
      ) {
        logVoiceEvent('info', 'jarvis.replyMuteIdle', 'follow-up sem resposta Live — idle', {
          reason: activeCaptureReason,
          waitedMs: Date.now() - tRealtime,
        });
        openLiveAudioGate();
        setRealtimeTurnActive(false);
        store.setStatus('idle');
        return;
      }
      // No realtime response for an explicit user capture: cancel any late
      // provider response before the single Classic fallback takes ownership.
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
      await quiesceLiveForClassic('classic-action-bridge-timeout');
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
    const stt = cachedStt ?? (await transcribeCapture());
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
    const tStt = cachedStt ? cachedSttLatencyMs : Date.now() - tTurn;
    // C3 Fase 1: mesmo contrato do caminho realtime — pendência viva poupa o
    // "sim" seco do stripper, e strip-pra-vazio re-pergunta em vez de morrer mudo.
    const stripOpts = {
      protectConfirmation:
        isAckGatedCapture() && peekPendingDelegation(Date.now()) !== null,
    };
    if (isAckGatedCapture() && isWakeAckOnlyTranscript(stt.text, personaUserName(), stripOpts)) {
      console.log(`[voice] turno wake/click só ack/eco descartado: "${stt.text}"`);
      if (
        stripOpts.protectConfirmation &&
        (await reaskPendingDelegation(capture, busy, turnToken, deps))
      ) {
        return;
      }
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    const transcript = isAckGatedCapture()
      ? stripWakeAckEcho(stt.text, personaUserName(), stripOpts)
      : stt.text.trim();
    if (!transcript) {
      const reason = isAckGatedCapture() ? 'eco do wake/click/ack' : 'transcrição vazia';
      console.log(`[voice] ${reason} descartado: "${stt.text}"`);
      if (
        stripOpts.protectConfirmation &&
        (await reaskPendingDelegation(capture, busy, turnToken, deps))
      ) {
        return;
      }
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
