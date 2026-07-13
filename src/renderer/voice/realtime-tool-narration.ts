interface PendingToolNarration {
  text: string;
  audioPlayedBaseline: number;
}

const MAX_PENDING_NARRATIONS = 32;
const pendingNarrations = new Map<string, PendingToolNarration>();

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

export function takeSilentRealtimeToolNarration(
  callId: string,
  audioPlayedNow: number,
): string | null {
  const pending = pendingNarrations.get(callId);
  pendingNarrations.delete(callId);
  if (!pending || audioPlayedNow > pending.audioPlayedBaseline) return null;
  return pending.text;
}

export function clearRealtimeToolNarrations(): void {
  pendingNarrations.clear();
}
