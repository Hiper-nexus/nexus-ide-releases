import os from 'node:os';

export interface WarmSession {
  readonly sessionId: string;
  readonly startKey: string;
  readonly cli: string;
  readonly bornAtMs: number;
  readonly cwd: string;
}

export interface WarmPoolMetrics {
  hits: number;
  misses: number;
  readyCount: number;
  minHeadroom: number;
  skippedByCpu: number;
  evictedStale: number;
  replenished: number;
}

export interface WarmPoolOptions {
  readonly maxAgeMs?: number;
  readonly minCpuHeadroom?: number;
  readonly spawnFn?: (cli: string) => Promise<WarmSession | null>;
  readonly destroyFn?: (sessionId: string, startKey?: string) => void;
  readonly isAliveFn?: (sessionId: string) => boolean;
}

const DEFAULT_MAX_AGE_MS = 10 * 60_000; // 10 minutes
const DEFAULT_MIN_CPU_HEADROOM = 0.25; // 25% CPU headroom required

export class WarmPool {
  private readonly queues = new Map<string, WarmSession[]>();
  private readonly maxAgeMs: number;
  private readonly minCpuHeadroom: number;
  private spawnFn?: (cli: string) => Promise<WarmSession | null>;
  private destroyFn?: (sessionId: string, startKey?: string) => void;
  private isAliveFn?: (sessionId: string) => boolean;
  private targetSizeOverride: number | null = null;

  private metrics: WarmPoolMetrics = {
    hits: 0,
    misses: 0,
    readyCount: 0,
    minHeadroom: 1.0,
    skippedByCpu: 0,
    evictedStale: 0,
    replenished: 0,
  };

  constructor(options: WarmPoolOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.minCpuHeadroom = options.minCpuHeadroom ?? DEFAULT_MIN_CPU_HEADROOM;
    this.spawnFn = options.spawnFn;
    this.destroyFn = options.destroyFn;
    this.isAliveFn = options.isAliveFn;
  }

  setSpawnFn(fn: (cli: string) => Promise<WarmSession | null>): void {
    this.spawnFn = fn;
  }

  setDestroyFn(fn: (sessionId: string, startKey?: string) => void): void {
    this.destroyFn = fn;
  }

  setIsAliveFn(fn: (sessionId: string) => boolean): void {
    this.isAliveFn = fn;
  }

