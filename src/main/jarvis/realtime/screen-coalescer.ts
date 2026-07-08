/**
 * Screen-update coalescing for the Jarvis Live transport (Overclock C-092.7 b).
 *
 * A wizard / navigation burst emits N near-identical screen turns; each one is a
 * generation that rebills the whole context. Debounce: only the LAST state within
 * the window becomes a turn, and a final state identical to the last one actually
 * sent is dropped entirely. The behavior (the assistant knows the screen) is
 * preserved — the settled state is what matters.
 *
 * Injected timers + a `flush` sink — testable without a socket.
 */
import { normalizeForCompare } from './live-narration';

/** SCREEN_UPDATE_DEBOUNCE_MS (GeminiLiveSession.js:36). */
export const SCREEN_UPDATE_DEBOUNCE_MS = 1_500;

export interface ScreenCoalescerDeps {
  /** Route the settled screen state as a turn. */
  flush(text: string): void;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void;
  /** Override the debounce window (tests). */
  debounceMs?: number;
}

export class ScreenCoalescer {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = '';

  constructor(private readonly deps: ScreenCoalescerDeps) {}

  /** Record a screen state; only the last within the debounce window is flushed. */
  push(text: string): void {
    this.pending = text;
    if (this.timer !== null) this.deps.clearTimeoutFn(this.timer);
    const ms = this.deps.debounceMs ?? SCREEN_UPDATE_DEBOUNCE_MS;
    this.timer = this.deps.setTimeoutFn(() => this.flushPending(), ms);
  }

  /** Force the pending state out now (e.g. on turn boundary). */
  flushNow(): void {
    this.flushPending();
  }

  /** Drop a pending debounce (between connections / on stop) — stale state. */
  clear(): void {
    if (this.timer !== null) {
      this.deps.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  /** Reset the dedup baseline (fresh socket has no "last sent" state). */
  resetBaseline(): void {
    this.lastSent = '';
  }

  private flushPending(): void {
    if (this.timer !== null) {
      this.deps.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    const text = this.pending;
    this.pending = null;
    if (!text) return;
    // dedup: a burst whose final state equals what was already sent = no new turn.
    if (normalizeForCompare(text) === normalizeForCompare(this.lastSent)) return;
    this.lastSent = text;
    this.deps.flush(text);
  }
}
