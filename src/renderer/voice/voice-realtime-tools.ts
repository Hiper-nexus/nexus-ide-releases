/**
 * Realtime tool execution + Live provider speak helpers.
 * Extracted from voice-controller for the 800-line budget.
 */
import { useVoiceStore } from './voice-store';
import { useGamificationStore } from '../state/gamification-store';
import { executeJarvisAction } from './jarvis-action-executor';
import { buildJarvisContext } from './jarvis-screen-context';
import {
  clearJarvisMcpSession,
  errMsg,
  logVoiceEvent,
  liveStatus,
  quiesceLiveForClassic,
  queueLiveContextRefresh,
} from './voice-live-ipc';
import {
  REALTIME_PROVIDER_AUDIO_ENABLED,
  bumpRealtimeNativeToolInFlight,
  ensureLivePlayer,
  setLastRealtimeNativeToolCallId,
  lastRealtimeNativeToolAt,
  realtimeAudioPlayedCounter,
  realtimeNativeToolInFlight,
  setLastRealtimeNativeToolAt,
  setSuppressRealtimeAudioOut,
  turnExecution,
  wakeMic,
} from './voice-session-state';
import {
  openLiveAudioGate,
  resetPendingRealtimeAudioOut,
} from './voice-live-audio-out';
import {
  waitForLiveSpeakEvidence,
  type LiveSpeakEvidenceSnapshot,
} from './voice-live-speak-evidence';
import { isRealtimeLive } from './voice-realtime-gates';
import { stopAllPlayback } from './voice-playback';
import { speakAndPlayPipelined } from './voice-speak-pipeline';
import { realtimeToolEventToJarvisAction } from './realtime-action';
import type { JarvisAction, JarvisLiveToolEvent } from '../../shared/voice-ipc';
import {
  beginRealtimeToolExecution,
  type RealtimeToolExecution,
} from './realtime-tool-execution';
import { cancelLiveFollowUp } from './live-followup';
import {
  persistRuntimeIncidents,
  superviseJarvisAction,
} from './runtime-incident-supervisor';
import { useToastStore } from '../state/toast-store';
import { armRealtimeToolNarration } from './realtime-tool-narration';

export async function executeJarvisActionForTurn(
  ...args: Parameters<typeof executeJarvisAction>
): ReturnType<typeof executeJarvisAction> {
  try {
    const [reply, context, control = {}] = args;
    const supervised = await superviseJarvisAction(
      reply.action,
      (supervisedControl) => executeJarvisAction(reply, context, supervisedControl),
      control,
    );
    persistRuntimeIncidents(supervised.incidents);
    for (const runtimeIncident of supervised.incidents) {
      logVoiceEvent(
        runtimeIncident.recovered ? 'warn' : 'error',
        'runtime.incident',
        runtimeIncident.message,
        {
          incidentId: runtimeIncident.id,
          action: runtimeIncident.action,
          code: runtimeIncident.code,
          attempt: runtimeIncident.attempt,
          recovered: runtimeIncident.recovered,
          effectMayHaveCommitted: runtimeIncident.effectMayHaveCommitted,
        },
      );
    }
    const unresolved = supervised.incidents.findLast((item) => !item.recovered);
    if (unresolved) {
      useVoiceStore.getState().setNote(
        `Falha de execução: ${unresolved.action} — ${unresolved.message}`,
      );
      useToastStore.getState().push(
        'error',
        'Uma ação da Jarvis falhou',
        `${unresolved.action}: ${unresolved.message}`,
      );
    }
    return supervised.result;
  } finally {
    await clearJarvisMcpSession();
  }
}

export async function speakRealtimeToolResult(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const store = useVoiceStore.getState();
  stopAllPlayback();
  store.setStatus('speaking');
  liveStatus('speaking');
  const spoken = await speakAndPlayPipelined(trimmed);
  if (!spoken.ok) {
    store.setError(spoken.error);
    return;
  }
  store.setSpoken(trimmed);
  void window.nexus.voice.recordEcho(trimmed);
  wakeMic.suppressWakeDetection(
    Math.min(12_000, Math.max(3_500, trimmed.length * 70 + 2_000)),
  );
}

