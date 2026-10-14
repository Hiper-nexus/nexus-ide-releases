import { onBootCompleteTrace, trace } from './main-trace';
import {
  getLastPaneSpawnAdmittedAt,
  hasPendingPaneSpawns,
  onPaneSpawnActivity,
} from '../orch/pane-admission';
import { MIN_CPU_HEADROOM, readCpuHeadroom } from '../pty/warm-pool';

/**
 * Post-boot idle queue (Item 9): background tasks that used to fire between
 * +0s and +26s after launch (model refresh, Redline sync/sink, CLI auto-update,
 * hook consent/ShotBridge, provisioning offers, mission quota poll, DB
 * conversation-edit prune) are queued here and only drain after
 * `boot-complete` + ~6s of quiet, pausing whenever a pane spawn is in flight
 * or CPU headroom is low.
 *
 * Nothing a pane spawn consumes belongs here (hook endpoint, CLI versions,
 * Claude token freshness): restored panes spawn at mount, before the drain.
 *
 * Ceilings: an absolute deadline (boot-complete + 45 s, or process start +
 * 90 s when the renderer never mounts) ends all gating; each task gets an
 * AbortSignal and a timeout, so a stuck task never holds the ones behind it.
 */

export const POST_BOOT_IDLE_QUIET_MS = 6_000;
export const POST_BOOT_SPAWN_SETTLE_MS = 2_000;
export const POST_BOOT_BUSY_POLL_MS = 500;
export const POST_BOOT_INTER_TASK_YIELD_MS = 50;
export const MAX_CPU_DEFERRALS_PER_TASK = 3;
export const POST_BOOT_DEADLINE_AFTER_MOUNT_MS = 45_000;
export const POST_BOOT_DEADLINE_WITHOUT_MOUNT_MS = 90_000;
export const POST_BOOT_TASK_TIMEOUT_MS = 30_000;
export const POST_BOOT_STOP_TIMEOUT_MS = 1_500;

export type PostBootIdleTaskRun = (signal: AbortSignal) => void | Promise<void>;

export interface PostBootIdleTask {
  readonly name: string;
  readonly run: PostBootIdleTaskRun;
}

export interface PostBootIdleQueueDeps {
  readonly now?: () => number;
  readonly quietMs?: number;
  readonly spawnSettleMs?: number;
  readonly busyPollMs?: number;
  readonly interTaskYieldMs?: number;
  readonly maxCpuDeferrals?: number;
  readonly deadlineAfterMountMs?: number;
  readonly deadlineWithoutMountMs?: number;
  readonly taskTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly hasPendingSpawns?: () => boolean;
  readonly getLastSpawnAt?: () => number;
  readonly hasCpuHeadroom?: () => boolean;
  readonly onTaskError?: (name: string, error: unknown) => void;
}

export interface PostBootIdleQueueStatus {
  readonly bootCompleted: boolean;
  readonly bootCompleteAt: number | null;
  readonly initialQuietReached: boolean;
  readonly deadlineReached: boolean;
  readonly runningTask: string | null;
  readonly queuedNames: readonly string[];
  readonly completedCount: number;
  readonly stopped: boolean;
}

