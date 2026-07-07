/**
 * Rate limiter — Fase 5 Jarvis Vision.
 * Token-bucket style limiter for capture attempts.
 */
export class RateLimiter {
  private acquiredAt: number[] = [];
  private readonly intervalMs: number;
  private readonly maxAttempts: number;

  constructor(intervalMs: number = 3_000, maxAttempts: number = 1) {
    this.intervalMs = intervalMs;
    this.maxAttempts = maxAttempts;
  }

  private prune(now: number): void {
    this.acquiredAt = this.acquiredAt.filter(
      (timestamp) => now - timestamp < this.intervalMs,
    );
  }

  /** Check if a capture is allowed right now. */
  canCapture(): boolean {
    const now = Date.now();
    this.prune(now);
    return this.acquiredAt.length < this.maxAttempts;
  }

  /**
   * Atomically consume a capture attempt before async capture work starts.
   * Tokens are not refunded when the subsequent capture fails.
   */
  tryAcquire(): boolean {
    const now = Date.now();
    this.prune(now);
    if (this.acquiredAt.length >= this.maxAttempts) return false;
    this.acquiredAt = [...this.acquiredAt, now];
    return true;
  }

  /** Record a capture event. */
  markCaptured(): void {
    this.acquiredAt = [...this.acquiredAt, Date.now()];
  }

  /** Milliseconds until the next capture is allowed. */
  nextAvailableIn(): number {
    const now = Date.now();
    this.prune(now);
    if (this.acquiredAt.length < this.maxAttempts) return 0;
    const oldest = Math.min(...this.acquiredAt);
    return Math.max(0, this.intervalMs - (now - oldest));
  }

  /** Timestamp of the last capture (0 = never). */
  lastCapturedAt(): number {
    return this.acquiredAt.at(-1) ?? 0;
  }
}
