/**
 * runJarvisTurn + captureResponse + routePrompt — extracted from voice-controller.
 *
 * Deps (beginListening, isListening, finishAndProcess) are injected to avoid
 * circular imports with voice-controller.ts.
 */
import type React from 'react';
import { useVoiceStore } from './voice-store';
import { useGamificationStore } from '../state/gamification-store';
import {
  getPaneSessionId,
  submitPromptToPane,
  submitPromptToPaneConfirmed,
  submitPromptToPaneOperatorInput,
} from '../terminal/terminal-host';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { listPanes } from '../lib/split-tree';
import { pickFallbackInScope } from '../lib/pane-spaces';
import { deliverDictationToClaim } from './dictation-target';
import {
  deliverDictation,
  type DictationRouteResult,
} from './dictation-delivery';
import { useSessionStateStore } from '../state/session-state-store';
import { buildJarvisContext, findOrchestratorPane } from './jarvis-screen-context';
import {
  liveEndTurn,
  liveStatus,
  logVoiceEvent,
  quiesceLiveForClassic,
  queueLiveContextRefresh,
} from './voice-live-ipc';
import {
  activeCaptureReason,
  jarvisHistory,
  jarvisLastTurnAt,
  livePlayer,
  realtimeTurnActive,
  setJarvisHistory,
  setJarvisLastTurnAt,
  setSuppressRealtimeAudioOut,
  turnExecution,
  wakeMic,
} from './voice-session-state';
import { isJarvisLiveEnabled, isRealtimeLive, canAttemptRealtime } from './voice-realtime-gates';
import {
  speakAndPlayPipelined,
  withTimeout,
} from './voice-speak-pipeline';
import { executeJarvisActionForTurn, speakViaLiveProvider } from './voice-realtime-tools';
import {
  delay,
  noteAutoReplyOpened,
  shouldReopenJarvisListening,
  type JarvisCaptureReason,
} from './jarvis-reply-loop';
import {
  buildReplyAutoStop,
  REPLY_MIN_LISTEN_MS,
} from './voice-echo-guard';
import {
  estimatedSpeechMs,
  playbackWakeSuppressionMs,
  replyReopenDelayMs,
  TTS_TAIL_GUARD_MS,
} from './voice-suppression-window';
import { stripPromptEcho } from './response-echo';
import type { VoiceCapture, AutoStopOptions } from './voice-capture';
import { resolveDelegationReply } from './delegation-confirm';
import { isClassicActionGrounded } from './classic-action-grounding';
import { followUpAuthority } from './follow-up-authority';
import { logVoiceTurnMilestone } from './voice-turn-telemetry';

const BRAIN_DEADLINE_MS_LOCAL = 35_000;
const JARVIS_MEMORY_MS_LOCAL = 300_000;
const RESPONSE_QUIET_MS = 1_500;
const RESPONSE_MAX_MS = 20_000;

/** Injected callbacks — avoids circular imports with voice-controller.ts. */
export interface RunJarvisTurnDeps {
  beginListening: (
    capture: VoiceCapture,
    autoStop: AutoStopOptions | undefined,
    reason: JarvisCaptureReason,
    preRollSeed: Float32Array[] | undefined,
    busy: React.MutableRefObject<boolean>,
  ) => Promise<void>;
  isListening: (capture: VoiceCapture | null) => boolean;
  finishAndProcess: (
    capture: VoiceCapture,
    busy: React.MutableRefObject<boolean>,
  ) => Promise<void>;
}

