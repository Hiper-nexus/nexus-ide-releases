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
  queueLiveContextRefresh,
} from './voice-live-ipc';
import {
  REALTIME_PROVIDER_AUDIO_ENABLED,
  bumpRealtimeNativeToolInFlight,
  ensureLivePlayer,
  setLastRealtimeNativeToolAt,
  setSuppressRealtimeAudioOut,
  turnExecution,
  wakeMic,
} from './voice-session-state';
import {
  openLiveAudioGate,
  resetPendingRealtimeAudioOut,
} from './voice-live-audio-out';
import { isRealtimeLive } from './voice-realtime-gates';
import { stopAllPlayback } from './voice-playback';
import { speakAndPlayPipelined } from './voice-speak-pipeline';
import { realtimeToolEventToJarvisAction } from './realtime-action';
import type { JarvisAction, JarvisLiveToolEvent } from '../../shared/voice-ipc';

export async function executeJarvisActionForTurn(
  ...args: Parameters<typeof executeJarvisAction>
): ReturnType<typeof executeJarvisAction> {
  try {
    return await executeJarvisAction(...args);
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
  try {
    const state = await window.nexus.voice.liveSay({ text: trimmed });
    useVoiceStore.getState().setLiveState(state);
    if (!state.realtimeReady || state.status === 'error') {
      setSuppressRealtimeAudioOut(true);
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
  const action: JarvisAction | null = realtimeToolEventToJarvisAction(event);
  setLastRealtimeNativeToolAt(Date.now());
  bumpRealtimeNativeToolInFlight(1);
  const store = useVoiceStore.getState();
  try {
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

    if (!turnExecution.claim('realtime-tool', turnExecution.currentToken)) {
      console.log('[voice] tool-call realtime ignorado; turno já reivindicado pelo Classic');
      logVoiceEvent('info', 'jarvis.realtimeActionSkipped', 'turno já reivindicado pelo Classic', {
        callId: event.callId,
        tool: action.type,
      });
      window.nexus.voice.liveToolResult({
        source: 'realtime',
        callId: event.callId,
        name: event.name,
        tool: action.type,
        ok: true,
        summary: 'já processado',
        args: event.args,
        output: { ok: true, summary: 'já processado pelo Classic', tool: action.type },
      });
      return;
    }

    store.setStatus('routing');
    liveStatus('thinking');
    const context = buildJarvisContext();
    const reply = { say: '', action };
    const exec = await executeJarvisActionForTurn(reply, context);
    const toolResult = exec.toolResult ?? {
      tool: action.type,
      ok: true,
      summary: exec.sayText.trim() || 'executado',
    };
    logVoiceEvent(
      toolResult.ok ? 'info' : 'warn',
      'jarvis.realtimeActionResult',
      toolResult.summary,
      { tool: toolResult.tool, ok: toolResult.ok, callId: event.callId },
    );
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
        // Overclock: tool response carries what to narrate (confirmation ask, etc.).
        ...(exec.sayText.trim() ? { say: exec.sayText.trim() } : {}),
      },
    });
    queueLiveContextRefresh();

    if (toolResult.ok) {
      void window.nexus.gamification
        .recordJarvisAction({ actionType: toolResult.tool, ok: true })
        .then((snap) => useGamificationStore.getState().receive(snap))
        .catch(() => {});
    }

    if (!REALTIME_PROVIDER_AUDIO_ENABLED) {
      const sayText =
        exec.sayText.trim() ||
        (toolResult.ok ? 'Feito, patrão.' : `Não consegui: ${toolResult.summary}.`);
      await speakRealtimeToolResult(sayText);
    } else {
      // Live narrates the tool result — keep the audio gate open.
      openLiveAudioGate();
      if (exec.sayText.trim() || toolResult.ok === false) {
        store.setStatus('speaking');
        liveStatus('speaking');
      }
    }
  } catch (err) {
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
    bumpRealtimeNativeToolInFlight(-1);
    // Do NOT force idle while Live is still speaking the tool narration —
    // that raced follow-up capture and re-muted audio mid-sentence.
    const currentStatus = useVoiceStore.getState().status;
    if (currentStatus === 'routing') {
      useVoiceStore.getState().setStatus('idle');
    }
  }
}
