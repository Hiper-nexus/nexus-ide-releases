import type { LiveRescueEvidence } from './live-mute-rescue';

export function hasRealtimeProviderAudioAnswer(opts: {
  heldChunks: number;
  playedChunks: number;
}): boolean {
  return opts.heldChunks > 0 || opts.playedChunks > 0;
}

export type LiveAnswerOutcome = 'commit' | 'degrade' | 'abort';

/**
 * After a final user transcript on a hot Live session, the pipeline waits
 * briefly for evidence that the provider is actually answering. Measured runs
 * showed ~89% of final-transcript turns closing with no audio, yet the code
 * committed to the provider and returned into silence. Map that wait's evidence
 * to an action so a mute (`timeout`) degrades to Classic TTS instead:
 * - `audio`/`tool` → commit to the realtime provider (it is answering)
 * - `timeout`      → degrade to the Classic STT→brain→TTS path (provider muted)
 * - `superseded`   → abort; a newer turn already owns the session
 */
export function liveAnswerOutcomeFromEvidence(
  evidence: LiveRescueEvidence,
): LiveAnswerOutcome {
  if (evidence === 'audio' || evidence === 'tool') return 'commit';
  if (evidence === 'superseded') return 'abort';
  return 'degrade';
}

/**
 * An explicit wake/click may legitimately receive provider audio without a
 * final transcript, so it gets one continuity window. An automatic reply
 * window must not renew itself from audio alone: room/TV speech can make the
 * provider answer and otherwise create an endless listen → answer → listen
 * loop. A valid transcript or a correlated tool completion still rearms via
 * their normal paths.
 */
export function shouldRearmAfterAudioOnly(captureReason: string): boolean {
  return captureReason !== 'reply';
}