export async function runJarvisTurn(
  transcript: string,
  capture: VoiceCapture,
  busy: React.MutableRefObject<boolean>,
  turnToken: number,
  deps: RunJarvisTurnDeps,
): Promise<void> {
  const store = useVoiceStore.getState();
  const isTurnCurrent = (): boolean => turnExecution.currentToken === turnToken;
  const turnId = String(turnToken);
  logVoiceTurnMilestone(turnId, 'turn_committed', {
    path: 'classic',
    reason: activeCaptureReason,
    transcriptChars: transcript.length,
  });

  // C3: se há missão aguardando "Confirmo?", esta fala é a resposta — resolve
  // ANTES do cérebro (o cérebro veria "sim" solto e responderia qualquer coisa).
  const delegationReply = resolveDelegationReply(transcript, Date.now());
  if (delegationReply.kind === 'drop') {
    // Follow-up 4a: descarte não pode ser MUDO — HUD avisa e o turno segue
    // normal pro cérebro (a fala era outro assunto, ela ainda merece resposta).
    store.setNote('Missão pro squad descartada — confirmação não veio.');
    logVoiceEvent('info', 'jarvis.delegationDropped', 'pendência descartada sem confirmação', {
      transcript: transcript.slice(0, 120),
      chars: delegationReply.delegation.text.length,
    });
  } else if (delegationReply.kind !== 'none') {
    let say = 'Cancelei a missão.';
    if (delegationReply.kind === 'dispatch') {
      logVoiceTurnMilestone(turnId, 'first_tool_call', {
        path: 'classic',
        tool: 'send_to_pane',
      });
      const ok = submitPromptToPane(
        delegationReply.delegation.targetPaneId,
        delegationReply.delegation.text,
      );
      say = ok
        ? 'Missão confirmada e enviada ao squad.'
        : 'Não consegui escrever no pane do squad.';
      logVoiceEvent(ok ? 'info' : 'warn', 'jarvis.delegationDispatched', say, {
        ok,
        chars: delegationReply.delegation.text.length,
      });
      if (ok) {
        logVoiceTurnMilestone(turnId, 'effect_confirmed', {
          path: 'classic',
          tool: 'send_to_pane',
        });
      }
    } else {
      logVoiceEvent('info', 'jarvis.delegationCancelled', 'usuário recusou a missão', {});
    }
    setSuppressRealtimeAudioOut(true);
    livePlayer?.stop();
    await quiesceLiveForClassic('classic-delegation-tts');
    store.setStatus('speaking');
    const spoken = await speakAndPlayPipelined(say, isTurnCurrent, () => {
      logVoiceTurnMilestone(turnId, 'first_audio', { path: 'classic' });
    });
    if (spoken.ok && !spoken.cancelled) {
      store.setSpoken(say);
      void window.nexus.voice.recordEcho(say);
      wakeMic.suppressWakeDetection(
        spoken.playedMs > 0
          ? TTS_TAIL_GUARD_MS
          : playbackWakeSuppressionMs(estimatedSpeechMs(say.length)),
      );
    }
    store.setStatus('idle');
    liveEndTurn();
    return;
  }

  const now = Date.now();
  if (now - jarvisLastTurnAt > JARVIS_MEMORY_MS_LOCAL) setJarvisHistory([]);
  setJarvisLastTurnAt(now);

  const context = buildJarvisContext();

  store.setStatus('routing');
  const tBrain = Date.now();
  const reply = await withTimeout(
    window.nexus.voice.jarvis({ transcript, context, history: jarvisHistory }),
    BRAIN_DEADLINE_MS_LOCAL,
    'cérebro',
  );
  const brainMs = Date.now() - tBrain;
  console.log(`[voice] cérebro: ${brainMs}ms`);
  logVoiceEvent('info', 'jarvis.brainReply', reply.say, {
    latencyMs: brainMs,
    action: reply.action.type,
    expectReply: reply.expectReply === true,
  });
  const newHistory = [
    ...jarvisHistory,
    { role: 'user' as const, content: transcript },
    { role: 'assistant' as const, content: reply.say },
  ];
  const maxTurns = isJarvisLiveEnabled()
    ? (useVoiceStore.getState().info?.jarvisLive.maxWindowTurns ?? 12)
    : 10;
  setJarvisHistory(
    newHistory.length > maxTurns * 2 ? newHistory.slice(-(maxTurns * 2)) : newHistory,
  );

  if (!isClassicActionGrounded(transcript, reply.action)) {
    logVoiceEvent('warn', 'jarvis.classicActionUngrounded', 'ação Classic bloqueada sem intenção correspondente', {
      action: reply.action.type,
      transcriptChars: transcript.length,
    });
    reply.action = { type: 'none' };
    reply.expectReply = false;
    reply.say = 'Não executei nenhuma ação porque não identifiquei um pedido claro.';
  }
  if (reply.action.type !== 'none') {
    logVoiceTurnMilestone(turnId, 'first_tool_call', {
      path: 'classic',
      tool: reply.action.type,
    });
  }
  const exec = await executeJarvisActionForTurn(reply, context);
  let sayText = exec.sayText;
  if (exec.expectReply !== undefined) reply.expectReply = exec.expectReply;
  const toolResult = exec.toolResult;
  if (toolResult) {
    logVoiceEvent(toolResult.ok ? 'info' : 'warn', 'jarvis.actionResult', toolResult.summary, {
      tool: toolResult.tool,
      ok: toolResult.ok,
    });
    if (toolResult.ok) {
      logVoiceTurnMilestone(turnId, 'effect_confirmed', {
        path: 'classic',
        tool: toolResult.tool,
      });
    }
  }

  // Follow-up 4a: se este turno começou com um drop de delegação, a nota de
  // aviso já foi setada acima — não deixa a limpeza de nota da ação seguinte
  // apagar a mensagem de descarte no mesmo turno.
  const keepDropNote = delegationReply.kind === 'drop';
  if (reply.action.type !== 'none' && toolResult?.ok) {
    if (!keepDropNote) useVoiceStore.getState().setNote(null);
    void window.nexus.gamification
      .recordJarvisAction({ actionType: reply.action.type, ok: true })
      .then((snap) => useGamificationStore.getState().receive(snap))
      .catch(() => {});
  }

  if (toolResult && isJarvisLiveEnabled()) {
    window.nexus.voice.liveToolResult(toolResult);
    queueLiveContextRefresh();
  }

  if (!sayText.trim()) {
    store.setSpoken('');
    store.setStatus('idle');
    liveEndTurn();
    return;
  }

  if (!isTurnCurrent()) {
    console.log('[voice] turno superado antes de falar — resposta fantasma descartada');
    logVoiceEvent('info', 'jarvis.ghostReplyDiscarded', 'turno superado antes de falar', {
      reason: activeCaptureReason,
    });
    return;
  }

  const wantsReply = shouldReopenJarvisListening({
    expectReply: reply.expectReply === true,
    sayText,
    realtimeTurnActive,
    isRealtimeLive: isRealtimeLive(),
    captureReason: activeCaptureReason,
  });
  if (!wantsReply) {
    if (await speakViaLiveProvider(sayText)) {
      store.setSpoken(sayText);
      return;
    }
    if (canAttemptRealtime(useVoiceStore.getState().info)) {
      logVoiceEvent(
        'warn',
        'jarvis.liveSpeakDegraded',
        'Live não falou — Classic TTS assume',
        { text: sayText.slice(0, 80), action: reply.action.type },
      );
    }
  }

  setSuppressRealtimeAudioOut(true);
  livePlayer?.stop();
  await quiesceLiveForClassic('classic-tts');

  store.setStatus('speaking');
  liveStatus('speaking');
  const tTts = Date.now();
  const spoken = await speakAndPlayPipelined(sayText, isTurnCurrent, () => {
    logVoiceTurnMilestone(turnId, 'first_audio', { path: 'classic' });
  });
  console.log(`[voice] tts: ${Date.now() - tTts}ms`);
  if (!spoken.ok) {
    store.setError(spoken.error);
    return;
  }
  if (spoken.cancelled) {
    console.log('[voice] síntese concluída em turno superado — playback cancelado (sem fantasma)');
    logVoiceEvent('info', 'jarvis.ghostReplyDiscarded', 'síntese concluída em turno superado', {
      reason: activeCaptureReason,
      synthMs: Date.now() - tTts,
    });
    return;
  }
  store.setSpoken(sayText);
  store.setStatus('idle');
  void window.nexus.voice.recordEcho(sayText);

  const postTtsSuppressionMs =
    spoken.playedMs > 0
      ? TTS_TAIL_GUARD_MS
      : playbackWakeSuppressionMs(estimatedSpeechMs(sayText.length));
  wakeMic.suppressWakeDetection(postTtsSuppressionMs);
  if (wantsReply) {
    busy.current = false;
    const reopenDelay = replyReopenDelayMs();
    wakeMic.suppressWakeDetection(reopenDelay + REPLY_MIN_LISTEN_MS);
    await delay(reopenDelay);
    noteAutoReplyOpened({ sayText });
    const authorityDeadline = followUpAuthority.arm();
    logVoiceEvent('info', 'jarvis.followUpAuthorityArmed', 'janela Classic sem wake autorizada', {
      durationMs: Math.round(followUpAuthority.remainingMs()),
      deadlineMonotonicMs: Math.round(authorityDeadline),
      source: 'classic-reply',
    });
    void deps.beginListening(
      capture,
      buildReplyAutoStop(() => {
        if (deps.isListening(capture)) void deps.finishAndProcess(capture, busy);
      }),
      'reply',
      undefined,
      busy,
    );
  } else {
    liveEndTurn();
  }
}

