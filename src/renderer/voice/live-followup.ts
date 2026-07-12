/**
 * Keep Live hot after the provider answers — reopen mic for the follow-up
 * without requiring another "Hey Jarvis" (Overclock continuity).
 */
import type React from 'react';
import type { JarvisLiveToolTurnCompleteEvent } from '../../shared/voice-ipc';
import type { VoiceCapture } from './voice-capture';
import { delay } from './jarvis-reply-loop';
import { LiveToolFollowUpGate } from './live-tool-followup-gate';
import { logVoiceEvent } from './voice-live-ipc';
import { canAttemptRealtime, isJarvisLiveEnabled } from './voice-realtime-gates';
import {
  livePlayer,
  wakeMic,
  wakeOpenInProgress,
} from './voice-session-state';
import { useVoiceStore } from './voice-store';
import type { AutoStopOptions } from './voice-capture';
import { followUpAuthority } from './follow-up-authority';

/** Bumped on every wake sync reset — stale follow-up arms bail out. */
let followUpGeneration = 0;

export interface LiveFollowUpOptions {
  busy: React.MutableRefObject<boolean>;
  capture: VoiceCapture;
  beginListening: BeginListeningFn;
  wakeAutoStop: (
    capture: VoiceCapture,
    busy: React.MutableRefObject<boolean>,
    reason: 'wake' | 'click',
  ) => import('./voice-capture').AutoStopOptions;
  /** Confirms this exact turn is still owned by the expected Live path. */
  canReopen?: () => boolean;
}

interface ToolFollowUpRequest extends LiveFollowUpOptions {
  sessionId: string;
  turnId: string;
  callId: string;
}

const toolFollowUpGate = new LiveToolFollowUpGate<ToolFollowUpRequest>();

/**
 * Follow-up speech floor. 0.03 matava “nova missão” quieta (logs: speech ok no
 * STT passivo mas Live endpoint nunca abria). SoftAgc + AEC cuidam do ambient;
 * alinhar ao piso de wake (~0.004–0.01) para continuidade real.
 */
export const REPLY_RAW_SPEECH_RMS = 0.008;
/** Continuidade: silêncio um pouco mais curto — Overclock fecha e reabre fluído. */
export const REPLY_FOLLOWUP_SILENCE_MS = 1_200;
export const REPLY_FOLLOWUP_MIN_LISTEN_MS = 1_400;
export const REPLY_FOLLOWUP_MAX_MS = 28_000;

export function buildReplyAutoStop(autoStop: AutoStopOptions): AutoStopOptions {
  return {
    ...autoStop,
    rawSpeechRms: REPLY_RAW_SPEECH_RMS,
    silenceMs: Math.max(autoStop.silenceMs, REPLY_FOLLOWUP_SILENCE_MS),
    minListenMs: Math.max(autoStop.minListenMs ?? 0, REPLY_FOLLOWUP_MIN_LISTEN_MS),
    maxMs: Math.max(autoStop.maxMs ?? 0, REPLY_FOLLOWUP_MAX_MS),
  };
}

export function cancelLiveFollowUp(): void {
  followUpGeneration += 1;
  toolFollowUpGate.clear();
  followUpAuthority.clear();
}

export function liveFollowUpGeneration(): number {
  return followUpGeneration;
}

/** A tool can narrate after its result; do not open a reply mic into that audio. */
export function shouldArmLiveFollowUp(armFollowUp: boolean | undefined = true): boolean {
  return armFollowUp;
}

/**
 * A native tool may claim the turn after a provider reply has scheduled its
 * continuity mic. Keep both the generation fence and the turn-owner fence at
 * every async boundary so that late tool narration cannot become a reply.
 */
export function shouldContinueLiveFollowUp(
  armedAt: number,
  canReopen: (() => boolean) | undefined,
): boolean {
  return followUpGeneration === armedAt && (canReopen?.() ?? true);
}

export type BeginListeningFn = (
  capture: VoiceCapture,
  autoStop: import('./voice-capture').AutoStopOptions | undefined,
  reason: 'reply',
  preRollSeed: undefined,
  busy: React.MutableRefObject<boolean>,
) => Promise<void>;

/**
 * After Live speaks, wait for the audio queue to drain, clear busy, and reopen
 * listening with reason `reply` while the Live session stays engaged.
 */
