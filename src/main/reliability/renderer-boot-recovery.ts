export type RendererBootRecoveryScheduler = Pick<
  typeof globalThis,
  "setTimeout" | "clearTimeout"
>;

export interface RendererBootRecoveryOptions {
  maxRecoveries: number;
  onExhausted: () => void;
  scheduler?: RendererBootRecoveryScheduler;
}

/**
 * Generation-bound retry budget shared by renderer load and mount recovery.
 *
 * A delayed retry from navigation A must never reload a healthy navigation B.
 * The budget resets only after a real renderer commit (or an explicit manual
 * retry from the recovery screen), not merely after did-finish-load.
 */
export class RendererBootRecovery {
  private generation = 0;
  private recoveries = 0;
  private stopped = false;
  private exhausted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly scheduler: RendererBootRecoveryScheduler;

  constructor(private readonly options: RendererBootRecoveryOptions) {
    if (
      !Number.isSafeInteger(options.maxRecoveries) ||
      options.maxRecoveries < 1
    ) {
      throw new Error("maxRecoveries must be a positive safe integer");
    }
    this.scheduler = options.scheduler ?? globalThis;
  }

  get attempts(): number {
    return this.recoveries;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  beginNavigation(options: { manualRetry?: boolean } = {}): void {
    this.generation += 1;
    this.cancelTimer();
    if (options.manualRetry) this.resetBudget();
  }

  rendererCommitted(): void {
    this.generation += 1;
    this.cancelTimer();
    this.resetBudget();
  }

  cancelPending(): void {
    this.generation += 1;
    this.cancelTimer();
  }

  halt(): void {
    this.stopped = true;
    this.generation += 1;
    this.cancelTimer();
  }

  dispose(): void {
    this.halt();
  }

  schedule(delayMs: number, recover: () => void): boolean {
    if (this.stopped || this.timer !== null) return false;
    if (this.recoveries >= this.options.maxRecoveries) {
      this.stopped = true;
      if (!this.exhausted) {
        this.exhausted = true;
        this.options.onExhausted();
      }
      return false;
    }

    this.recoveries += 1;
    const generation = this.generation;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (this.stopped || generation !== this.generation) return;
      recover();
    }, Math.max(0, delayMs));
    return true;
  }

  private resetBudget(): void {
    this.recoveries = 0;
    this.stopped = false;
    this.exhausted = false;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}
