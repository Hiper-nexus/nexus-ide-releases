/** Fixed-capacity Float32 FIFO for realtime microphone samples. */
export class PcmRingBuffer {
  private readonly samples: Float32Array;
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('PCM ring capacity must be a positive integer');
    }
    this.samples = new Float32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  /** Append samples and return how many oldest samples were discarded. */
  push(input: Float32Array): number {
    if (input.length === 0) return 0;
    if (input.length >= this.capacity) {
      const dropped = this.size + input.length - this.capacity;
      this.samples.set(input.subarray(input.length - this.capacity));
      this.head = 0;
      this.size = this.capacity;
      return dropped;
    }

    const overflow = Math.max(0, this.size + input.length - this.capacity);
    if (overflow > 0) {
      this.head = (this.head + overflow) % this.capacity;
      this.size -= overflow;
    }
    let tail = (this.head + this.size) % this.capacity;
    const first = Math.min(input.length, this.capacity - tail);
    this.samples.set(input.subarray(0, first), tail);
    if (first < input.length) {
      tail = 0;
      this.samples.set(input.subarray(first), tail);
    }
    this.size += input.length;
    return overflow;
  }

  shift(count: number): Float32Array | null {
    if (!Number.isInteger(count) || count <= 0 || this.size < count) return null;
    const output = new Float32Array(count);
    const first = Math.min(count, this.capacity - this.head);
    output.set(this.samples.subarray(this.head, this.head + first));
    if (first < count) output.set(this.samples.subarray(0, count - first), first);
    this.head = (this.head + count) % this.capacity;
    this.size -= count;
    if (this.size === 0) this.head = 0;
    return output;
  }
}
