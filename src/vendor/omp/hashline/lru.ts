// Vendored from can1357/oh-my-pi@03c48d073 packages/hashline (MIT)
// NexusIDE port note: upstream imports `LRUCache` from the `lru-cache`
// package, which is not a NexusIDE dependency. This file implements the small
// slice of the lru-cache API that snapshots.ts uses: `max` entries,
// `maxSize` + `sizeCalculation` byte budgeting, `get`/`set` recency,
// `delete`, `values`, `clear`. Entries larger than `maxSize` are not stored
// (matching lru-cache semantics).

export interface HashlineLruOptions<V> {
  /** Maximum number of entries retained (LRU eviction beyond it). */
  max: number;
  /** Ceiling on the summed `sizeCalculation` of retained values. */
  maxSize: number;
  /** Size of one value, in whatever unit `maxSize` is expressed in. */
  sizeCalculation: (value: V) => number;
}

/** Minimal LRU keyed map. Iteration order is least- to most-recently used. */
export class HashlineLruCache<K, V> {
  readonly #entries = new Map<K, { value: V; size: number }>();
  readonly #max: number;
  readonly #maxSize: number;
  readonly #sizeCalculation: (value: V) => number;
  #totalSize = 0;

  constructor(options: HashlineLruOptions<V>) {
    if (options.max < 1) throw new Error('HashlineLruCache: max must be >= 1');
    if (options.maxSize < 1) {
      throw new Error('HashlineLruCache: maxSize must be >= 1');
    }
    this.#max = options.max;
    this.#maxSize = options.maxSize;
    this.#sizeCalculation = options.sizeCalculation;
  }

  /** Read a value and refresh its recency. */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    // Re-insert to move the key to the most-recently-used end of the Map.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** Insert or replace a value, evicting least-recently-used overflow. */
  set(key: K, value: V): void {
    const size = this.#sizeCalculation(value);
    this.delete(key);
    if (size > this.#maxSize) return;
    this.#entries.set(key, { value, size });
    this.#totalSize += size;
    this.#evictOverflow();
  }

  delete(key: K): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    this.#totalSize -= entry.size;
    return true;
  }

  *values(): IterableIterator<V> {
    for (const entry of this.#entries.values()) yield entry.value;
  }

  clear(): void {
    this.#entries.clear();
    this.#totalSize = 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  #evictOverflow(): void {
    while (this.#entries.size > this.#max || this.#totalSize > this.#maxSize) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.delete(oldest.value);
    }
  }
}
