/**
 * Keep Live hot after the provider answers — reopen mic for the follow-up
 * without requiring another "Hey Jarvis" (Overclock continuity).
 */
import type React from 'react';
import type { VoiceCapture } from './voice-capture';
import { delay } from './jarvis-reply-loop';
import { logVoiceEvent } from './voice-live-ipc';
import { canAttemptRealtime, isJarvisLiveEnabled } from './voice-realtime-gates';
import {
  livePlayer,
  wakeMic,
  wakeOpenInProgress,
} from './voice-session-state';
import { useVoiceStore } from './voice-store';

/** Bumped on every wake sync reset — stale follow-up arms bail out. */
let followUpGeneration = 0;

export function cancelLiveFollowUp(): void {
  followUpGeneration += 1;
}

export function liveFollowUpGeneration(): number {
  return followUpGeneration;
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
export async function reopenLiveFollowUpListening(opts: {
  capture: VoiceCapture;
  busy: React.MutableRefObject<boolean>;
  beginListening: BeginListeningFn;
  wakeAutoStop: (
    capture: VoiceCapture,
    busy: React.MutableRefObject<boolean>,
    reason: 'wake' | 'click',
  ) => import('./voice-capture').AutoStopOptions;
}): Promise<void> {
  const { capture, busy, beginListening, wakeAutoStop } = opts;
  const armedAt = followUpGeneration;

  // Chunks often arrive a beat AFTER liveProviderAnswer. Wait briefly for the
  // playback queue to fill before treating remainingMs===0 as "done speaking".
  const audioStartDeadline = Date.now() + 3_000;
  while (Date.now() < audioStartDeadline) {
    if (followUpGeneration !== armedAt) return;
    if ((livePlayer?.remainingMs() ?? 0) > 80) break;
    await delay(50);
  }

  const started = Date.now();
  const maxWaitMs = 45_000;
  while (Date.now() - started < maxWaitMs) {
    if (followUpGeneration !== armedAt) return;
    const remaining = livePlayer?.remainingMs() ?? 0;
    if (remaining <= 80) break;
    await delay(Math.min(250, remaining));
  }
  await delay(450);

  if (followUpGeneration !== armedAt) return;
  if (busy.current || wakeOpenInProgress) return;
  if (!isJarvisLiveEnabled()) return;
  const info = useVoiceStore.getState().info;
  if (!canAttemptRealtime(info)) return;
  const liveState = useVoiceStore.getState().liveState;
  if (liveState?.status === 'error') return;

  logVoiceEvent('info', 'jarvis.liveFollowUpArm', 'reabrindo escuta Live (continuidade)', {
    remainingMs: livePlayer?.remainingMs() ?? 0,
  });
  wakeMic.suppressWakeDetection(600);
  // Reuse wake-like silence thresholds for follow-up (user answers her question).
  await beginListening(
    capture,
    wakeAutoStop(capture, busy, 'wake'),
    'reply',
    undefined,
    busy,
  );
}

/**
 * Release busy + set idle after Live owns the spoken reply, then arm follow-up.
 * Does NOT call liveEndTurn / liveInterrupt — session stays hot.
 */
export function releaseAfterLiveProviderAnswer(opts: {
  busy: React.MutableRefObject<boolean>;
  capture: VoiceCapture;
  beginListening: BeginListeningFn;
  wakeAutoStop: (
    capture: VoiceCapture,
    busy: React.MutableRefObject<boolean>,
    reason: 'wake' | 'click',
  ) => import('./voice-capture').AutoStopOptions;
}): void {
  const store = useVoiceStore.getState();
  // Keep speaking status while chunks drain; follow-up arm waits on remainingMs.
  if (store.status !== 'speaking') store.setStatus('idle');
  opts.busy.current = false;
  void reopenLiveFollowUpListening(opts);
}