export async function speakViaLiveProvider(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed || !REALTIME_PROVIDER_AUDIO_ENABLED || !isRealtimeLive()) return false;
  openLiveAudioGate();
  resetPendingRealtimeAudioOut();
  ensureLivePlayer().stop?.();
  stopAllPlayback();
  wakeMic.suppressWakeDetection(
    Math.min(12_000, Math.max(3_500, trimmed.length * 70 + 2_000)),
  );
  const baseline: LiveSpeakEvidenceSnapshot = {
    audioPlayed: realtimeAudioPlayedCounter.total,
    nativeToolInFlight: realtimeNativeToolInFlight,
    lastNativeToolAt: lastRealtimeNativeToolAt,
  };
  try {
    const state = await window.nexus.voice.liveSay({ text: trimmed });
    useVoiceStore.getState().setLiveState(state);
    if (!state.realtimeReady || state.status === 'error') {
      setSuppressRealtimeAudioOut(true);
      return false;
    }
    const evidence = await waitForLiveSpeakEvidence({
      baseline,
      read: () => ({
        audioPlayed: realtimeAudioPlayedCounter.total,
        nativeToolInFlight: realtimeNativeToolInFlight,
        lastNativeToolAt: lastRealtimeNativeToolAt,
      }),
    });
    if (evidence === 'none') {
      setSuppressRealtimeAudioOut(true);
      resetPendingRealtimeAudioOut();
      ensureLivePlayer().stop?.();
      await quiesceLiveForClassic('live-say-no-evidence');
      logVoiceEvent(
        'warn',
        'jarvis.liveSayNoEvidence',
        'Live ficou mudo — Classic assume após quiescência',
        { chars: trimmed.length },
      );
      return false;
    }
    useVoiceStore.getState().setStatus('speaking');
    return true;
  } catch (err) {
    setSuppressRealtimeAudioOut(true);
    console.warn('[voice] liveSay falhou; TTS Classic assume:', errMsg(err));
    return false;
  }
}

