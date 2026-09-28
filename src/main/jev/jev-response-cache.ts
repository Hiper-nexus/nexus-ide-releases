/** One bounded recent state per live owner; owner teardown releases the cache. */
export class JevResponseCache<T> {
  readonly #entries = new WeakMap<object, { key: string; promise: Promise<T>; expiresAt: number; pending: boolean }>();

  constructor(private readonly ttlMs = 15_000, private readonly now = () => performance.now()) {}

  async get(owner: object, key: string, compute: () => Promise<T>, usable: (value: T) => boolean): Promise<{ value: T; reused: boolean }> {
    const prior = this.#entries.get(owner);
    if (prior?.key === key && (prior.pending || prior.expiresAt > this.now())) {
      return { value: await prior.promise, reused: true };
    }
    const entry = { key, promise: Promise.resolve().then(compute), expiresAt: 0, pending: true };
    this.#entries.set(owner, entry);
    try {
      const value = await entry.promise;
      entry.pending = false;
      if (usable(value)) entry.expiresAt = this.now() + this.ttlMs;
      else if (this.#entries.get(owner) === entry) this.#entries.delete(owner);
      return { value, reused: false };
    } catch (error) {
      if (this.#entries.get(owner) === entry) this.#entries.delete(owner);
      throw error;
    }
  }
}
