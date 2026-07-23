import type {
  McpConfirmationHandler,
  McpConfirmationRequest,
} from './mcp-dispatch';

interface PendingConfirmation {
  readonly request: McpConfirmationRequest;
  readonly resolve: (approved: boolean) => void;
  readonly reject: (error: Error) => void;
}

export interface McpConfirmationSchedulerOptions {
  readonly maxOutstandingPerSession?: number;
  readonly maxRequestsPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_OUTSTANDING_PER_SESSION = 4;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 4;
const DEFAULT_RATE_WINDOW_MS = 30_000;

/**
 * Main-owned confirmation scheduler.
 *
 * Requests are isolated by the gate-bound session, served round-robin and
 * globally rendered one at a time. This prevents one noisy agent from
 * starving the fleet without ever showing overlapping native dialogs whose
 * buttons could be mistaken for another agent's request.
 */
export class McpConfirmationScheduler {
  readonly #show: McpConfirmationHandler;
  readonly #maxOutstandingPerSession: number;
  readonly #maxRequestsPerWindow: number;
  readonly #rateWindowMs: number;
  readonly #now: () => number;
  readonly #queues = new Map<string, PendingConfirmation[]>();
  readonly #rotation: string[] = [];
  readonly #outstanding = new Map<string, number>();
  readonly #requestTimes = new Map<string, number[]>();
  #activeSessionId: string | null = null;
  #draining = false;
  #closed = false;

  constructor(
    show: McpConfirmationHandler,
    options: McpConfirmationSchedulerOptions = {},
  ) {
    this.#show = show;
    this.#maxOutstandingPerSession =
      options.maxOutstandingPerSession ?? DEFAULT_MAX_OUTSTANDING_PER_SESSION;
    this.#maxRequestsPerWindow =
      options.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
    this.#rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
    this.#now = options.now ?? Date.now;
  }

  enqueue(request: McpConfirmationRequest): Promise<boolean> {
    if (this.#closed) {
      return Promise.reject(new Error('confirmation_scheduler_closed'));
    }
    const key = request.sessionId;
    const outstanding = this.#outstanding.get(key) ?? 0;
    if (outstanding >= this.#maxOutstandingPerSession) {
      return Promise.reject(new Error('confirmation_queue_full'));
    }

    const now = this.#now();
    const recent = (this.#requestTimes.get(key) ?? []).filter(
      (at) => now - at <= this.#rateWindowMs,
    );
    if (recent.length >= this.#maxRequestsPerWindow) {
      this.#requestTimes.set(key, recent);
      return Promise.reject(new Error('confirmation_rate_limited'));
    }
    recent.push(now);
    this.#requestTimes.set(key, recent);
    this.#outstanding.set(key, outstanding + 1);

    const promise = new Promise<boolean>((resolve, reject) => {
      const queue = this.#queues.get(key) ?? [];
      queue.push({ request, resolve, reject });
      this.#queues.set(key, queue);
      if (
        key !== this.#activeSessionId &&
        !this.#rotation.includes(key)
      ) {
        this.#rotation.push(key);
      }
    });
    this.#scheduleDrain();
    return promise;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error('confirmation_scheduler_closed');
    for (const queue of this.#queues.values()) {
      for (const entry of queue) entry.reject(error);
    }
    this.#queues.clear();
    this.#rotation.length = 0;
    this.#outstanding.clear();
    this.#requestTimes.clear();
  }

  #scheduleDrain(): void {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    queueMicrotask(() => {
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#closed) {
        const key = this.#rotation.shift();
        if (!key) return;
        const queue = this.#queues.get(key);
        const entry = queue?.shift();
        if (!entry || !queue) {
          this.#queues.delete(key);
          continue;
        }
        if (queue.length === 0) this.#queues.delete(key);
        this.#activeSessionId = key;
        try {
          entry.resolve(await this.#show(entry.request));
        } catch (error) {
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          const outstanding = (this.#outstanding.get(key) ?? 1) - 1;
          if (outstanding > 0) this.#outstanding.set(key, outstanding);
          else this.#outstanding.delete(key);
          this.#activeSessionId = null;
        }
        if (
          !this.#closed &&
          (this.#queues.get(key)?.length ?? 0) > 0 &&
          !this.#rotation.includes(key)
        ) {
          this.#rotation.push(key);
        }
      }
    } finally {
      this.#draining = false;
      if (!this.#closed && this.#rotation.length > 0) this.#scheduleDrain();
    }
  }
}