export async function executeRealtimeToolCall(event: JarvisLiveToolEvent): Promise<void> {
  if (!event.callId || !event.name || event.source !== 'realtime') return;
  if (event.name !== 'nexus_action') return;
  const claim = beginRealtimeToolExecution(event.sessionId, event.callId);
  if (claim.status !== 'started') {
    logVoiceEvent('warn', 'jarvis.realtimeActionDeduped', 'callId não executado novamente', {
      callId: event.callId,
      status: claim.status,
      effectMayHaveCommitted: claim.effectMayHaveCommitted,
    });
    return;
  }
  const execution: RealtimeToolExecution = claim.execution;
  const action: JarvisAction | null = realtimeToolEventToJarvisAction(event);
  setLastRealtimeNativeToolAt(Date.now());
  bumpRealtimeNativeToolInFlight(1);
  const store = useVoiceStore.getState();
  try {
    execution.checkpoint();
    if (!action) {
      window.nexus.voice.liveToolResult({
        source: 'realtime',
        callId: event.callId,
        name: event.name,
        tool: 'none',
        ok: false,
        summary: 'ação realtime inválida',
        args: event.args,
        output: { error: 'invalid_action' },
      });
      return;
    }

    if (!turnExecution.claimRealtimeTool(turnExecution.currentToken)) {
      const owner = turnExecution.owner;
      console.log(`[voice] tool-call realtime ignorado; turno já reivindicado por ${owner ?? 'desconhecido'}`);
      logVoiceEvent('warn', 'jarvis.realtimeActionSkipped', 'ação não executada', {
        callId: event.callId,
        tool: action.type,
        owner,
      });
      window.nexus.voice.liveToolResult({
        source: 'realtime',
        callId: event.callId,
        name: event.name,
        tool: action.type,
        ok: false,
        summary: 'ação não executada: o fluxo Classic já assumiu este turno',
        args: event.args,
        output: {
          ok: false,
          error: 'turn_owned_by_classic',
          owner,
          tool: action.type,
        },
      });
      return;
    }

    // A provider may send a tool after its first audio/transcript already
    // armed conversational continuity. The tool result can still be narrated
    // later, so invalidate that pending reply mic before executing the action.
    cancelLiveFollowUp();
    setLastRealtimeNativeToolCallId(event.callId);

    store.setStatus('routing');
    liveStatus('thinking');
    const context = buildJarvisContext();
    const reply = { say: '', action };
    const exec = await executeJarvisActionForTurn(reply, context, {
      signal: execution.signal,
      originCallId: event.callId,
      onEffectMayHaveCommitted: () => execution.markEffectMayHaveCommitted(),
    });
    const toolResult = exec.toolResult ?? {
      tool: action.type,
      ok: true,
      summary: exec.sayText.trim() || 'executado',
    };
    if (toolResult.ok) execution.markEffectMayHaveCommitted();
    execution.checkpoint();
    logVoiceEvent(
      toolResult.ok ? 'info' : 'warn',
      'jarvis.realtimeActionResult',
      toolResult.summary,
      { tool: toolResult.tool, ok: toolResult.ok, callId: event.callId },
    );
    const sayText =
      exec.sayText.trim() ||
      (toolResult.ok ? 'Feito, patrão.' : `Não consegui: ${toolResult.summary}.`);
    if (REALTIME_PROVIDER_AUDIO_ENABLED) {
      armRealtimeToolNarration(
        event.callId,
        sayText,
        realtimeAudioPlayedCounter.total,
      );
    }
    window.nexus.voice.liveToolResult({
      source: 'realtime',
      callId: event.callId,
      name: event.name,
      tool: toolResult.tool,
      ok: toolResult.ok,
      summary: toolResult.summary,
      args: event.args,
      output: {
        ok: toolResult.ok,
        summary: toolResult.summary,
        tool: toolResult.tool,
        ...(toolResult.output !== undefined ? { result: toolResult.output } : {}),
        // Overclock: tool response carries what to narrate (confirmation ask, etc.).
        ...(exec.sayText.trim() ? { say: exec.sayText.trim() } : {}),
      },
    });
    execution.finish();
    queueLiveContextRefresh();

    if (toolResult.ok) {
      void window.nexus.gamification
        .recordJarvisAction({ actionType: toolResult.tool, ok: true })
        .then((snap) => useGamificationStore.getState().receive(snap))
        .catch(() => {});
    }

    if (!REALTIME_PROVIDER_AUDIO_ENABLED) {
      await speakRealtimeToolResult(sayText);
    } else {
      // Live narrates the tool result — keep the audio gate open.
      openLiveAudioGate();
      // Do not predict provider speech. Gemini can finish a failed tool turn
      // without emitting audio/responseDone; marking `speaking` here left the
      // renderer permanently transcribing and every later wake was discarded.
      // The first real PCM chunk is the sole authority that enters speaking.
      store.setStatus('idle');
    }
  } catch (err) {
    if (execution.signal.aborted) {
      const cancellation = execution.signal.reason as
        | { reason?: string; summary?: string }
        | undefined;
      const effectMayHaveCommitted = execution.effectMayHaveCommitted;
      logVoiceEvent(
        'warn',
        'jarvis.realtimeActionCancelled',
        effectMayHaveCommitted
          ? 'cancelada; um efeito pode já ter sido aplicado'
          : 'cancelada antes de aplicar efeito',
        {
          callId: event.callId,
          tool: action?.type ?? 'none',
          reason: cancellation?.reason ?? 'cancelled',
          effectMayHaveCommitted,
        },
      );
      if (effectMayHaveCommitted) {
        window.nexus.voice.liveToolResult({
          source: 'realtime',
          callId: event.callId,
          name: event.name,
          tool: action?.type ?? 'none',
          ok: false,
          summary: 'cancelamento tardio: o efeito pode já ter sido aplicado',
          args: event.args,
          output: {
            error: 'cancelled_after_possible_commit',
            effectMayHaveCommitted: true,
            reason: cancellation?.reason ?? 'cancelled',
          },
        });
      }
      return;
    }
    const message = errMsg(err);
    logVoiceEvent('error', 'jarvis.realtimeActionError', message, {
      callId: event.callId,
      tool: event.tool,
    });
    window.nexus.voice.liveToolResult({
      source: 'realtime',
      callId: event.callId,
      name: event.name,
      tool: action?.type ?? 'none',
      ok: false,
      summary: message,
      args: event.args,
      output: { error: message },
    });
    store.setError(message);
  } finally {
    execution.finish();
    bumpRealtimeNativeToolInFlight(-1);
    // Do NOT force idle while Live is still speaking the tool narration —
    // that raced follow-up capture and re-muted audio mid-sentence.
    const currentStatus = useVoiceStore.getState().status;
    if (currentStatus === 'routing' || currentStatus === 'transcribing') {
      useVoiceStore.getState().setStatus('idle');
    }
  }
}
