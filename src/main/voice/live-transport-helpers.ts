/**
 * Pure helpers for LiveTransportController (keeps the controller under 800 lines).
 */

const LOCAL_TOOL_CALL_PREFIX = 'local:';
export const MAX_LIVE_HISTORY_ENTRY_CHARS = 2_000;
export const MAX_RESUME_CONTEXT_CHARS = 12_000;

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

export function trimLiveHistory(
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
  maxTurns: number,
): Array<{ role: 'user' | 'assistant'; text: string }> {
  if (maxTurns <= 0) return [];
  const turns: Array<Array<{ role: 'user' | 'assistant'; text: string }>> = [];
  for (const entry of history) {
    const bounded = {
      role: entry.role,
      text: entry.text.trim().slice(0, MAX_LIVE_HISTORY_ENTRY_CHARS),
    };
    if (!bounded.text) continue;
    if (bounded.role === 'user') {
      turns.push([bounded]);
      continue;
    }
    // A resume prompt must never begin with an orphan assistant message.
    if (turns.length > 0) turns[turns.length - 1].push(bounded);
  }
  return turns.slice(-maxTurns).flat();
}

export function buildResumeContext(
  history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
): string | null {
  if (history.length === 0) return null;
  const header = '[reconexão] Histórico recente:\n';
  const lines: string[] = [];
  let remaining = MAX_RESUME_CONTEXT_CHARS - header.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const line = `${entry.role === 'user' ? 'Usuário' : 'Jarvis'}: ${entry.text
      .trim()
      .slice(0, MAX_LIVE_HISTORY_ENTRY_CHARS)}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (cost > remaining) break;
    lines.unshift(line);
    remaining -= cost;
  }
  if (lines.length === 0) return null;
  // If truncation lands on an assistant, drop it instead of inventing an
  // assistant-first conversation boundary.
  while (lines[0]?.startsWith('Jarvis: ')) lines.shift();
  return lines.length > 0 ? `${header}${lines.join('\n')}` : null;
}
