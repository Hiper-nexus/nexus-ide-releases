/**
 * Rate limiter — Fase 5 Jarvis Vision.
 * Simple token-bucket style: max 1 capture per 3 seconds.
 */
export class RateLimiter {
  private lastCaptureAt: number = 0;
  private readonly intervalMs: number;

  constructor(intervalMs: number = 3_000) {
    this.intervalMs = intervalMs;
  }

  /** Check if a capture is allowed right now. */
  canCapture(): boolean {
    return Date.now() - this.lastCaptureAt >= this.intervalMs;
  }

  /** Record a capture event. */
  markCaptured(): void {
    this.lastCaptureAt = Date.now();
  }

  /** Milliseconds until the next capture is allowed. */
  nextAvailableIn(): number {
    const elapsed = Date.now() - this.lastCaptureAt;
    return Math.max(0, this.intervalMs - elapsed);
  }

  /** Timestamp of the last capture (0 = never). */
  lastCapturedAt(): number {
    return this.lastCaptureAt;
  }
}