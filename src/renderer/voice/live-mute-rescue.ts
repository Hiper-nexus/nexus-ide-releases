export const MAX_CONSECUTIVE_RESCUES = 2;
export const ZERO_FRAMES_TRANSCRIPT_WAIT_MS = 800;
export const LIVE_RESCUE_RESPONSE_TIMEOUT_MS = 6_000;
const LIVE_RESCUE_POLL_MS = 50;

let consecutiveRescues = 0;
let offeredFramesThisTurn = 0;

export function shouldAttemptLiveMuteRescue(opts: {
  realtimeIsOwner: boolean;
  localSpeechUsable: boolean;
  explicitCapture: boolean;
  offeredFrames: number;
  consecutive?: number;
}): boolean {
  const used = opts.consecutive ?? consecutiveRescues;
  return (
    opts.realtimeIsOwner &&
    opts.localSpeechUsable &&
    opts.explicitCapture &&
    opts.offeredFrames === 0 &&
    used < MAX_CONSECUTIVE_RESCUES
  );
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
