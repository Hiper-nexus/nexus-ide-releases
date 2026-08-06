/**
 * finishAndProcess — the main audio→transcript→brain pipeline.
 * Extracted from voice-controller for the 800-line Akita budget.
 *
 * Deps (beginListening, isListening, wakeAutoStop) are injected to avoid
 * circular imports with voice-controller.ts.
 */
import type React from 'react';
import { useVoiceStore } from './voice-store';
import { dictationSttRequestParams } from './dictation-output-mode';
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
import {
  isDictationCapture,
  resetAutoReplyLoopForCapture,
} from './jarvis-reply-loop';
import {
  classicSuppressedByRealtimeOwner,
  shouldFallbackClassicAfterRealtimeMute,
} from './realtime-ownership';
import { playAudioBase64 } from './voice-playback';
import { isResponseMuted } from './response-output-gate';
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
  lastRealtimeNativeToolCallId,
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
import {
  clearPendingDelegation,
  peekPendingDelegation,
  shouldDiscardPendingDelegationAfterUnrelatedTool,
} from './delegation-confirm';
import { reaskPendingDelegation } from './delegation-reask';
import {
  canAttemptRealtime,
  isJarvisLiveEnabled,
  isRealtimeLive,
  shouldStreamToRealtime,
} from './voice-realtime-gates';
import { realtimeTranscriptWaitMs } from './realtime-transcript-wait';
import {
  hasInsufficientLiveMicFrames,
  INSUFFICIENT_LIVE_MIC_FRAMES_TRANSCRIPT_WAIT_MS,
  LIVE_RESCUE_RESPONSE_TIMEOUT_MS,
  markLiveMuteRescueAttempt,
  offeredLiveMicFramesThisTurn,
  resetLiveMuteRescues,
  shouldAttemptLiveMuteRescue,
  waitForLiveRescueEvidence,
} from './live-mute-rescue';
import { shouldLetRealtimeProviderAnswer, shouldUseClassicActionBridge } from './realtime-bridge-policy';
import {
  releaseAfterLiveProviderAnswer,
  releaseAfterLiveToolAnswer,
} from './live-followup';
import {
  hasRealtimeProviderAudioAnswer,
  liveAnswerOutcomeFromEvidence,
  shouldRearmAfterAudioOnly,
} from './live-wake-greeting';
import { followUpAuthority } from './follow-up-authority';
import { logVoiceTurnMilestone } from './voice-turn-telemetry';

/**
 * A warm socket is not authorization to keep listening. A silent follow-up
 * returns to idle and requires wake again; the transport may remain connected.
 */
