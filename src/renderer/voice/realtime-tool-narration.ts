interface PendingToolNarration {
  text: string;
  audioPlayedBaseline: number;
}

const MAX_PENDING_NARRATIONS = 32;
const pendingNarrations = new Map<string, PendingToolNarration>();

/** How long to wait for the first Live PCM chunk before falling back to local TTS. */
export const TOOL_NARRATION_AUDIO_GRACE_MS = 900;
const TOOL_NARRATION_POLL_MS = 50;

export function armRealtimeToolNarration(
  callId: string,
  text: string,
  audioPlayedBaseline: number,
): void {
  const trimmed = text.trim();
  if (!callId || !trimmed) return;
  pendingNarrations.set(callId, { text: trimmed, audioPlayedBaseline });
  while (pendingNarrations.size > MAX_PENDING_NARRATIONS) {
    const oldest = pendingNarrations.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingNarrations.delete(oldest);
  }
}

export function peekRealtimeToolNarration(callId: string): PendingToolNarration | null {
  return pendingNarrations.get(callId) ?? null;
}

export function takeSilentRealtimeToolNarration(
  callId: string,
  audioPlayedNow: number,
): string | null {
  const pending = pendingNarrations.get(callId);
  pendingNarrations.delete(callId);
  if (!pending || audioPlayedNow > pending.audioPlayedBaseline) return null;
  return pending.text;
}

/** Drop a pending local narration claim without inventing audio evidence. */
export function discardRealtimeToolNarration(callId: string): void {
  pendingNarrations.delete(callId);
}

export function clearRealtimeToolNarrations(): void {
  pendingNarrations.clear();
}

/**
 * Wait briefly for provider audio evidence before choosing local TTS.
 * Returns whether Live already started speaking after the baseline.
 */
export async function waitForToolNarrationAudio(
  audioPlayedBaseline: number,
  readAudioPlayed: () => number,
  opts: {
    graceMs?: number;
    pollMs?: number;
    delay: (ms: number) => Promise<void>;
    shouldAbort?: () => boolean;
  },
): Promise<'provider' | 'silent' | 'aborted'> {
  const graceMs = opts.graceMs ?? TOOL_NARRATION_AUDIO_GRACE_MS;
  const pollMs = opts.pollMs ?? TOOL_NARRATION_POLL_MS;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (opts.shouldAbort?.()) return 'aborted';
    if (readAudioPlayed() > audioPlayedBaseline) return 'provider';
    await opts.delay(pollMs);
  }
  if (opts.shouldAbort?.()) return 'aborted';
  return readAudioPlayed() > audioPlayedBaseline ? 'provider' : 'silent';
}
