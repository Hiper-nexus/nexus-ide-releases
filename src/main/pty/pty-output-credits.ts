/** Host-side credits constrain queued terminal data; control messages bypass it. */
export const PTY_OUTPUT_CREDIT_BYTES = 192 * 1024;
export class PtyOutputCredits {
  #available: number; #parts: string[] = []; #bytes = 0; #paused = false;
  constructor(private readonly deps: { send: (part: string) => void; pause: () => void; resume: () => void }, private readonly capacity = PTY_OUTPUT_CREDIT_BYTES) { this.#available = capacity; }
  push(data: string) { this.#parts.push(data); this.#bytes += Buffer.byteLength(data); this.#drain(); }
  grant(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.#available = Math.min(this.capacity, this.#available + bytes); this.#drain();
  }
  pendingBytes() { return this.#bytes; }
  #drain() {
    while (this.#parts.length && this.#available > 0) {
      const part = this.#parts[0];
      let end = Math.min(part.length, 21_845, this.#available);
      while (end > 0 && Buffer.byteLength(part.slice(0, end)) > this.#available) end = Math.floor(end / 2);
      if (end > 0 && end < part.length && part.charCodeAt(end - 1) >= 0xd800 && part.charCodeAt(end - 1) <= 0xdbff) end--;
      if (!end) break;
      const text = part.slice(0, end); const bytes = Buffer.byteLength(text);
      if (end === part.length) this.#parts.shift(); else this.#parts[0] = part.slice(end);
      this.#bytes -= bytes; this.#available -= bytes; this.deps.send(text);
    }
    if ((this.#bytes > 0 || this.#available === 0) && !this.#paused) { this.#paused = true; this.deps.pause(); }
    else if (this.#bytes === 0 && this.#available >= this.capacity / 2 && this.#paused) { this.#paused = false; this.deps.resume(); }
  }
  /** Final already-read bytes precede exit. Never wait for analysis to prove death.
   * Normal credits reserve 64 KiB for this last native read below Main's bound. */
  seal(exit: () => void) { for (const part of this.#parts) this.deps.send(part); this.#parts = []; this.#bytes = 0; exit(); }
}
