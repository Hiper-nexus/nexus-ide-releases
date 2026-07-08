/**
 * Pure helpers for LiveTransportController (keeps the controller under 800 lines).
 */

/** Socket with no server progress for this long → force fresh connect on wake. */
export const GRACE_STALE_SERVER_MS = 8_000;
/** Socket that NEVER received server progress (zombie) → stale after this shorter window. */
export const GRACE_STALE_NO_PROGRESS_MS = 3_500;

const LOCAL_TOOL_CALL_PREFIX = 'local:';

export function isLocalToolCallId(callId: string): boolean {
  return callId.startsWith(LOCAL_TOOL_CALL_PREFIX);
}

export function isIgnorableRealtimeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('cancellation failed') ||
    m.includes('no active response') ||
    m.includes('response_cancel_not_active') ||
    m.includes('nothing to cancel')
  );
}

/** P5: heuristic — text that looks like a periodic screen snapshot vs tool result. */
export function isScreenContext(text: string): boolean {
  // Overclock: [wake]/[reconexão] are speakable injectContext turns, not silent updates.
  if (text.startsWith('[wake]') || text.startsWith('[reconexão]')) return false;
  // Tool-result breadcrumbs look like "- tool: ok (...)" / "- tool: failed (...)".
  if (text.startsWith('- ') && (text.includes(': ok') || text.includes(': failed'))) {
    return false;
  }
  return true;
}

export function localToolCallId(kind: string, seq: number): string {
  return `${LOCAL_TOOL_CALL_PREFIX}${kind}:${seq}`;
}

/**
 * True when a Live socket is unsafe to reuse for a [wake] inject.
 * Anchor = last real server progress, else connect time. Never treat a brand-new
 * connect (connectedAt≈now, no progress yet) as stale.
 * When the socket NEVER received any server progress (lastServerMsgAt=0) use a
 * shorter threshold — the socket may have been "ready" (setupComplete) but the
 * Gemini server is ignoring our turns (zombie socket).
 */
export function trimLiveHistory(
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
  maxTurns: number,
): Array<{ role: 'user' | 'assistant'; text: string }> {
  if (history.length <= maxTurns) return history;
  return history.slice(-maxTurns);
}

export function buildResumeContext(
  history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
): string | null {
  if (history.length === 0) return null;
  const lines = history
    .map((h) => `${h.role === 'user' ? 'Usuário' : 'Jarvis'}: ${h.text}`)
    .join('\n');
  return `[reconexão] Histórico recente:\n${lines}`;
}

export function shouldLogWakeSyncReset(opts: {
  forceFresh: boolean;
  inGrace: boolean;
  providerReady: boolean;
  connecting: boolean;
}): boolean {
  return opts.forceFresh && Boolean(opts.providerReady || opts.inGrace || opts.connecting);
}

export function isGraceSocketStale(
  lastServerMsgAt: number,
  now: number,
  thresholdMs: number = GRACE_STALE_SERVER_MS,
  connectedAt: number = 0,
): boolean {
  const anchor = lastServerMsgAt > 0 ? lastServerMsgAt : connectedAt;
  if (anchor <= 0) return true;
  const effectiveThreshold = lastServerMsgAt > 0
    ? thresholdMs
    : Math.min(thresholdMs, GRACE_STALE_NO_PROGRESS_MS);
  return now - anchor > effectiveThreshold;
}
