import { onBootCompleteTrace, trace } from './main-trace';
import {
  getLastPaneSpawnAdmittedAt,
  hasPendingPaneSpawns,
  onPaneSpawnActivity,
} from '../orch/pane-admission';
import { warmPool } from '../pty/warm-pool';

/**
 * Post-boot idle queue (Item 9): background tasks that used to fire between
 * +0s and +26s after launch (model refresh, Redline sync/sink, Claude token
 * freshness, CLI auto-update, hook/ShotBridge servers, provisioning offers,
 * mission quota poll, DB conversation-edit prune) are queued here and only
 * drain after `boot-complete` + ~5–10s of quiet, pausing whenever a pane spawn
 * is in flight or CPU headroom is low.
 */

export const POST_BOOT_IDLE_QUIET_MS = 6_000;
export const POST_BOOT_SPAWN_SETTLE_MS = 2_000;
export const POST_BOOT_BUSY_POLL_MS = 500;
export const POST_BOOT_INTER_TASK_YIELD_MS = 50;
export const MAX_CPU_DEFERRALS_PER_TASK = 3;

export interface PostBootIdleTask {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface PostBootIdleQueueDeps {
  readonly now?: () => number;
  readonly quietMs?: number;
  readonly spawnSettleMs?: number;
  readonly busyPollMs?: number;
  readonly interTaskYieldMs?: number;
  readonly maxCpuDeferrals?: number;
  readonly hasPendingSpawns?: () => boolean;
  readonly getLastSpawnAt?: () => number;
  readonly hasCpuHeadroom?: () => boolean;
  readonly onTaskError?: (name: string, error: unknown) => void;
}

export interface PostBootIdleQueueStatus {
  readonly bootCompleted: boolean;
  readonly bootCompleteAt: number | null;
  readonly initialQuietReached: boolean;
  readonly runningTask: string | null;
  readonly queuedNames: readonly string[];
  readonly completedCount: number;
  readonly stopped: boolean;
}

export class PostBootIdleQueue {
  readonly #now: () => number;
  readonly #quietMs: number;
  readonly #spawnSettleMs: number;
  readonly #busyPollMs: number;
  readonly #interTaskYieldMs: number;
  readonly #maxCpuDeferrals: number;
  readonly #hasPendingSpawns: () => boolean;
  readonly #getLastSpawnAt: () => number;
  readonly #hasCpuHeadroom: () => boolean;
  readonly #onTaskError: (name: string, error: unknown) => void;

  #queue: PostBootIdleTask[] = [];
  #bootCompleteAt: number | null = null;
  #initialQuietReached = false;
  #lastObservedPendingAt = 0;
  #lastSpawnAdmittedAt = 0;
  #cpuDeferralsForHead = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #runningTask: string | null = null;
  #runningPromise: Promise<void> | null = null;
  #completedCount = 0;
  #stopped = false;

  constructor(deps: PostBootIdleQueueDeps = {}) {
    this.#now = deps.now ?? (() => Date.now());
    this.#quietMs = deps.quietMs ?? POST_BOOT_IDLE_QUIET_MS;
    this.#spawnSettleMs = deps.spawnSettleMs ?? POST_BOOT_SPAWN_SETTLE_MS;
    this.#busyPollMs = deps.busyPollMs ?? POST_BOOT_BUSY_POLL_MS;
    this.#interTaskYieldMs = deps.interTaskYieldMs ?? POST_BOOT_INTER_TASK_YIELD_MS;
    this.#maxCpuDeferrals = deps.maxCpuDeferrals ?? MAX_CPU_DEFERRALS_PER_TASK;
    this.#hasPendingSpawns = deps.hasPendingSpawns ?? hasPendingPaneSpawns;
    this.#getLastSpawnAt = deps.getLastSpawnAt ?? getLastPaneSpawnAdmittedAt;
    this.#hasCpuHeadroom =
      deps.hasCpuHeadroom ?? (() => warmPool.canReplenish().ok);
    this.#onTaskError =
      deps.onTaskError ??
      ((name, error) => {
        console.warn(`[post-boot-idle] task "${name}" failed:`, error);
      });
  }