/** Route transcribed prompt into focused/orchestrator pane PTY. */
export function routePrompt(text: string): string | null {
  const { focusedPaneId, root } = useLayoutStore.getState();
  const routing = useVoiceStore.getState().info?.routing ?? 'focused-pane';
  // Orquestrador do MESMO escopo do foco: a fala da missão A nunca vai para o
  // orquestrador da missão B (isolamento de campo A/B).
  const targetPaneId =
    routing === 'orchestrator'
      ? findOrchestratorPane(root, focusedPaneId) ?? focusedPaneId
      : focusedPaneId;
  if (!targetPaneId) return null;
  const ok = submitPromptToPane(targetPaneId, text);
  return ok ? targetPaneId : null;
}

/**
 * Ditado (Space na janela): injeta no pane focado (ou num fallback vivo),
 * ignorando o routing global (que pode estar em 'jarvis'/'orchestrator' para os
 * gatilhos Jarvis). Entrega CONFIRMADA — reporta a verdade ao HUD em vez do
 * false-green do fire-and-forget: o resultado só é `ok` quando o PTY confirma a
 * injeção. Cada salto (emit → resolução → IPC → escrita) vai pro voice.log via
 * logVoiceEvent, então uma morte silenciosa futura fica rastreável.
 */
export function routeDictation(text: string): Promise<DictationRouteResult> {
  // Superfície de UI com claim ativo (wizard de missão) vence o roteamento
  // de panes: o operador está ditando o formulário, não um terminal.
  const uiDelivery = deliverDictationToClaim(text);
  if (uiDelivery) {
    logVoiceEvent('info', 'dictation.uiTarget', 'ditado entregue à UI', {
      target: uiDelivery.paneId,
      chars: text.length,
    });
    return Promise.resolve({ ok: true, paneId: uiDelivery.paneId });
  }
  return deliverDictation(text, {
    getFocusedPaneId: () => useLayoutStore.getState().focusedPaneId,
    listLivePaneIds: () => {
      const { focusedPaneId, root } = useLayoutStore.getState();
      const panes = listPanes(root);
      const paneMissions = useOrchStore.getState().paneMissions;
      const liveIds = panes
        .map((pane) => pane.id)
        .filter((id) => getPaneSessionId(id) != null);
      // Mesmo contrato de pickFallbackInScope: só panes do escopo do foco.
      // Foco sumiu da árvore → lista vazia (nunca invade o campo vizinho).
      return liveIds.filter(
        (id) =>
          pickFallbackInScope([id], focusedPaneId, panes, paneMissions) !== null,
      );
    },
    getSessionId: (paneId) => getPaneSessionId(paneId),
    deliverConfirmed: (paneId, promptText, sessionId) =>
      submitPromptToPaneConfirmed(paneId, promptText, sessionId),
    deliverOperator: (paneId, promptText, sessionId) =>
      submitPromptToPaneOperatorInput(paneId, promptText, sessionId),
    log: logVoiceEvent,
  });
}

/** Accumulate PTY output after prompt injection and resolve with agent reply. */
export function captureResponse(paneId: string, promptEcho: string): Promise<string> {
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
    const unsubState = useSessionStateStore.subscribe((s) => {
      const state = s.paneStates.get(paneId);
      if (state === 'busy') sawBusy = true;
      else if (state === 'idle' && sawBusy) finish();
    });
    const hardCap = setTimeout(finish, RESPONSE_MAX_MS);
    armQuiet();
  });
}
