// Incremental OSC extractor for the detection engine. Watches the raw PTY
// byte stream (before ANSI stripping — the stripper deletes these sequences)
// and keeps the latest value per session for:
//  - OSC 0 / OSC 2  → window title (`osc_title` region)
//  - OSC 9          → progress payload (the part after `9;`, e.g. "4;0;"),
//                     matching Herdr's AgentOscStateTracker semantics.
//
// Payloads are sanitized (control chars dropped, 256-char cap) exactly like
// upstream. Sequences may span chunk boundaries, so each session keeps a
// small pending tail. Terminators: BEL or ST (ESC \), per ECMA-48.

const MAX_OSC_PAYLOAD = 4096;
const AGENT_OSC_MAX_CHARS = 256;
/** Cap on the held tail when a sequence never terminates (broken writer). */
const MAX_PENDING_TAIL = MAX_OSC_PAYLOAD + 16;

interface OscSessionState {
  title: string;
  progress: string;
  /** Unterminated tail of the previous chunk (may complete an OSC later). */
  pending: string;
}

export class OscTracker {
  private readonly sessions = new Map<string, OscSessionState>();

  /** Feed one raw PTY data chunk; returns nothing, state is per session. */
  feed(sessionId: string, data: string): void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { title: '', progress: '', pending: '' };
      this.sessions.set(sessionId, state);
    }
    // Fast path: most chunks carry no OSC at all.
    let text = state.pending + data;
    state.pending = '';
    if (!text.includes('\x1b]')) {
      state.pending = extractTail(text);
      return;
    }

    for (;;) {
      const start = text.indexOf('\x1b]');
      if (start < 0) {
        state.pending = extractTail(text);
        return;
      }
      // A fresh sequence start before any terminator means the previous one
      // was abandoned by the writer — drop it and resync.
      const resync = text.indexOf('\x1b]', start + 2);
      const belEnd = text.indexOf('\x07', start + 2);
      const stEnd = text.indexOf('\x1b\\', start + 2);
      let end = -1;
      let endLen = 1;
      if (belEnd >= 0 && (stEnd < 0 || belEnd < stEnd)) {
        end = belEnd;
      } else if (stEnd >= 0) {
        end = stEnd;
        endLen = 2;
      }
      if (resync >= 0 && (end < 0 || resync < end)) {
        text = text.slice(resync);
        continue;
      }
      if (end < 0) {
        // Unterminated: hold from the sequence start (bounded).
        state.pending = text.slice(start).slice(0, MAX_PENDING_TAIL);
        return;
      }
      const payload = text.slice(start + 2, end).slice(0, MAX_OSC_PAYLOAD);
      this.applyPayload(state, payload);
      text = text.slice(end + endLen);
    }
  }

  title(sessionId: string): string {
    return this.sessions.get(sessionId)?.title ?? '';
  }

  progress(sessionId: string): string {
    return this.sessions.get(sessionId)?.progress ?? '';
  }

  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private applyPayload(state: OscSessionState, payload: string): void {
    const semicolon = payload.indexOf(';');
    if (semicolon < 0) return;
    const code = payload.slice(0, semicolon);
    const rest = sanitizeAgentOsc(payload.slice(semicolon + 1));
    if (code === '0' || code === '2') {
      state.title = rest;
    } else if (code === '9') {
      state.progress = rest;
    }
  }
}

/** Drop control characters and cap length, mirroring upstream sanitize. */
function sanitizeAgentOsc(payload: string): string {
  let out = '';
  for (const ch of payload) {
    if (out.length >= AGENT_OSC_MAX_CHARS) break;
    // eslint-disable-next-line no-control-regex
    if (!/[\x00-\x1f\x7f-\x9f]/.test(ch)) out += ch;
  }
  return out;
}

/**
 * Keep only a tail fragment that could still grow into a sequence start
 * (a trailing ESC or ESC ]), so plain text is never retained.
 */
function extractTail(text: string): string {
  if (text.endsWith('\x1b]')) return '\x1b]';
  if (text.endsWith('\x1b')) return '\x1b';
  return '';
}
