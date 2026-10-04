/** Private per-Worker completion fence, readable even while Main is blocked. */
export class AnalysisJobProgress {
  readonly buffer: SharedArrayBuffer;
  readonly #words: BigInt64Array;
  constructor(buffer = new SharedArrayBuffer(32)) {
    if (buffer.byteLength !== 32) throw new Error('invalid analysis progress buffer');
    this.buffer = buffer; this.#words = new BigInt64Array(buffer);
  }
  reset(): void { Atomics.store(this.#words, 0, 0n); Atomics.store(this.#words, 1, 0n); }
  start(token: number): void { Atomics.store(this.#words, 0, BigInt(token)); }
  complete(token: number): void { Atomics.store(this.#words, 1, BigInt(token)); }
  completed(token: number): boolean {
    return token > 0 && Atomics.load(this.#words, 0) === BigInt(token) && Atomics.load(this.#words, 1) === BigInt(token);
  }
  startActivity(token: number): void { Atomics.store(this.#words, 2, BigInt(token)); }
  completeActivity(token: number): void { Atomics.store(this.#words, 3, BigInt(token)); }
  completedActivity(token: number): boolean {
    // Evaluations are sequential in this Worker. A later completed evaluation
    // also proves an earlier one ended while Main's messages were queued.
    return token > 0 && Atomics.load(this.#words, 2) >= BigInt(token) && Atomics.load(this.#words, 3) >= BigInt(token);
  }
}
