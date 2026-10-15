/** Private per-Worker completion fence, readable even while Main is blocked. */
export class AnalysisJobProgress {
  readonly buffer: SharedArrayBuffer;
  readonly #words: BigInt64Array;
  constructor(buffer = new SharedArrayBuffer(40)) {
    if (buffer.byteLength !== 40) throw new Error('invalid analysis progress buffer');
    this.buffer = buffer; this.#words = new BigInt64Array(buffer);
  }
  reset(): void { Atomics.store(this.#words, 0, 0n); Atomics.store(this.#words, 1, 0n); Atomics.store(this.#words, 4, 0n); }
  /** Horário (ms) antes do token: quem lê o token já enxerga o horário do mesmo job. */
  start(token: number): void { Atomics.store(this.#words, 4, BigInt(Date.now())); Atomics.store(this.#words, 0, BigInt(token)); }
  /** Quando o Worker começou este job (ms); 0 se ainda não começou ou se é outro job. */
  startedAt(token: number): number {
    return token > 0 && Atomics.load(this.#words, 0) === BigInt(token) ? Number(Atomics.load(this.#words, 4)) : 0;
  }
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
