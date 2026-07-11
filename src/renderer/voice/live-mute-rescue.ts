export const MAX_CONSECUTIVE_RESCUES = 2;
/**
 * A single frame is normally only the capture hand-off/pre-roll. It is not
 * enough speech for Gemini Live to reliably infer the user's command.
 */
export const MIN_USABLE_LIVE_MIC_FRAMES = 2;
export const INSUFFICIENT_LIVE_MIC_FRAMES_TRANSCRIPT_WAIT_MS = 800;
export const LIVE_RESCUE_RESPONSE_TIMEOUT_MS = 6_000;
const LIVE_RESCUE_POLL_MS = 50;

let consecutiveRescues = 0;
let offeredFramesThisTurn = 0;

export function hasInsufficientLiveMicFrames(offeredFrames: number): boolean {
  return offeredFrames < MIN_USABLE_LIVE_MIC_FRAMES;
}

export function shouldAttemptLiveMuteRescue(opts: {
  realtimeIsOwner: boolean;
  localSpeechUsable: boolean;
  explicitCapture: boolean;
  offeredFrames: number;
  /** When 'reply', rescue even if frames reached Live (provider often misses finals). */
  captureReason?: string;
  consecutive?: number;
}): boolean {
  const used = opts.consecutive ?? consecutiveRescues;
  if (!opts.realtimeIsOwner || !opts.localSpeechUsable || used >= MAX_CONSECUTIVE_RESCUES) {
    return false;
  }
  // Explicit wake/click/PTT with almost no mic frames → STT text into Live.
  if (opts.explicitCapture && hasInsufficientLiveMicFrames(opts.offeredFrames)) {
    return true;
  }
  // Follow-up continuity: frames may have gone up but Gemini never returned a
  // final user transcript (log: 9s mute while passive STT heard "nova missão").
  // Local STT + liveRescueIn is Overclock-aligned rescue, not Classic dual-voice.
  if (opts.captureReason === 'reply') {
    return true;
  }
  return false;
}

export type LiveRescueEvidence = 'audio' | 'tool' | 'superseded' | 'timeout';

export interface LiveRescueSnapshot {
  turnToken: number;
  playedAudioChunks: number;
  heldAudioChunks: number;
  toolInFlight: number;
  lastToolAt: number;
}

export async function waitForLiveRescueEvidence(opts: {
  turnToken: number;
  startedAt: number;
  playedBaseline: number;
  heldBaseline: number;
  read: () => LiveRescueSnapshot;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<LiveRescueEvidence> {
  const now = opts.now ?? Date.now;
  const delay = opts.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (opts.timeoutMs ?? LIVE_RESCUE_RESPONSE_TIMEOUT_MS);
  while (now() < deadline) {
    const snapshot = opts.read();
    if (snapshot.turnToken !== opts.turnToken) return 'superseded';
    if (snapshot.toolInFlight > 0 || snapshot.lastToolAt >= opts.startedAt) return 'tool';
    if (
      snapshot.playedAudioChunks > opts.playedBaseline ||
      snapshot.heldAudioChunks > opts.heldBaseline
    ) {
      return 'audio';
    }
    await delay(LIVE_RESCUE_POLL_MS);
  }
  return 'timeout';
}

export function markLiveMuteRescueAttempt(): number {
  consecutiveRescues += 1;
  return consecutiveRescues;
}

export function resetLiveMuteRescues(): void {
  consecutiveRescues = 0;
}

export function liveMuteRescueCount(): number {
  return consecutiveRescues;
}

export function resetOfferedLiveMicFramesThisTurn(): void {
  offeredFramesThisTurn = 0;
}

export function markLiveMicFrameOffered(): void {
  offeredFramesThisTurn += 1;
}

export function offeredLiveMicFramesThisTurn(): number {
  return offeredFramesThisTurn;
}