export async function reopenLiveFollowUpListening(opts: LiveFollowUpOptions): Promise<void> {
  const { capture, busy, beginListening, wakeAutoStop, canReopen } = opts;
  const armedAt = followUpGeneration;

  // Chunks often arrive a beat AFTER liveProviderAnswer. Wait briefly for the
  // playback queue to fill before treating remainingMs===0 as "done speaking".
  const audioStartDeadline = Date.now() + 3_000;
  while (Date.now() < audioStartDeadline) {
    if (!shouldContinueLiveFollowUp(armedAt, canReopen)) return;
    if ((livePlayer?.remainingMs() ?? 0) > 80) break;
    await delay(50);
  }

  const started = Date.now();
  const maxWaitMs = 45_000;
  while (Date.now() - started < maxWaitMs) {
    if (!shouldContinueLiveFollowUp(armedAt, canReopen)) return;
    const remaining = livePlayer?.remainingMs() ?? 0;
    if (remaining <= 80) break;
    await delay(Math.min(250, remaining));
  }
  await delay(450);

  if (!shouldContinueLiveFollowUp(armedAt, canReopen)) return;
  if (busy.current || wakeOpenInProgress) return;
  if (!isJarvisLiveEnabled()) return;
  const info = useVoiceStore.getState().info;
  if (!canAttemptRealtime(info)) return;
  const liveState = useVoiceStore.getState().liveState;
  if (liveState?.status === 'error') return;

  logVoiceEvent('info', 'jarvis.liveFollowUpArm', 'reabrindo escuta Live (continuidade)', {
    remainingMs: livePlayer?.remainingMs() ?? 0,
  });
  const authorityDeadline = followUpAuthority.arm();
  logVoiceEvent('info', 'jarvis.followUpAuthorityArmed', 'janela sem wake autorizada', {
    durationMs: Math.round(followUpAuthority.remainingMs()),
    deadlineMonotonicMs: Math.round(authorityDeadline),
  });
  wakeMic.suppressWakeDetection(600);
  // Reuse wake-like silence thresholds for follow-up (user answers her question).
  await beginListening(
    capture,
    buildReplyAutoStop(wakeAutoStop(capture, busy, 'wake')),
    'reply',
    undefined,
    busy,
  );
}

/**
 * Release busy + set idle after Live owns the spoken reply, then arm follow-up.
 * Does NOT call liveEndTurn / liveInterrupt — session stays hot.
 */
export function releaseAfterLiveProviderAnswer(opts: LiveFollowUpOptions & {
  /** False when a tool owns the turn and its narration may still arrive late. */
  armFollowUp?: boolean;
  followUpSkipReason?: 'realtime-tool' | 'turn-owned-before-audio';
}): void {
  const store = useVoiceStore.getState();
  // Keep speaking status while chunks drain; follow-up arm waits on remainingMs.
  if (store.status !== 'speaking') store.setStatus('idle');
  opts.busy.current = false;
  if (!shouldArmLiveFollowUp(opts.armFollowUp)) {
    logVoiceEvent('info', 'jarvis.liveFollowUpSkipped', 'continuidade não armada neste turno', {
      reason: opts.followUpSkipReason ?? 'turn-owned-before-audio',
    });
    return;
  }
  // Provider completion and playback drain do not share a clock. Users start
  // speaking when the answer sounds finished, while the reopen routine may
  // still be waiting for a late chunk. Authorize that narrow bridge now; the
  // reopen path renews the full window when reply capture actually starts.
  const bridgeDeadline = followUpAuthority.arm();
  logVoiceEvent(
    'info',
    'jarvis.followUpAuthorityBridgeArmed',
    'continuidade autorizada durante drenagem do áudio',
    {
      durationMs: Math.round(followUpAuthority.remainingMs()),
      deadlineMonotonicMs: Math.round(bridgeDeadline),
    },
  );
  void reopenLiveFollowUpListening(opts);
}

/**
 * A native tool can narrate long after its local action completes. Wait for the
 * provider's correlated turn-complete event, then reuse the normal drain guard
 * before opening the reply mic.
 */
export function releaseAfterLiveToolAnswer(opts: ToolFollowUpRequest): void {
  const store = useVoiceStore.getState();
  if (store.status !== 'speaking') store.setStatus('idle');
  opts.busy.current = false;
  const ready = toolFollowUpGate.arm(
    { sessionId: opts.sessionId, turnId: opts.turnId, callId: opts.callId },
    opts,
  );
  if (ready) {
    startToolFollowUp(ready, 'cached-complete');
    return;
  }
  logVoiceEvent('info', 'jarvis.liveToolFollowUpPending', 'aguardando fim da narração da ferramenta', {
    turnId: opts.turnId,
  });
}

/** Called only for a provider completion that follows a realtime tool result. */
export function notifyLiveToolTurnComplete(event: JarvisLiveToolTurnCompleteEvent): void {
  const ready = toolFollowUpGate.complete({
    sessionId: event.sessionId,
    turnId: event.turnId,
    callId: event.callId,
  });
  if (!ready) return;
  startToolFollowUp(ready, event.callId);
}

function startToolFollowUp(request: ToolFollowUpRequest, source: string): void {
  logVoiceEvent('info', 'jarvis.liveToolFollowUpReady', 'narração concluída — reabrindo continuidade', {
    turnId: request.turnId,
    source,
  });
  // Tool narration has the same provider/playback clock gap as a normal
  // answer. Authorize speech immediately when the correlated tool turn is
  // complete; the drain routine renews the window when capture opens.
  const bridgeDeadline = followUpAuthority.arm();
  logVoiceEvent(
    'info',
    'jarvis.toolFollowUpAuthorityBridgeArmed',
    'continuidade de ferramenta autorizada durante drenagem do áudio',
    {
      durationMs: Math.round(followUpAuthority.remainingMs()),
      deadlineMonotonicMs: Math.round(bridgeDeadline),
      turnId: request.turnId,
    },
  );
  void reopenLiveFollowUpListening(request);
}
