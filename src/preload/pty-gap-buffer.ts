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

/** Faixa de sequências coalescida pelo Main: `first`..`last`, um único `data`. */
type PendingRange = { last: number; data: string };

export class PtyGapBuffer {
  /** Contiguous high-water: only advances for delivered sequences. */
  highWater = 0;
  /** Chaveado pela PRIMEIRA sequência da faixa (um chunk simples é first === last). */
  private pending = new Map<number, PendingRange>();
  private pendingChars = 0;

  get pendingCount(): number {
    return this.pending.size;
  }

  get pendingBytes(): number {
    return this.pendingChars;
  }

  /**
   * Feed one chunk, or one coalesced range (`firstSequence`..`sequence` in a
   * single `data`, as the Main's drain sends it). Returns the contiguous run
   * to deliver (empty when the chunk was a duplicate or was buffered behind a
   * hole). A range that overlaps what was already delivered is not delivered:
   * without per-chunk lengths it cannot be sliced, so it is dropped and the
   * recover pull fetches the remainder chunk by chunk.
   */
  push(sequence: number, data: string, firstSequence = sequence): PtyGapPushResult {
    if (sequence <= this.highWater) {
      return { chunks: [], gapHealed: false }; // duplicate / already acked
    }
    if (firstSequence <= this.highWater) {
      return { chunks: [], gapHealed: false }; // partial overlap: recover pulls the rest
    }
    if (firstSequence === this.highWater + 1) {
      const chunks: PtyGapChunk[] = [{ sequence, data }];
      this.highWater = sequence;
      this.flushInto(chunks);
      return { chunks, gapHealed: false };
    }
    // Out-of-order: buffer behind the hole and let the recover pull fill it.
    if (!this.pending.has(firstSequence)) {
      this.pending.set(firstSequence, { last: sequence, data });
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
    for (const [first, range] of this.pending) {
      // Uma faixa que cruza o ponto de retomada também sai: o recover repõe o resto.
      if (first <= this.highWater) {
        this.pending.delete(first);
        this.pendingChars -= range.data.length;
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
    for (let range = this.pending.get(this.highWater + 1); range; range = this.pending.get(this.highWater + 1)) {
      this.pending.delete(this.highWater + 1);
      this.pendingChars -= range.data.length;
      this.highWater = range.last;
      chunks.push({ sequence: range.last, data: range.data });
    }
  }
}
