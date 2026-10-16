export const MAX_CONSECUTIVE_RESCUES = 2;
/**
 * A single frame is normally only the capture hand-off/pre-roll. It is not
 * enough speech for Gemini Live to reliably infer the user's command.
 */
export const MIN_USABLE_LIVE_MIC_FRAMES = 2;
export const INSUFFICIENT_LIVE_MIC_FRAMES_TRANSCRIPT_WAIT_MS = 800;
/**
 * Evidence window after a final transcript/rescue. Runtime logs (19–20 Jul)
 * showed every healthy provider response producing audio/tool evidence before
 * this boundary, while all three silent turns consumed the former 6s ceiling
 * in full before Classic even started. Keep a network-jitter margin without
 * adding 2.5s of guaranteed silence to the fallback path.
 */
export const LIVE_RESCUE_RESPONSE_TIMEOUT_MS = 3_500;
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
  /** Capture reason is retained for diagnostics and explicit-policy tests. */
  captureReason?: string;
  /** A local monotonic follow-up window is still valid at endpoint time. */
  followUpAuthorized?: boolean;
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
  // Reply audio is never streamed directly. It may be converted to text only
  // when endpointing completed inside the explicit local authority window.
  if (opts.captureReason === 'reply') return opts.followUpAuthorized === true;
  return false;
}

export type LiveRescueEvidence = 'audio' | 'tool' | 'superseded' | 'timeout';

export interface LiveRescueSnapshot {
  turnToken: number;
  playedAudioChunks: number;
  heldAudioChunks: number;
  toolInFlight: number;
  lastToolAt: number;
  /**
   * A tool realtime JÁ É a dona deste turno (turnExecution 'realtime-tool').
   * Cobre a tool que começou e terminou antes da leitura: `lastToolAt` e
   * `toolInFlight` sozinhos não a veem. Opcional — quem não informa mantém a
   * regra antiga.
   */
  toolOwnsTurn?: boolean;
}

export interface LiveRescueBaselines {
  turnToken: number;
  /** Instante de referência para provas de tool (`lastToolAt >= startedAt`). */
  startedAt: number;
  playedBaseline: number;
  heldBaseline: number;
}

/**
 * Uma leitura do estado do provider vira evidência — ou `null` (ainda sem
 * prova). Regra ÚNICA: o wait de evidência (`waitForLiveRescueEvidence`) e o
 * wait do transcript (`waitForTranscriptOrProviderAnswer`) leem pelo mesmo
 * critério, senão um dos dois declararia "mudo" um turno que o outro viu
 * respondendo.
 */
export function classifyLiveRescueSnapshot(
  snapshot: LiveRescueSnapshot,
  opts: LiveRescueBaselines,
): Exclude<LiveRescueEvidence, 'timeout'> | null {
  if (snapshot.turnToken !== opts.turnToken) return 'superseded';
  if (
    snapshot.toolOwnsTurn === true ||
    snapshot.toolInFlight > 0 ||
    snapshot.lastToolAt >= opts.startedAt
  ) {
    return 'tool';
  }
  if (
    snapshot.playedAudioChunks > opts.playedBaseline ||
    snapshot.heldAudioChunks > opts.heldBaseline
  ) {
    return 'audio';
  }
  return null;
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
    const evidence = classifyLiveRescueSnapshot(opts.read(), opts);
    if (evidence) return evidence;
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
