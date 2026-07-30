/**
 * Bounded PTY gap-recovery buffer (preload side).
 *
 * PTY chunks must reach the terminal in contiguous sequence order. Reordered
 * chunks are buffered until the hole fills (via a `pty:recover` pull), but the
 * buffer is CAPPED: once the gap grows past the budget it is not healing —
 * typically because main's ~1 MB replay window evicted the missing sequence —
 * and buffering forever only grows the preload/renderer heap while every new
 * chunk spawns another recover invoke. Instead the hole is accepted: the
 * high-water mark jumps to the oldest available sequence and delivery resumes.
 *
 * Pure state machine with no Electron imports so it stays unit-testable; the
 * preload wires emissions, acks, recover invokes and the notice.
 */

/** Mirrors the scheduler's 2 MB background queue, with headroom for bursts. */
export const PTY_PENDING_MAX_CHARS = 4 * 1024 * 1024;
/** Count bound so many tiny chunks cannot pin the map either. */
export const PTY_PENDING_MAX_CHUNKS = 2048;

/**
 * Injected into the terminal stream when a hole is accepted. Mirrors the
 * scheduler's BACKGROUND_BACKLOG_WARNING pattern: CAN aborts a partial escape
 * sequence, style resets, one-line notice.
 */
export const PTY_GAP_NOTICE =
  '\x18\x1b[0m\r\n[Nexus skipped terminal output that could not be recovered.]\r\n';

export type PtyGapChunk = { sequence: number; data: string };

export type PtyGapPushResult = {
  /** In-order chunks to deliver (and ack), contiguous from the high-water mark. */
  chunks: PtyGapChunk[];
  /** True when an unrecoverable hole was accepted — surface PTY_GAP_NOTICE. */
  gapHealed: boolean;
};

export class PtyGapBuffer {
  /** Contiguous high-water: only advances for delivered sequences. */
  highWater = 0;
  private pending = new Map<number, string>();
  private pendingChars = 0;

  get pendingCount(): number {
    return this.pending.size;
  }

  get pendingBytes(): number {
    return this.pendingChars;
  }

  /**
   * Feed one chunk. Returns the contiguous run to deliver (empty when the
   * chunk was a duplicate or was buffered behind a hole).
   */
  push(sequence: number, data: string): PtyGapPushResult {
    if (sequence <= this.highWater) {
      return { chunks: [], gapHealed: false }; // duplicate / already acked
    }
    if (sequence === this.highWater + 1) {
      const chunks: PtyGapChunk[] = [{ sequence, data }];
      this.highWater = sequence;
      this.flushInto(chunks);
      return { chunks, gapHealed: false };
    }
    // Out-of-order: buffer behind the hole and let the recover pull fill it.
    if (!this.pending.has(sequence)) {
      this.pending.set(sequence, data);
      this.pendingChars += data.length;
    }
    if (
      this.pending.size > PTY_PENDING_MAX_CHUNKS ||
      this.pendingChars > PTY_PENDING_MAX_CHARS
    ) {
      // The gap blew past the budget instead of healing — accept the hole
      // rather than buffering (and recovering) forever.
      return { chunks: this.acceptHole(this.oldestPending()), gapHealed: true };
    }
    return { chunks: [], gapHealed: false };
  }

  /**
   * Jump the high-water mark to just below `resumeSequence`, dropping anything
   * buffered at or below it, then flush the contiguous run. Used both by the
   * cap above and when a recover response starts past the expected sequence
   * (proof the hole was evicted from main's replay window).
   */
  acceptHole(resumeSequence: number): PtyGapChunk[] {
    if (resumeSequence <= this.highWater + 1) return [];
    this.highWater = resumeSequence - 1;
    for (const [sequence, chunk] of this.pending) {
      if (sequence <= this.highWater) {
        this.pending.delete(sequence);
        this.pendingChars -= chunk.length;
      }
    }
    const chunks: PtyGapChunk[] = [];
    this.flushInto(chunks);
    return chunks;
  }

  private oldestPending(): number {
    let oldest = Number.POSITIVE_INFINITY;
    for (const sequence of this.pending.keys()) {
      if (sequence < oldest) oldest = sequence;
    }
    return oldest;
  }

  private flushInto(chunks: PtyGapChunk[]): void {
    let next = this.highWater + 1;
    while (this.pending.has(next)) {
      const data = this.pending.get(next)!;
      this.pending.delete(next);
      this.pendingChars -= data.length;
      this.highWater = next;
      chunks.push({ sequence: next, data });
      next += 1;
    }
  }
}