/** Resolves after `ms` unless cancelled; never keeps the process alive. */
function delay(ms: number): { promise: Promise<'elapsed'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'elapsed'>((resolve) => {
    timer = setTimeout(() => resolve('elapsed'), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export class PostBootIdleQueue {
  readonly #now: () => number;
  readonly #quietMs: number;
  readonly #spawnSettleMs: number;
  readonly #busyPollMs: number;
  readonly #interTaskYieldMs: number;
  readonly #maxCpuDeferrals: number;
  readonly #deadlineAfterMountMs: number;
  readonly #deadlineWithoutMountMs: number;
  readonly #taskTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #hasPendingSpawns: () => boolean;
  readonly #getLastSpawnAt: () => number;
  readonly #hasCpuHeadroom: () => boolean;
  readonly #onTaskError: (name: string, error: unknown) => void;

  #queue: PostBootIdleTask[] = [];
  #processStartAt: number | null = null;
  #bootCompleteAt: number | null = null;
  #initialQuietReached = false;
  #deadlineReached = false;
  #lastObservedPendingAt = 0;
  #lastSpawnAdmittedAt = 0;
  #cpuDeferralsForHead = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #runningTask: string | null = null;
  #runningController: AbortController | null = null;
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
    this.#deadlineAfterMountMs = deps.deadlineAfterMountMs ?? POST_BOOT_DEADLINE_AFTER_MOUNT_MS;
    this.#deadlineWithoutMountMs = deps.deadlineWithoutMountMs ?? POST_BOOT_DEADLINE_WITHOUT_MOUNT_MS;
    this.#taskTimeoutMs = deps.taskTimeoutMs ?? POST_BOOT_TASK_TIMEOUT_MS;
    this.#stopTimeoutMs = deps.stopTimeoutMs ?? POST_BOOT_STOP_TIMEOUT_MS;
    this.#hasPendingSpawns = deps.hasPendingSpawns ?? hasPendingPaneSpawns;
    this.#getLastSpawnAt = deps.getLastSpawnAt ?? getLastPaneSpawnAdmittedAt;
    this.#hasCpuHeadroom = deps.hasCpuHeadroom ?? (() => readCpuHeadroom() >= MIN_CPU_HEADROOM);
    this.#onTaskError =
      deps.onTaskError ??
      ((name, error) => {
        console.warn(`[post-boot-idle] task "${name}" failed:`, error);
      });
  }

  enqueue(name: string, run: PostBootIdleTaskRun): void {
    if (this.#stopped) return;
    const existingIndex = this.#queue.findIndex((item) => item.name === name);
    if (existingIndex >= 0) {
      this.#queue[existingIndex] = { name, run };
    } else {
      this.#queue.push({ name, run });
    }
    this.#scheduleNextCheck();
  }

  /** Arms the no-mount deadline (process start + 90 s). Main calls it at whenReady. */
  start(processStartAt: number): void {
    if (this.#stopped) return;
    this.#processStartAt ??= processStartAt;
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

  /** Background work may start now: past the deadline, or quiet with no spawn in flight. */
  isIdleReady(): boolean {
    if (this.#isPastDeadline(this.#now())) return true;
    return this.isInitialQuietReached() && !this.#hasPendingSpawns();
  }

  status(): PostBootIdleQueueStatus {
    return {
      bootCompleted: this.#bootCompleteAt !== null,
      bootCompleteAt: this.#bootCompleteAt,
      initialQuietReached: this.isInitialQuietReached(),
      deadlineReached: this.#deadlineReached,
      runningTask: this.#runningTask,
      queuedNames: this.#queue.map((t) => t.name),
      completedCount: this.#completedCount,
      stopped: this.#stopped,
    };
  }

  /** Aborts the running task and waits for it at most `stopTimeoutMs`. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearTimer();
    this.#queue = [];
    this.#runningController?.abort(new Error('post-boot idle queue stopped'));
    const running = this.#runningPromise;
    if (!running) return;
    const ceiling = delay(this.#stopTimeoutMs);
    await Promise.race([running, ceiling.promise]);
    ceiling.cancel();
  }

  resetForTesting(): void {
    this.#clearTimer();
    this.#runningController?.abort(new Error('post-boot idle queue reset'));
    this.#queue = [];
    this.#processStartAt = null;
    this.#bootCompleteAt = null;
    this.#initialQuietReached = false;
    this.#deadlineReached = false;
    this.#lastObservedPendingAt = 0;
    this.#lastSpawnAdmittedAt = 0;
    this.#cpuDeferralsForHead = 0;
    this.#runningTask = null;
    this.#runningController = null;
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

  #deadlineAt(): number | null {
    if (this.#bootCompleteAt !== null) return this.#bootCompleteAt + this.#deadlineAfterMountMs;
    if (this.#processStartAt !== null) return this.#processStartAt + this.#deadlineWithoutMountMs;
    return null;
  }

  /** Latched: a late mount cannot move a passed no-mount deadline back. */
  #isPastDeadline(now: number): boolean {
    if (!this.#deadlineReached) {
      const deadlineAt = this.#deadlineAt();
      this.#deadlineReached = deadlineAt !== null && now >= deadlineAt;
    }
    return this.#deadlineReached;
  }

  #gatedWaitMs(now: number): number | null {
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

  #computeWaitMs(now: number): number | null {
    if (this.#isPastDeadline(now)) return 0;
    const gated = this.#gatedWaitMs(now);
    const deadlineAt = this.#deadlineAt();
    if (deadlineAt === null) return gated;
    const untilDeadline = deadlineAt - now;
    return gated === null ? untilDeadline : Math.min(gated, untilDeadline);
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

    if (
      !this.#isPastDeadline(now) &&
      this.#cpuDeferralsForHead < this.#maxCpuDeferrals &&
      !this.#hasCpuHeadroom()
    ) {
      this.#cpuDeferralsForHead += 1;
      this.#armTimer(this.#busyPollMs);
      return;
    }

    const next = this.#queue.shift();
    if (!next) return;
    this.#cpuDeferralsForHead = 0;
    const runPromise = this.#runTask(next);
    this.#runningPromise = runPromise;
    await runPromise;

    if (!this.#stopped && this.#queue.length > 0) {
      this.#scheduleNextCheck(this.#interTaskYieldMs);
    }
  }

  async #runTask(task: PostBootIdleTask): Promise<void> {
    const controller = new AbortController();
    this.#runningController = controller;
    this.#runningTask = task.name;
    const startedAt = this.#now();
    const timeout = delay(this.#taskTimeoutMs);
    try {
      const work = Promise.resolve()
        .then(() => task.run(controller.signal))
        .then(
          () => 'done' as const,
          (error: unknown) => {
            if (!controller.signal.aborted) this.#onTaskError(task.name, error);
            return 'failed' as const;
          },
        );
      if ((await Promise.race([work, timeout.promise])) === 'elapsed' && !controller.signal.aborted) {
        // ponytail: the task keeps whatever it already started; abort is the
        // cooperative cancel, the queue just stops waiting for it.
        controller.abort(new Error(`post-boot task "${task.name}" timed out`));
        this.#onTaskError(task.name, new Error(`timed out after ${this.#taskTimeoutMs} ms`));
      }
    } finally {
      timeout.cancel();
      try {
        trace({
          kind: 'post-boot-idle-task',
          name: task.name,
          durationMs: Math.max(0, this.#now() - startedAt),
        });
      } catch {
        // Diagnostics never throw into the queue.
      }
      this.#completedCount += 1;
      this.#runningTask = null;
      this.#runningController = null;
      this.#runningPromise = null;
    }
  }
}

const defaultQueue = new PostBootIdleQueue();
let defaultQueueWiring: (() => void) | null = null;

/**
 * Wires the singleton to boot-complete and pane-spawn activity and arms the
 * no-mount deadline. Main calls it once at whenReady; until then (unit tests
 * importing db/quota/adapters) queued tasks never drain on their own.
 */
export function startPostBootIdleQueue(
  processStartAt = Math.round(performance.timeOrigin),
): void {
  if (!defaultQueueWiring) {
    const unsubscribeBoot = onBootCompleteTrace((at) => defaultQueue.notifyBootComplete(at));
    const unsubscribeSpawn = onPaneSpawnActivity((at) => defaultQueue.notifyPaneSpawnActivity(at));
    defaultQueueWiring = () => {
      unsubscribeBoot();
      unsubscribeSpawn();
    };
  }
  defaultQueue.start(processStartAt);
}

export function enqueuePostBootIdleTask(name: string, run: PostBootIdleTaskRun): void {
  defaultQueue.enqueue(name, run);
}

export function isPostBootIdleReady(): boolean {
  return defaultQueue.isIdleReady();
}

export function getPostBootIdleQueueStatus(): PostBootIdleQueueStatus {
  return defaultQueue.status();
}

export function stopPostBootIdleQueue(): Promise<void> {
  return defaultQueue.stop();
}

export function resetPostBootIdleQueueForTest(): void {
  defaultQueueWiring?.();
  defaultQueueWiring = null;
  defaultQueue.resetForTesting();
}
