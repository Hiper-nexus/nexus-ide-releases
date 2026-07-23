export class AsyncOperationCapacityError extends Error {
  readonly code = 'operation_busy';

  constructor(message = 'limite global de operações assíncronas atingido') {
    super(message);
    this.name = 'AsyncOperationCapacityError';
  }
}

export interface BoundedAsyncOperationPoolOptions {
  readonly maxConcurrent: number;
  readonly maxCacheEntries: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}

interface CacheEntry<T> {
  readonly completedAt: number;
  readonly value: T;
}

/**
 * Same-key single-flight plus a process-wide concurrency ceiling and bounded
 * LRU/TTL result cache. Rejections are never cached.
 */
export class BoundedAsyncOperationPool<T> {
  readonly #maxConcurrent: number;
  readonly #maxCacheEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #flights = new Map<string, Promise<T>>();
  readonly #cache = new Map<string, CacheEntry<T>>();

  constructor(options: BoundedAsyncOperationPoolOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }
    if (!Number.isInteger(options.maxCacheEntries) || options.maxCacheEntries < 0) {
      throw new Error('maxCacheEntries must be a non-negative integer');
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new Error('ttlMs must be non-negative');
    }
    this.#maxConcurrent = options.maxConcurrent;
    this.#maxCacheEntries = options.maxCacheEntries;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  run(key: string, task: () => Promise<T>): Promise<T> {
    this.#pruneExpired();
    const cached = this.#cache.get(key);
    if (cached) {
      // A successful hit becomes the most-recently-used entry without
      // extending its absolute TTL.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return Promise.resolve(cached.value);
    }

    const existing = this.#flights.get(key);
    if (existing) return existing;
    if (this.#flights.size >= this.#maxConcurrent) {
      return Promise.reject(new AsyncOperationCapacityError());
    }

    const flight = Promise.resolve()
      .then(task)
      .then((value) => {
        this.#remember(key, value);
        return value;
      })
      .finally(() => {
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
      });
    this.#flights.set(key, flight);
    return flight;
  }

  #pruneExpired(): void {
    if (this.#ttlMs === 0 || this.#maxCacheEntries === 0) {
      this.#cache.clear();
      return;
    }
    const cutoff = this.#now() - this.#ttlMs;
    for (const [key, entry] of this.#cache) {
      if (entry.completedAt <= cutoff) this.#cache.delete(key);
    }
  }

  #remember(key: string, value: T): void {
    if (this.#maxCacheEntries === 0 || this.#ttlMs === 0) return;
    this.#cache.delete(key);
    this.#cache.set(key, { completedAt: this.#now(), value });
    while (this.#cache.size > this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