  /**
   * Configured warm pool size per CLI. Defaults to 0 (disabled) unless
   * NEXUS_WARM_POOL_SIZE environment variable is set or overridden.
   */
  getWarmPoolSize(): number {
    if (this.targetSizeOverride !== null) {
      return this.targetSizeOverride;
    }
    const envVal = process.env.NEXUS_WARM_POOL_SIZE;
    if (envVal) {
      const parsed = parseInt(envVal, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
    }
    return 0;
  }

  setWarmPoolSize(size: number): void {
    this.targetSizeOverride = Math.max(0, size);
  }

  /**
   * Computes available CPU headroom from system load average and CPU count.
   * Headroom is in range [0, 1] where 1 means 100% idle.
   */
  measureCpuHeadroom(): number {
    const cpus = os.cpus()?.length || 1;
    const load1m = os.loadavg()?.[0] ?? 0;
    const headroom = Math.max(0, 1 - load1m / cpus);
    if (headroom < this.metrics.minHeadroom) {
      this.metrics.minHeadroom = headroom;
    }
    return headroom;
  }

  /**
   * Checks if CPU headroom allows background replenishment.
   */
  canReplenish(): { ok: boolean; headroom: number } {
    const headroom = this.measureCpuHeadroom();
    if (headroom < this.minCpuHeadroom) {
      this.metrics.skippedByCpu += 1;
      console.warn(`[warm-pool] reposição adiada folga=${headroom.toFixed(2)}`);
      return { ok: false, headroom };
    }
    return { ok: true, headroom };
  }

  /**
   * Evicts sessions older than maxAgeMs.
   */
  evictStale(maxAgeMs = this.maxAgeMs, now = Date.now()): number {
    let totalEvicted = 0;
    for (const [cli, queue] of this.queues.entries()) {
      const fresh: WarmSession[] = [];
      for (const session of queue) {
        if (now - session.bornAtMs > maxAgeMs) {
          totalEvicted += 1;
          try {
            this.destroyFn?.(session.sessionId, session.startKey);
          } catch (err) {
            console.warn(
              `[warm-pool] error destroying evicted session ${session.sessionId}:`,
              err,
            );
          }
        } else {
          fresh.push(session);
        }
      }
      this.queues.set(cli, fresh);
    }

    if (totalEvicted > 0) {
      this.metrics.evictedStale += totalEvicted;
      this.updateReadyCount();
    }
    return totalEvicted;
  }

  /**
   * Takes a pre-spawned session for the given CLI if available.
   * Returns session (hit), or null if pool is empty or disabled (miss).
   */
  take(cli: string): WarmSession | null {
    const targetSize = this.getWarmPoolSize();
    if (targetSize <= 0) {
      this.metrics.misses += 1;
      return null;
    }

    this.evictStale();

    const queue = this.queues.get(cli);
    while (queue && queue.length > 0) {
      const session = queue.shift()!;
      if (this.isAliveFn && !this.isAliveFn(session.sessionId)) {
        this.destroyFn?.(session.sessionId, session.startKey);
        continue;
      }
      this.metrics.hits += 1;
      this.updateReadyCount();
      // Background replenishment if CPU has headroom
      void this.replenish(cli);
      return session;
    }

    this.metrics.misses += 1;
    // On miss, also attempt replenishment in background
    void this.replenish(cli);
    return null;
  }

  /**
   * Adds an already-booted warm session to the pool.
   */
  put(session: WarmSession): void {
    const targetSize = this.getWarmPoolSize();
    if (targetSize <= 0) {
      // Discard if pool disabled
      this.destroyFn?.(session.sessionId, session.startKey);
      return;
    }
    const queue = this.queues.get(session.cli) ?? [];
    if (queue.length >= targetSize) {
      // At capacity, discard
      this.destroyFn?.(session.sessionId, session.startKey);
      return;
    }
    queue.push(session);
    this.queues.set(session.cli, queue);
    this.updateReadyCount();
  }

  /**
   * Asynchronously replenishes the pool for a given CLI up to targetSize,
   * guarded by CPU headroom.
   */
  async replenish(cli: string): Promise<boolean> {
    const targetSize = this.getWarmPoolSize();
    if (targetSize <= 0 || !this.spawnFn) return false;

    const currentQueue = this.queues.get(cli) ?? [];
    if (currentQueue.length >= targetSize) return false;

    const { ok } = this.canReplenish();
    if (!ok) return false;

    try {
      const session = await this.spawnFn(cli);
      if (!session) return false;

      const queue = this.queues.get(cli) ?? [];
      if (queue.length < targetSize) {
        queue.push(session);
        this.queues.set(cli, queue);
        this.metrics.replenished += 1;
        this.updateReadyCount();
        return true;
      } else {
        this.destroyFn?.(session.sessionId, session.startKey);
        return false;
      }
    } catch (err) {
      console.warn(`[warm-pool] replenishment failed for ${cli}:`, err);
      return false;
    }
  }

  private updateReadyCount(): void {
    let count = 0;
    for (const queue of this.queues.values()) {
      count += queue.length;
    }
    this.metrics.readyCount = count;
  }

  getMetrics(): WarmPoolMetrics {
    this.updateReadyCount();
    return { ...this.metrics };
  }

  resetForTesting(): void {
    for (const queue of this.queues.values()) {
      for (const session of queue) {
        try {
          this.destroyFn?.(session.sessionId, session.startKey);
        } catch {}
      }
    }
    this.queues.clear();
    this.targetSizeOverride = null;
    this.metrics = {
      hits: 0,
      misses: 0,
      readyCount: 0,
      minHeadroom: 1.0,
      skippedByCpu: 0,
      evictedStale: 0,
      replenished: 0,
    };
  }
}

export const warmPool = new WarmPool();
