import { createHash } from 'node:crypto';

export type SystemInputWriter = 'maestro' | 'supervisor' | 'failover' | 'nexus';
export type InputAttribution = { inputOrigin: 'human' | 'system' | 'unknown'; writer?: SystemInputWriter };
const MAX_TEXT = 32_768;
const MAX_SESSIONS = 4096;
const RECEIPT_TTL = 60_000;
const INPUT_TTL = 5 * 60_000;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
interface InputState {
  text: string;
  escape: string;
  paste: boolean;
  invalid: boolean;
  at: number;
  origin: 'human' | 'system';
  writer?: SystemInputWriter;
  receipt?: { hash: string; at: number };
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Observational RAM only. Unknown editing fails closed; no prompt/hash leaves this module. */
export class OperatorInputReceipts {
  private readonly sessions = new Map<string, InputState>();

  record(sessionId: string, data: string, origin: 'human' | 'system', writer?: SystemInputWriter, now = Date.now()): void {
    if (!data) return;
    let state = this.sessions.get(sessionId);
    if (!state) {
      if (this.sessions.size >= MAX_SESSIONS) return;
      state = { text: '', escape: '', paste: false, invalid: false, at: now, origin };
      this.sessions.set(sessionId, state);
    }
    if (origin === 'system' || now - state.at > INPUT_TTL || now < state.at) {
      state.text = ''; state.escape = ''; state.paste = false; state.invalid = false;
    }
    state.at = now;
    state.origin = origin;
    state.writer = origin === 'system' ? writer ?? 'nexus' : undefined;
    state.receipt = undefined;
    if (origin === 'system') return;
    // Never scan or retain an arbitrarily large paste on the main thread.
    if (data.length > MAX_TEXT) {
      state.text = ''; state.escape = ''; state.paste = false;
      state.invalid = !/[\r\n]$/.test(data);
      return;
    }
    for (const ch of data) {
      if (state.escape || ch === '\x1b') {
        state.escape += ch;
        if (state.escape === PASTE_START && !state.paste) {
          state.paste = true; state.escape = ''; continue;
        }
        if (state.escape === PASTE_END && state.paste) {
          state.paste = false; state.escape = ''; continue;
        }
        if (PASTE_START.startsWith(state.escape) || PASTE_END.startsWith(state.escape)) continue;
        state.invalid = true; state.escape = ''; continue;
      }
      if (ch === '\x03' && !state.paste) {
        state.text = ''; state.invalid = false; continue;
      }
      if ((ch === '\r' || ch === '\n') && !state.paste) {
        if (!state.invalid && state.text.length) state.receipt = { hash: hash(state.text), at: now };
        state.text = ''; state.invalid = false; continue;
      }
      if ((ch === '\b' || ch === '\x7f') && !state.paste) {
        // Erase a Unicode code point rather than half a surrogate pair.
        const last = state.text.charCodeAt(state.text.length - 1);
        state.text = state.text.slice(0, last >= 0xdc00 && last <= 0xdfff ? -2 : -1);
        continue;
      }
      if (ch < ' ' && ch !== '\n' && ch !== '\t') { state.invalid = true; continue; }
      // A subsequent edit in this chunk supersedes an earlier submission.
      state.receipt = undefined;
      if (state.text.length + ch.length > MAX_TEXT) { state.invalid = true; state.text = ''; }
      if (!state.invalid) state.text += ch;
    }
  }

  matches(sessionId: string, prompt: string, now = Date.now()): boolean {
    const state = this.sessions.get(sessionId);
    const receipt = state?.receipt;
    return !!receipt && state?.origin === 'human' && prompt.length <= MAX_TEXT &&
      now >= receipt.at && now - receipt.at <= RECEIPT_TTL && receipt.hash === hash(prompt);
  }

  attribution(sessionId: string, now = Date.now()): InputAttribution {
    const state = this.sessions.get(sessionId);
    if (!state || now < state.at || now - state.at > INPUT_TTL) return { inputOrigin: 'unknown' };
    return state.origin === 'human' ? { inputOrigin: 'human' } : { inputOrigin: 'system', writer: state.writer };
  }

  forget(sessionId: string): void { this.sessions.delete(sessionId); }
}

const receipts = new OperatorInputReceipts();
export const recordSessionInputReceipt = receipts.record.bind(receipts);
export const forgetSessionInputReceipt = receipts.forget.bind(receipts);
export const isRecentHumanPrompt = receipts.matches.bind(receipts);
export const recentSessionInputAttribution = receipts.attribution.bind(receipts);
