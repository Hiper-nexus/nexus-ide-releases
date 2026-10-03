import { detectLimit, type LimitHit } from './limit-detector';
const WINDOW = 4_000;
const NOISE = /retrying\s+in\s+\d|attempt\s+\d+\s*\/\s*\d+|api\s*error|overloaded_error|service unavailable|status[\s:(]*5\d\d\b|\bhttp\s*5\d\d\b/i;
export interface FailoverTextProposal {
  readonly hit?: LimitHit;
  readonly scanned?: boolean;
  readonly slowScanMs?: number;
  readonly unavailable?: boolean;
  readonly episode: number;
  readonly progressChars: number;
  readonly freshError: boolean;
  readonly at: number;
}
function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length >= 20);
}
function signature(line: string): string | null { const match = NOISE.exec(line); return match ? line.slice(match.index) : null; }
/** All scan-before-progress state lives together; Main only accepts proposals. */
export class FailoverTextReducer {
  #buffer = ''; #pending = 0; #lastScan = 0; #firedAt = -Infinity;
  slowUntil = 0; #held: Array<{ text: string; at: number }> = []; #heldChars = 0; #unavailable = false;
  #episode = 0; #transient = false; #progress = 0;
  #seen = new Set<string>(); #errors = new Set<string>();
  #remember(line: string) { if (this.#seen.size >= 2_000) this.#seen.clear(); this.#seen.add(line); }
  control(value: { firedAt?: number; endTransient?: boolean; rejectTransient?: boolean }) {
    if (value.firedAt !== undefined) { this.#firedAt = value.firedAt; this.#buffer = ''; }
    if (value.endTransient || value.rejectTransient || value.firedAt !== undefined) { this.#transient = false; this.#progress = 0; this.#seen.clear(); this.#errors.clear(); }
  }
  observer(hit: LimitHit, at: number): FailoverTextProposal[] { return this.#hit(hit, hit.reason, '', at); }
  feed(text: string, at: number, flush = false): FailoverTextProposal[] {
    const out: FailoverTextProposal[] = [];
    if (this.#unavailable) return [{ episode: this.#episode, progressChars: this.#progress, freshError: false, unavailable: true, at }];
    if (at < this.slowUntil) {
      if (text) { this.#held.push({ text, at }); this.#heldChars += text.length; }
      if (this.#heldChars > 262_144) { this.#held = []; this.#heldChars = 0; this.#unavailable = true; return [{ episode: this.#episode, progressChars: this.#progress, freshError: false, unavailable: true, at }]; }
      return out;
    }
    if (this.#held.length) {
      const held = this.#held; this.#held = []; this.#heldChars = 0;
      for (const part of held) out.push(...this.feed(part.text, at, true));
    }
    // Overlapping half-window strides inspect admitted text, including quota
    // evidence in the middle of a flood. No tail-only replacement.
    if (text.length === 0) { if (flush && this.#pending) out.push(...this.#scan('', at)); return out; }
    for (let offset = 0; offset < text.length; offset += WINDOW / 2) {
      const part = text.slice(offset, offset + WINDOW / 2);
      if (at < this.slowUntil) { out.push(...this.feed(text.slice(offset), at, flush)); break; }
      if (at - this.#firedAt < 30_000) { this.#noteProgress(part); continue; }
      this.#buffer = (this.#buffer + part).slice(-WINDOW); this.#pending += part.length;
      if (this.#transient || at - this.#lastScan >= 250 || this.#pending >= WINDOW / 2 || flush) out.push(...this.#scan(part, at));
    }
    if (this.#transient) out.push({ episode: this.#episode, progressChars: this.#progress, freshError: false, at });
    return out;
  }
  #scan(text: string, at: number): FailoverTextProposal[] {
    this.#lastScan = at; this.#pending = 0;
    const started = Date.now();
    const hit = detectLimit(this.#buffer);
    const scanMs = Math.max(0, Date.now() - started);
    if (scanMs > 25) this.slowUntil = at + 5_000;
    if (hit) { const window = this.#buffer; this.#buffer = ''; return this.#hit(hit, window, text, at).map((proposal) => ({ ...proposal, ...(scanMs > 25 ? { slowScanMs: scanMs } : {}) })); }
    this.#noteProgress(text); return [{ episode: this.#episode, progressChars: this.#progress, freshError: false, scanned: true, ...(scanMs > 25 ? { slowScanMs: scanMs } : {}), at }];
  }
  #hit(hit: LimitHit, detected: string, text: string, at: number): FailoverTextProposal[] {
    if (at - this.#firedAt < 30_000) return [];
    let freshError = false;
    if (hit.kind === 'transient') {
      const detectedLines = lines(detected);
      if (this.#transient) for (const line of detectedLines) {
        const sig = signature(line);
        if (sig !== null && !this.#errors.has(sig)) { this.#errors.add(sig); freshError = true; }
        this.#remember(line);
      }
      else {
        this.#transient = true; this.#episode++; this.#progress = 0;
        this.#seen = new Set(detectedLines);
        this.#errors = new Set(detectedLines.map(signature).filter((v): v is string => v !== null));
      }
      if (freshError) this.#progress = 0;
      this.#noteProgress(text);
    } else { this.control({ firedAt: at }); }
    return [{ hit, scanned: true, episode: this.#episode, progressChars: this.#progress, freshError, at }];
  }
  #noteProgress(text: string) {
    if (!this.#transient) return;
    for (const line of lines(text)) {
      if (this.#seen.has(line)) continue;
      this.#remember(line); const sig = signature(line);
      if (sig !== null) this.#errors.add(sig); else this.#progress += line.length;
    }
  }
}
