export type PassiveWakeDeadlineResult<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'discarded' }
  | { readonly kind: 'busy' };

const DISCARDED = Symbol('passive-wake-discarded');
const TIMED_OUT = Symbol('passive-wake-timed-out');

/**
 * Renderer-owned deadline for passive wake STT. IPC cancellation is not a
 * prerequisite: a hung main/provider request can never hold the local gate.
 */
export class PassiveWakeDeadline {
  private generation = 0;
  private checking = false;
  private cancelActive: (() => void) | null = null;
  private cooldownUntil = 0;

  constructor(
    private readonly deadlineMs: number,
    private readonly timeoutCooldownMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  isChecking(): boolean {
    // A timeout means the provider path is unhealthy. Keep the always-on mic
    // recording locally, but do not immediately turn the next VAD endpoint
    // into another cloud request. Without this circuit breaker, a provider
    // outage produces one orphaned IPC request every ~4 seconds.
    return this.checking || this.now() < this.cooldownUntil;
  }

  async run<T>(operation: () => Promise<T>): Promise<PassiveWakeDeadlineResult<T>> {
    if (this.isChecking()) return { kind: 'busy' };

    const generation = ++this.generation;
    this.checking = true;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let discard!: () => void;
    const discarded = new Promise<typeof DISCARDED>((resolve) => {
      discard = () => resolve(DISCARDED);
    });
    this.cancelActive = discard;
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timeout = setTimeout(() => resolve(TIMED_OUT), this.deadlineMs);
    });

    try {
      const completed = operation().then((value) => ({ value }));
      const result = await Promise.race([completed, timedOut, discarded]);
      if (generation !== this.generation || result === DISCARDED) {
        return { kind: 'discarded' };
      }
      if (result === TIMED_OUT) {
        this.cooldownUntil = this.now() + this.timeoutCooldownMs;
        return { kind: 'timeout' };
      }
      this.cooldownUntil = 0;
      return { kind: 'completed', value: result.value };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (generation === this.generation) {
        this.checking = false;
        this.cancelActive = null;
      }
    }
  }

  invalidate(): void {
    this.generation += 1;
    this.checking = false;
    const cancel = this.cancelActive;
    this.cancelActive = null;
    cancel?.();
  }
}