const MAX_REPLY_MUTE_REOPENS = 0;
let replyMuteReopenCount = 0;
import { personaUserName } from './jarvis-screen-context';
import { withTimeout } from './voice-speak-pipeline';
import { runJarvisTurn, routePrompt, routeDictation, captureResponse, type RunJarvisTurnDeps } from './voice-run-jarvis-turn';
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
  const pendingDelegationAtTurnStart = peekPendingDelegation(Date.now());
  const canReopenLiveFollowUp = (): boolean =>
    turnExecution.currentToken === turnToken && turnExecution.owner === 'realtime-audio';
  const canReopenLiveToolFollowUp = (): boolean =>
    turnExecution.currentToken === turnToken && turnExecution.owner === 'realtime-tool';
  const releaseAfterRealtimeTool = (): void => {
    const sessionId = useVoiceStore.getState().liveState?.sessionId;
    const callId = lastRealtimeNativeToolCallId;
    if (sessionId && callId) {
      releaseAfterLiveToolAnswer({
        busy,
        capture,
        beginListening: deps.beginListening,
        wakeAutoStop: deps.wakeAutoStop,
        sessionId,
        turnId: String(turnToken),
        callId,
        canReopen: canReopenLiveToolFollowUp,
      });
      return;
    }
    // A missing correlation must stay safe: never open the mic into unknown
    // provider audio. The normal wake remains available and the condition is
    // logged for diagnosis rather than silently pretending continuity worked.
    logVoiceEvent(
      'warn',
      'jarvis.liveToolFollowUpUncorrelated',
      'tool realtime sem correlação para continuidade',
      { hasSessionId: Boolean(sessionId), hasCallId: Boolean(callId) },
    );
    releaseAfterLiveProviderAnswer({
      busy,
      capture,
      beginListening: deps.beginListening,
      wakeAutoStop: deps.wakeAutoStop,
      armFollowUp: false,
      followUpSkipReason: 'realtime-tool',
    });
  };
  const finishRealtimeToolTurn = (): void => {
    openLiveAudioGate();
    resetLiveMuteRescues();
    store.setStatus('idle');
    console.log('[voice] realtime tool-call resolveu o turno; Classic pulado');
    // C3: a primeira fala consome a pendência mesmo quando o turno é
    // resolvido por tool nativa do Live — senão um "sim" isolado depois,
    // dentro do TTL, despacharia uma missão obsoleta.
    if (
      shouldDiscardPendingDelegationAfterUnrelatedTool(
        pendingDelegationAtTurnStart,
        peekPendingDelegation(Date.now()),
        lastRealtimeNativeToolCallId ?? undefined,
      )
    ) {
      clearPendingDelegation();
      store.setNote('Missão pro squad descartada — o turno virou outra ação.');
      logVoiceEvent(
        'info',
        'jarvis.delegationDropped',
        'pendência descartada — turno resolvido por tool nativa',
        {},
      );
    }
    releaseAfterRealtimeTool();
  };
  let realtimeMuteDegrade = false;
  let quiesceLiveBeforeClassic = false;
  let realtimeStartedAt = 0;
  let realtimeHeldChunksBaseline = 0;
  let realtimePlayedChunksBaseline = 0;
  const cancelMutedLiveValidation = (reason: string): void => {
    if (!quiesceLiveBeforeClassic) return;
    resetPendingRealtimeAudioOut();
    void window.nexus.voice.liveInterrupt(reason).catch(() => {});
  };
  let cachedStt: TranscribeResult | null = null;
  let cachedSttLatencyMs = 0;
  try {
    const result = wakeMic.isUtteranceActive()
      ? wakeMic.finishUtterance()
      : await capture.stop();
    logVoiceTurnMilestone(String(turnToken), 'speech_end', {
      reason: activeCaptureReason,
      durationSec: result.durationSec,
    });
    const routing = store.info?.routing ?? 'focused-pane';
    // Ditado (Space na janela) nunca abre sessão realtime nem usa o override
    // STT da Jarvis: ele segue a config STT (Groq, tradução PT→EN) e injeta
    // o texto no pane focado.
    const dictationTurn = isDictationCapture(activeCaptureReason);
    const shouldTryRealtimeTranscript =
      routing === 'jarvis' && !dictationTurn && shouldStreamToRealtime();
    // A paused stream must emit audioStreamEnd promptly; otherwise Gemini can
    // retain cached PCM while this pipeline waits for its transcript.
    if (shouldTryRealtimeTranscript) liveEndUserAudio();
    // A conclusão correlacionada de uma tool pode chegar enquanto a captura de
    // reply continua aberta. Não espere o VAD/max-timeout: a ação já possui o
    // turno e o completion do provider já é a autoridade para liberar a fala.
    if (turnExecution.isOwnedBy('realtime-tool', turnToken)) {
      finishRealtimeToolTurn();
      return;
    }
    const transcribeCapture = async (): Promise<TranscribeResult> => {
      const startedAt = Date.now();
      const transcribed = await withTimeout(
        window.nexus.voice.transcribe({
          audioBase64: result.wavBase64,
          mime: 'audio/wav',
          sampleRate: result.sampleRate,
          ...(routing === 'jarvis' && !dictationTurn
            ? { translate: false, language: 'pt' }
            : {}),
          // Ditado: o modo configurado viaja EXPLÍCITO por turno — o default
          // por plugin varia entre engines (fallback caía em PT literal).
          ...(dictationTurn
            ? dictationSttRequestParams(
                useVoiceStore.getState().info?.dictationOutputMode,
              )
            : {}),
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

    // ── Ditado (Space na janela) ───────────────────────────────────────────
    // Fast-path dedicado: transcreve com a config STT (Groq PT→EN), injeta no
    // pane focado e encerra. NUNCA abre sessão Live, cérebro Jarvis, captura
    // de reply ou TTS — a Jarvis é um produto separado com gatilhos próprios.
    if (dictationTurn) {
      store.setStatus('transcribing');
      const stt = await transcribeCapture();
      if (!stt.ok) {
        store.setError(stt.error);
        return;
      }
      if (stt.discarded === 'echo') {
        console.log(`[voice] eco do TTS descartado no ditado: "${stt.text}"`);
        store.setStatus('idle');
        return;
      }
      const transcript = stt.text.trim();
      if (
        !transcript ||
        isDiscardableTranscript(transcript, { inConversation: false })
      ) {
        console.log(`[voice] ditado vazio/lixo descartado: "${stt.text}"`);
        store.setStatus('idle');
        return;
      }
      resetAutoReplyLoopForCapture(activeCaptureReason);
      store.setNote(stt.fallbackNote ?? null);
      store.setTranscript(transcript);
      console.log(
        `[voice] ditado transcrito (${cachedSttLatencyMs}ms): "${transcript}"`,
      );
      logVoiceEvent('info', 'stt.dictationTranscript', transcript, {
        latencyMs: cachedSttLatencyMs,
      });
      store.setStatus('routing');
      const routed = await routeDictation(transcript);
      if (!routed.ok) {
        store.setError(
          routed.reason === 'delivery-failed'
            ? 'O ditado chegou ao pane mas a injeção não foi confirmada — nada foi escrito.'
            : 'Nenhum pane ativo para receber o ditado.',
        );
        return;
      }
      store.setStatus('idle');
      return;
    }

    if (shouldTryRealtimeTranscript) {
      const tRealtime = Date.now();
      realtimeStartedAt = tRealtime;
      const realtimeIsOwner = classicSuppressedByRealtimeOwner({
        captureReason: activeCaptureReason,
        isRealtimeLive: isRealtimeLive(),
      });
      const heldChunksBaseline = realtimeAudioSuppressedCounter.total;
      const playedChunksBaseline = realtimeAudioPlayedCounter.total;
      realtimeHeldChunksBaseline = heldChunksBaseline;
      realtimePlayedChunksBaseline = playedChunksBaseline;
      const offeredFrames = offeredLiveMicFramesThisTurn();
      const hasInsufficientFrames = hasInsufficientLiveMicFrames(offeredFrames);
      const transcriptWaitMs =
        realtimeIsOwner && hasInsufficientFrames
          ? INSUFFICIENT_LIVE_MIC_FRAMES_TRANSCRIPT_WAIT_MS
          : realtimeTranscriptWaitMs(activeCaptureReason, {
              localSpeechUsable,
              realtimeIsOwner,
            });
      if (realtimeIsOwner && hasInsufficientFrames) {
        logVoiceEvent(
          'warn',
          'jarvis.zeroOfferedFrames',
          'frames insuficientes do turno foram oferecidos ao transporte realtime',
          { reason: activeCaptureReason, localSpeechUsable, offeredFrames },
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
      if (
        turnExecution.isOwnedBy('realtime-tool', turnToken) ||
        hasRealtimeNativeToolSince(tRealtime)
      ) {
        finishRealtimeToolTurn();
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
        if (activeCaptureReason !== 'reply') replyMuteReopenCount = 0;
        const realtimeMs = Date.now() - tRealtime;
        console.log(`[voice] realtime transcript (${realtimeMs}ms): "${transcript}"`);
        logVoiceEvent('info', 'jarvis.realtimeTranscript', transcript, {
          latencyMs: realtimeMs,
          reason: activeCaptureReason,
        });

        // ADE parity: while Live is hot, NEVER Classic-bridge / interrupt.
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
          // Open the gate so provider audio plays the instant it arrives.
          openLiveAudioGate();
          // ANTI-MUTE (final-transcript path): never ASSUME the provider will
          // speak. Measured runs showed ~89% of final-transcript turns closing
          // with zero audio while this path claimed 'realtime-audio' and returned
          // into silence. Wait for real audio/tool evidence first; on a mute
          // (timeout) fall through to the Classic degrade path below — the same
          // liveAnswerOutcomeFromEvidence contract the rescue path already uses.
          const answerStartedAt = Date.now();
          const answerEvidence = await waitForLiveRescueEvidence({
            turnToken,
            startedAt: answerStartedAt,
            playedBaseline: playedChunksBaseline,
            heldBaseline: heldChunksBaseline,
            read: () => ({
              turnToken: turnExecution.currentToken,
              playedAudioChunks: realtimeAudioPlayedCounter.total,
              heldAudioChunks: realtimeAudioSuppressedCounter.total,
              toolInFlight: realtimeNativeToolInFlight,
              lastToolAt: lastRealtimeNativeToolAt,
            }),
            timeoutMs: LIVE_RESCUE_RESPONSE_TIMEOUT_MS,
          });
          const answerOutcome = liveAnswerOutcomeFromEvidence(answerEvidence);
          if (answerOutcome === 'abort') return;
          if (answerOutcome === 'commit') {
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
                evidence: answerEvidence,
              });
            }
            // FIX B+C: keep realtimeTurnActive=true (chunks keep arriving),
            // release busy and arm follow-up instead of liveEndTurn.
            if (!claimed && turnExecution.owner === 'realtime-tool') {
              releaseAfterRealtimeTool();
            } else {
              releaseAfterLiveProviderAnswer({
                busy,
                capture,
                beginListening: deps.beginListening,
                wakeAutoStop: deps.wakeAutoStop,
                armFollowUp: claimed,
                followUpSkipReason: 'turn-owned-before-audio',
                canReopen: canReopenLiveFollowUp,
              });
            }
            return;
          }
          // answerOutcome === 'degrade': the provider stayed silent past the
          // deadline despite a final transcript. Fall through to the Classic
          // degrade path below (quiesce Live + runJarvisTurn speaks via Classic
          // TTS) instead of returning the user into silence.
          logVoiceEvent(
            'warn',
            'jarvis.liveProviderMuteDegraded',
            'provider mudo após transcript final — degradando pro Classic',
            { reason: activeCaptureReason, waitedMs: Date.now() - answerStartedAt },
          );
        }

        const delegationOwnershipTransferred =
          isPendingDelegationReply &&
          turnExecution.claimClassicDelegationReply(turnToken);
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
        if (
          !delegationOwnershipTransferred &&
          !turnExecution.claim('classic-brain', turnToken)
        ) {
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
        // Audio without a final transcript is enough to preserve what the user
        // heard, but an automatic reply capture cannot renew itself from audio
        // alone. Otherwise TV/room speech keeps the session in a perpetual
        // listen → answer → listen loop. Explicit wake/click still gets one
        // continuity window; valid transcripts and tools use their own paths.
        if (!claimed && turnExecution.owner === 'realtime-tool') {
          releaseAfterRealtimeTool();
        } else {
          const rearmAudioOnly = claimed && (
            shouldRearmAfterAudioOnly(activeCaptureReason) ||
            (activeCaptureReason === 'reply' && localSpeechUsable)
          );
          releaseAfterLiveProviderAnswer({
            busy,
            capture,
            beginListening: deps.beginListening,
            wakeAutoStop: deps.wakeAutoStop,
            armFollowUp: rearmAudioOnly,
            followUpSkipReason:
              claimed && !rearmAudioOnly ? 'audio-only-reply' : 'turn-owned-before-audio',
            canReopen: canReopenLiveFollowUp,
          });
        }
        return;
      }
      const explicitCapture = shouldFallbackClassicAfterRealtimeMute(
        activeCaptureReason,
      );
      let rescueShouldDegradeToClassic = false;
      if (
        shouldAttemptLiveMuteRescue({
          realtimeIsOwner,
          localSpeechUsable,
          explicitCapture,
          offeredFrames,
          captureReason: activeCaptureReason,
          // A reply capture is an explicit, short-lived user turn that was
          // opened by Jarvis herself. Its recovery must not depend on the
          // shorter passive no-wake bridge: otherwise a valid answer spoken
          // late in the 28s capture was dropped when Live missed its frames.
          // Passive audio remains separately fail-closed in voice-controller.
          followUpAuthorized: activeCaptureReason === 'reply',
        }) &&
        peekPendingDelegation(Date.now()) === null
      ) {
        cachedStt = await transcribeCapture();
        const rescueTranscript =
          cachedStt.ok && cachedStt.discarded !== 'echo'
            ? filteredLiveRescueTranscript(cachedStt.text)
            : null;
        const pendingDelegation = peekPendingDelegation(Date.now()) !== null;
        // The capture is already the authorization boundary. Requiring a
        // command-shaped sentence here made ordinary answers to Jarvis (and
        // short confirmations without a pending delegation) disappear after a
        // transient Live miss. It is not a passive STT result.
        const authorizedReplyTranscript =
          activeCaptureReason !== 'reply' ||
          pendingDelegation ||
          rescueTranscript !== null;
        if (rescueTranscript && authorizedReplyTranscript) {
          if (activeCaptureReason === 'reply') followUpAuthority.clear();
          const attempt = markLiveMuteRescueAttempt();
          const rescueStartedAt = Date.now();
          const rescueTurnId = `${turnToken}:${rescueStartedAt}`;
          const rescuePlayedBaseline = realtimeAudioPlayedCounter.total;
          const rescueHeldBaseline = realtimeAudioSuppressedCounter.total;
          logVoiceEvent(
            'warn',
            'jarvis.liveMuteRescue',
            activeCaptureReason === 'reply'
              ? 'follow-up mudo — STT local reenviado ao Live (continuidade)'
              : 'turno realtime sem frames — STT local reenviado como texto',
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
            const rescueOutcome = liveAnswerOutcomeFromEvidence(evidence);
            if (rescueOutcome === 'abort') return;
            if (rescueOutcome === 'commit') {
              const claimedRealtimeAudio =
                evidence === 'audio' && turnExecution.claim('realtime-audio', turnToken);
              resetLiveMuteRescues();
              replyMuteReopenCount = 0;
              store.setNote(null);
              logVoiceEvent(
                'info',
                'jarvis.liveMuteRescueRecovered',
                'resgate confirmado por evidência do provider',
                { turnId: rescueTurnId, evidence },
              );
              if (evidence === 'tool') {
                releaseAfterRealtimeTool();
              } else {
                releaseAfterLiveProviderAnswer({
                  busy,
                  capture,
                  beginListening: deps.beginListening,
                  wakeAutoStop: deps.wakeAutoStop,
                  armFollowUp: claimedRealtimeAudio || activeCaptureReason === 'reply',
                  followUpSkipReason: 'turn-owned-before-audio',
                  canReopen: canReopenLiveFollowUp,
                });
              }
              return;
            }
            rescueShouldDegradeToClassic = true;
          } else {
            // The provider refused the already-authorized local transcript;
            // Classic must own it instead of returning the user to silence.
            rescueShouldDegradeToClassic = true;
          }
          logVoiceEvent(
            'warn',
            'jarvis.liveMuteRescueTimeout',
            activeCaptureReason === 'reply'
              ? 'resgate follow-up sem evidência — reabre escuta (sem teardown)'
              : 'resgate sem evidência — teardown antes do Classic',
            { turnId: rescueTurnId, reason: activeCaptureReason },
          );
          store.setNote(null);
          // Follow-up: never hard-kill a healthy Live socket — reopen listen.
          if (activeCaptureReason !== 'reply') {
            await window.nexus.voice.liveHardTeardown().catch(() => null);
          }
        }
      }
      // Automatic reply capture can be ambient noise/echo; never turn that
      // into a Classic self-talk loop. Explicit wake/click/PTT/manual capture,
      // however, must degrade when Live produced neither audio nor transcript.
      if (
        realtimeIsOwner &&
        !explicitCapture &&
        !rescueShouldDegradeToClassic
      ) {
        // Continuidade: reabre escuta enquanto Live está quente. Nunca desligar
        // realtimeTurnActive com socket vivo — isso era "cade o realtime".
        const sessionStillHot = isRealtimeLive();
        const canRetryListen =
          activeCaptureReason === 'reply' &&
          sessionStillHot &&
          (++replyMuteReopenCount <= MAX_REPLY_MUTE_REOPENS);
        logVoiceEvent(
          'info',
          canRetryListen ? 'jarvis.replyMuteReopen' : 'jarvis.replyMuteIdle',
          canRetryListen
            ? 'follow-up mudo — reabre escuta em vez de idle'
            : 'follow-up sem resposta Live — idle (sessão ainda quente se Live up)',
          {
            reason: activeCaptureReason,
            waitedMs: Date.now() - tRealtime,
            reopenCount: replyMuteReopenCount,
            sessionStillHot,
          },
        );
        openLiveAudioGate();
        store.setStatus('idle');
        busy.current = false;
        if (canRetryListen) {
          releaseAfterLiveProviderAnswer({
            busy,
            capture,
            beginListening: deps.beginListening,
            wakeAutoStop: deps.wakeAutoStop,
            armFollowUp: true,
            // Token do turno, como os demais canReopen: um powerOff (que abre
            // turno novo) mata esta continuidade em vez de reabrir a escuta.
            canReopen: () => turnExecution.currentToken === turnToken,
          });
        } else {
          replyMuteReopenCount = 0;
          // Only kill streaming when Live is already dead. Hot session keeps
          // realtimeTurnActive so the next passive/hot inject still streams.
          if (!sessionStillHot) {
            setRealtimeTurnActive(false);
          }
        }
        return;
      }
      // No realtime response for an explicit capture, or an authorized reply
      // rescue timed out. Keep the socket warm until local STT proves this was
      // meaningful speech: a bare wake/noise must not tear down Gemini or invoke
      // Classic TTS just because the provider missed that one turn.
      realtimeMuteDegrade = true;
      quiesceLiveBeforeClassic = true;
      logVoiceEvent(
        'warn',
        'jarvis.realtimeMuteDegraded',
        'realtime mudo (sem áudio/transcript) — validando STT antes do fallback Classic',
        { reason: activeCaptureReason, waitedMs: Date.now() - tRealtime },
      );
      console.log(
        `[voice] realtime sem transcript final em ${Date.now() - tRealtime}ms (janela ${transcriptWaitMs}ms) — fallback Classic STT (degradado)`,
      );
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
      if (quiesceLiveBeforeClassic) {
        cancelMutedLiveValidation('classic-validation-stt-failed');
        logVoiceEvent(
          'warn',
          'jarvis.classicValidationFailed',
          'STT local não confirmou o fallback; Gemini permanece disponível',
          { reason: activeCaptureReason },
        );
        store.setNote('Não consegui confirmar sua fala. Pode repetir?');
        store.setStatus('idle');
        liveEndTurn();
        return;
      }
      store.setError(stt.error);
      liveStatus('error', stt.error);
      return;
    }
    if (stt.discarded === 'echo') {
      cancelMutedLiveValidation('classic-validation-echo');
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
      cancelMutedLiveValidation('classic-validation-ack-only');
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
      cancelMutedLiveValidation('classic-validation-empty');
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
      cancelMutedLiveValidation('classic-validation-discarded');
      console.log(`[voice] transcrição-lixo do Whisper descartada: "${transcript}"`);
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    if (activeCaptureReason === 'reply' && isLikelyNoiseTranscript(transcript)) {
      cancelMutedLiveValidation('classic-validation-noise');
      console.log(`[voice] reply-lixo descartado antes do cérebro: "${transcript}"`);
      logVoiceEvent('info', 'jarvis.replyNoiseDiscarded', 'reply ruído/eco garbled descartado', {
        text: transcript.slice(0, 120),
        reason: activeCaptureReason,
      });
      store.setStatus('idle');
      liveEndTurn();
      return;
    }
    if (quiesceLiveBeforeClassic) {
      const lateProviderAudio = hasRealtimeProviderAudioAnswer({
        heldChunks: realtimeAudioSuppressedCounter.total - realtimeHeldChunksBaseline,
        playedChunks: realtimeAudioPlayedCounter.total - realtimePlayedChunksBaseline,
      });
      // A late provider tool/audio event owns this turn. Never tear down that
      // healthy Live response underneath it while local STT is still finishing.
      if (
        turnExecution.currentToken !== turnToken ||
        turnExecution.owner !== null ||
        hasRealtimeNativeToolSince(realtimeStartedAt) ||
        lateProviderAudio
      ) {
        logVoiceEvent(
          'info',
          'jarvis.classicFallbackCancelled',
          'fallback Classic cancelado — provider retomou o turno',
          { owner: turnExecution.owner, lateProviderAudio },
        );
        return;
      }
      setSuppressRealtimeAudioOut(true);
      resetPendingRealtimeAudioOut();
      await quiesceLiveForClassic('classic-action-bridge-timeout');
      setRealtimeTurnActive(false);
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

    // Ditado (speakMode off): inject and done — peer ADE NexusVoice does not
    // wait for the agent reply or speak a summary back.
    if (store.info?.speakMode === 'off') {
      store.setStatus('idle');
      return;
    }

    const reply = await captureResponse(paneId, transcript);
    if (reply.trim()) {
      store.setSpoken(reply);
      if (!isResponseMuted()) {
        store.setStatus('speaking');
        const spoken = await withTimeout(
          window.nexus.voice.speak({ text: reply }),
          SPEAK_DEADLINE_MS_LOCAL,
          'TTS',
        );
        if (spoken.ok) {
          if (spoken.fallbackNote) store.setNote(spoken.fallbackNote);
          if (spoken.mode === 'audio') await playAudioBase64(spoken.audioBase64, spoken.format);
        } else {
          store.setError(spoken.error);
          return;
        }
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