  enqueue(name: string, run: () => void | Promise<void>): void {
    if (this.#stopped) return;
    const existingIndex = this.#queue.findIndex((item) => item.name === name);
    if (existingIndex >= 0) {
      this.#queue[existingIndex] = { name, run };
    } else {
      this.#queue.push({ name, run });
    }
    this.#scheduleNextCheck();
  }

  notifyBootComplete(at = this.#now()): void {
    if (this.#stopped) return;
    if (this.#bootCompleteAt === null) {
      this.#bootCompleteAt = at;
    }
    this.#scheduleNextCheck();
  }

  notifyPaneSpawnActivity(at = this.#now()): void {
    if (this.#stopped) return;
    this.#lastSpawnAdmittedAt = Math.max(this.#lastSpawnAdmittedAt, at);
    if (this.#timer && !this.#runningPromise) {
      this.#scheduleNextCheck();
    }
  }

  isInitialQuietReached(): boolean {
    if (this.#initialQuietReached) return true;
    if (this.#bootCompleteAt === null) return false;
    return this.#now() - this.#bootCompleteAt >= this.#quietMs;
  }

  status(): PostBootIdleQueueStatus {
    return {
      bootCompleted: this.#bootCompleteAt !== null,
      bootCompleteAt: this.#bootCompleteAt,
      initialQuietReached: this.isInitialQuietReached(),
      runningTask: this.#runningTask,
      queuedNames: this.#queue.map((t) => t.name),
      completedCount: this.#completedCount,
      stopped: this.#stopped,
    };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearTimer();
    this.#queue = [];
    if (this.#runningPromise) {
      await this.#runningPromise;
    }
  }

  resetForTesting(): void {
    this.#clearTimer();
    this.#queue = [];
    this.#bootCompleteAt = null;
    this.#initialQuietReached = false;
    this.#lastObservedPendingAt = 0;
    this.#lastSpawnAdmittedAt = 0;
    this.#cpuDeferralsForHead = 0;
    this.#runningTask = null;
    this.#runningPromise = null;
    this.#completedCount = 0;
    this.#stopped = false;
  }

  #clearTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #armTimer(delayMs: number): void {
    this.#clearTimer();
    if (this.#stopped || this.#runningPromise || this.#queue.length === 0) {
      return;
    }
    const clamped = Math.max(0, delayMs);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, clamped);
    this.#timer.unref?.();
  }

  #computeWaitMs(now: number): number | null {
    if (this.#bootCompleteAt === null) return null;
    const untilBootQuiet = this.#bootCompleteAt + this.#quietMs - now;
    if (untilBootQuiet > 0) {
      return untilBootQuiet;
    }
    this.#initialQuietReached = true;

    if (this.#hasPendingSpawns()) {
      this.#lastObservedPendingAt = Math.max(this.#lastObservedPendingAt, now);
      return this.#busyPollMs;
    }

    const lastSpawnAt = Math.max(
      this.#lastSpawnAdmittedAt,
      this.#getLastSpawnAt(),
      this.#lastObservedPendingAt,
    );
    if (lastSpawnAt > 0) {
      const untilSpawnSettled = lastSpawnAt + this.#spawnSettleMs - now;
      if (untilSpawnSettled > 0) {
        return untilSpawnSettled;
      }
    }

    return 0;
  }

  #scheduleNextCheck(minDelayMs = 0): void {
    if (this.#stopped || this.#runningPromise || this.#queue.length === 0) {
      return;
    }
    const waitMs = this.#computeWaitMs(this.#now());
    if (waitMs === null) return;
    this.#armTimer(Math.max(minDelayMs, waitMs));
  }

  async #tick(): Promise<void> {
    if (this.#stopped || this.#runningPromise || this.#queue.length === 0) {
      return;
    }
    const now = this.#now();
    const waitMs = this.#computeWaitMs(now);
    if (waitMs === null) return;
    if (waitMs > 0) {
      this.#armTimer(waitMs);
      return;
    }

    if (!this.#hasCpuHeadroom() && this.#cpuDeferralsForHead < this.#maxCpuDeferrals) {
      this.#cpuDeferralsForHead += 1;
      this.#armTimer(this.#busyPollMs);
      return;
    }

    const next = this.#queue.shift();
    if (!next) return;
    this.#cpuDeferralsForHead = 0;
    this.#runningTask = next.name;
    const startedAt = this.#now();
    const runPromise = (async () => {
      try {
        await next.run();
      } catch (error) {
        this.#onTaskError(next.name, error);
      } finally {
        const elapsedMs = Math.max(0, this.#now() - startedAt);
        trace({
          kind: 'post-boot-idle-task',
          name: next.name,
          durationMs: elapsedMs,
        });
        this.#completedCount += 1;
        this.#runningTask = null;
        this.#runningPromise = null;
      }
    })();
    this.#runningPromise = runPromise;
    await runPromise;

    if (!this.#stopped && this.#queue.length > 0) {
      this.#scheduleNextCheck(this.#interTaskYieldMs);
    }
  }
}

const defaultQueue = new PostBootIdleQueue();

onBootCompleteTrace((at) => {
  defaultQueue.notifyBootComplete(at);
});

onPaneSpawnActivity((at) => {
  defaultQueue.notifyPaneSpawnActivity(at);
});

export function enqueuePostBootIdleTask(
  name: string,
  run: () => void | Promise<void>,
): void {
  defaultQueue.enqueue(name, run);
}

export function notifyPostBootComplete(at?: number): void {
  defaultQueue.notifyBootComplete(at);
}

export function isPostBootIdleReady(): boolean {
  return defaultQueue.isInitialQuietReached() && !hasPendingPaneSpawns();
}

export function getPostBootIdleQueueStatus(): PostBootIdleQueueStatus {
  return defaultQueue.status();
}

export function stopPostBootIdleQueue(): Promise<void> {
  return defaultQueue.stop();
}

export function resetPostBootIdleQueueForTest(): void {
  defaultQueue.resetForTesting();
}
