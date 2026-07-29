export const ORCHESTRATION_START_INITIAL_RETRY_MS = 250;
export const ORCHESTRATION_START_MAX_RETRY_MS = 5_000;

export type OrchestrationStartStatus =
  | 'idle'
  | 'starting'
  | 'retry-wait'
  | 'ready'
  | 'stopped';

export interface OrchestrationStartHealth {
  readonly status: OrchestrationStartStatus;
  readonly attempts: number;
  readonly retryScheduled: boolean;
  readonly nextRetryAt: number | null;
  readonly lastError: string | null;
}

type StartScheduler = Pick<
  typeof globalThis,
  'setTimeout' | 'clearTimeout'
>;

export interface OrchestrationStartSupervisorOptions {
  readonly startMcpServer: () => Promise<void>;
  readonly startCoordinator: () => void;
  readonly resetFailedMcpStart?: () => void;
  readonly reportRetry?: (
    error: unknown,
    health: OrchestrationStartHealth,
  ) => void;
  readonly scheduler?: StartScheduler;
  readonly now?: () => number;
}

function stoppedBeforeReadyError(): Error {
  const error = new Error(
    'orchestration start supervisor stopped before becoming ready',
  );
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the MCP → coordinator bootstrap as one durable, single-flight process.
 *
 * A transient localhost bind failure must not permanently strand persisted
 * missions. Retries continue with a capped delay until this owner is stopped;
 * shutdown cancels the timer and drains an already-running start attempt.
 */
export class OrchestrationStartSupervisor {
  private readonly scheduler: StartScheduler;
  private readonly now: () => number;
  private status: OrchestrationStartStatus = 'idle';
  private attempts = 0;
  private nextRetryAt: number | null = null;
  private lastError: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attemptFlight: Promise<void> | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private hasSettledReadyPromise = false;
  private hasStartedCoordinator = false;

  constructor(
    private readonly options: OrchestrationStartSupervisorOptions,
  ) {
    this.scheduler = options.scheduler ?? globalThis;
    this.now = options.now ?? Date.now;
  }

  get health(): OrchestrationStartHealth {
    return Object.freeze({
      status: this.status,
      attempts: this.attempts,
      retryScheduled:
        this.status === 'retry-wait' && this.retryTimer !== null,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
    });
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    if (this.status === 'stopped') {
      return Promise.reject(stoppedBeforeReadyError());
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.runAttempt();
    return this.readyPromise;
  }

  stop(): Promise<void> {
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      this.nextRetryAt = null;
      this.cancelRetry();
      this.rejectReadiness(stoppedBeforeReadyError());
    }
    return this.attemptFlight ?? Promise.resolve();
  }

  private runAttempt(): void {
    if (
      this.status === 'stopped' ||
      this.status === 'ready' ||
      this.attemptFlight
    ) {
      return;
    }

    this.status = 'starting';
    this.attempts += 1;
    const attempt = Promise.resolve()
      .then(() => this.options.startMcpServer())
      .then(() => {
        if (this.status === 'stopped') return;
        if (!this.hasStartedCoordinator) {
          this.options.startCoordinator();
          this.hasStartedCoordinator = true;
        }
        this.status = 'ready';
        this.nextRetryAt = null;
        this.lastError = null;
        this.resolveReadiness();
      })
      .catch((error: unknown) => {
        if (this.status === 'stopped') return;
        this.lastError = errorMessage(error);
        this.options.resetFailedMcpStart?.();
        this.scheduleRetry(error);
      })
      .finally(() => {
        if (this.attemptFlight === attempt) this.attemptFlight = null;
      });
    this.attemptFlight = attempt;
  }

  private scheduleRetry(error: unknown): void {
    const exponent = Math.min(this.attempts - 1, 30);
    const delayMs = Math.min(
      ORCHESTRATION_START_INITIAL_RETRY_MS * 2 ** exponent,
      ORCHESTRATION_START_MAX_RETRY_MS,
    );
    this.status = 'retry-wait';
    this.nextRetryAt = this.now() + delayMs;
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      this.runAttempt();
    }, delayMs);
    (
      this.retryTimer as ReturnType<typeof setTimeout> & {
        unref?: () => void;
      }
    ).unref?.();
    this.options.reportRetry?.(error, this.health);
  }

  private cancelRetry(): void {
    if (this.retryTimer === null) return;
    this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private resolveReadiness(): void {
    if (this.hasSettledReadyPromise) return;
    this.hasSettledReadyPromise = true;
    this.resolveReady?.();
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private rejectReadiness(error: Error): void {
    if (this.hasSettledReadyPromise || !this.readyPromise) return;
    this.hasSettledReadyPromise = true;
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
  }
}
