/**
 * Serialized narration turn queue for the Jarvis Live transport (Overclock
 * F-113). Each injected context/narration/screen-update becomes a spoken turn;
 * without serialization, concurrent narrations (delegated result + pane progress
 * + screen update) hit the socket at once and the voice talks over itself — the
 * single loudest "not fluid" tell.
 *
 * The queue sends ONE turn at a time and releases the next only when the server
 * signals the current turn finished (turnComplete / interrupted). TURN_MAX_MS is
 * a circuit breaker: if a turn never signals completion, the timer releases the
 * queue so it never wedges (it does NOT abort the model).
 *
 * Pure state machine with injected timers — testable without a socket.
 */

/** TURN_MAX_MS (GeminiLiveSession.js:26) — breaker if a turn never signals end. */
export const TURN_MAX_MS = 15_000;

export interface TurnQueueDeps {
  /** Deliver a turn to the transport (send as a clientContent user turn). */
  send(text: string): void;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void;
  /** True while the socket is open and able to accept a turn. */
  canSend(): boolean;
  /** Override the breaker window (tests). */
  turnMaxMs?: number;
}

export class TurnQueue {
  private queue: string[] = [];
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: TurnQueueDeps) {}

  get size(): number {
    return this.queue.length;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Enqueue a turn and try to drain (send now if nothing is in flight). */
  enqueue(text: string): void {
    this.queue.push(text);
    this.drain();
  }

  /**
   * Wake / barge-in: drop queued narrations and force-send now.
   * A stale busy turn (grace reuse with no turnComplete) otherwise blocks
   * `[wake]` until TURN_MAX_MS (~15s) — the ~20s "silent then Olá" symptom.
   */
  enqueuePriority(text: string): void {
    this.queue = [];
    this.clearBreaker();
    this.busy = false;
    this.enqueue(text);
  }

  /** Prepend turns (e.g. re-queuing a dead socket's in-flight turns), FIFO order. */
  prepend(texts: string[]): void {
    this.queue.unshift(...texts);
  }

  /** Send the next turn only when none is in flight; arms the breaker. */
  drain(): void {
    if (this.busy || this.queue.length === 0) return;
    if (!this.deps.canSend()) return;
    const text = this.queue.shift();
    if (text === undefined) return;
    this.busy = true;
    this.deps.send(text);
    this.armBreaker();
  }

  /** Current turn ended (turnComplete / breaker) → release and drain the next. */
  release(): void {
    this.clearBreaker();
    if (!this.busy) return;
    this.busy = false;
    this.drain();
  }

  /** Drain any queued turns and return them (used to move to a pre-connect buffer). */
  flush(): string[] {
    const pending = this.queue;
    this.queue = [];
    return pending;
  }

  /** Reset between connections so a stale turnBusy/timer never leaks to a new socket. */
  reset(): void {
    this.queue = [];
    this.busy = false;
    this.clearBreaker();
  }

  private armBreaker(): void {
    this.clearBreaker();
    const ms = this.deps.turnMaxMs ?? TURN_MAX_MS;
    this.timer = this.deps.setTimeoutFn(() => {
      this.timer = null;
      this.release();
    }, ms);
  }

  private clearBreaker(): void {
    if (this.timer === null) return;
    this.deps.clearTimeoutFn(this.timer);
    this.timer = null;
  }
}
