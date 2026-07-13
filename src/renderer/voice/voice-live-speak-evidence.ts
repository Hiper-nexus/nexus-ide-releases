export type LiveSpeakEvidence = 'audio' | 'tool' | 'none';

export interface LiveSpeakEvidenceSnapshot {
  audioPlayed: number;
  nativeToolInFlight: number;
  lastNativeToolAt: number;
}

interface WaitForLiveSpeakEvidenceOptions {
  baseline: LiveSpeakEvidenceSnapshot;
  read: () => LiveSpeakEvidenceSnapshot;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 1_800;
const DEFAULT_POLL_MS = 25;
export const LIVE_SPEAK_EVIDENCE_MIN_TIMEOUT_MS = 2_400;
export const LIVE_SPEAK_EVIDENCE_MAX_TIMEOUT_MS = 6_500;
const LIVE_SPEAK_EVIDENCE_MS_PER_CHAR = 18;

export function detectLiveSpeakEvidence(
  baseline: LiveSpeakEvidenceSnapshot,
  current: LiveSpeakEvidenceSnapshot,
): LiveSpeakEvidence {
  if (current.audioPlayed > baseline.audioPlayed) return 'audio';
  if (
    current.nativeToolInFlight > baseline.nativeToolInFlight ||
    current.lastNativeToolAt > baseline.lastNativeToolAt
  ) {
    return 'tool';
  }
  return 'none';
}

export function liveSpeakEvidenceTimeoutMs(text: string): number {
  return Math.min(
    LIVE_SPEAK_EVIDENCE_MAX_TIMEOUT_MS,
    Math.max(
      LIVE_SPEAK_EVIDENCE_MIN_TIMEOUT_MS,
      text.trim().length * LIVE_SPEAK_EVIDENCE_MS_PER_CHAR,
    ),
  );
}

export async function waitForLiveSpeakEvidence({
  baseline,
  read,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: WaitForLiveSpeakEvidenceOptions): Promise<LiveSpeakEvidence> {
  const deadline = now() + timeoutMs;
  let evidence = detectLiveSpeakEvidence(baseline, read());
  while (evidence === 'none' && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    evidence = detectLiveSpeakEvidence(baseline, read());
  }
  return evidence;
}

export function liveSpeakEvidenceTimeoutMs(text: string): number {
  const chars = text.trim().length;
  return Math.min(
    LIVE_SPEAK_EVIDENCE_MAX_TIMEOUT_MS,
    Math.max(
      LIVE_SPEAK_EVIDENCE_MIN_TIMEOUT_MS,
      chars * LIVE_SPEAK_EVIDENCE_MS_PER_CHAR,
    ),
  );
}
