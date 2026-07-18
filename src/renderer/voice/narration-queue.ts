const DEFAULT_MAX_PENDING = 12;
const MAX_NARRATION_CHARS = 2_000;

export interface NarrationQueueOptions {
  canPlay(): boolean;
  play(text: string): Promise<void>;
  onError?(error: unknown): void;
  maxPending?: number;
}

/** Serial report-back queue: busy voice turns defer narration instead of losing it. */
export class NarrationQueue {
  private pending: string[] = [];
  private activeText: string | null = null;
  private draining = false;
  private disposed = false;
  private readonly maxPending: number;

  constructor(private readonly options: NarrationQueueOptions) {
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
  }

  enqueue(rawText: string): void {
    if (this.disposed) return;
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, MAX_NARRATION_CHARS);
    if (!text || this.activeText === text || this.pending.includes(text)) return;
    if (this.pending.length >= this.maxPending) this.pending.shift();
    this.pending.push(text);
    this.kick();
  }

  kick(): void {
    if (this.disposed || this.draining || !this.options.canPlay()) return;
    this.draining = true;
    void this.drain();
  }

  clear(): void {
    this.pending = [];
    this.activeText = null;
  }

  /**
   * Drop pending work and make the active drain exit ASAP. Callers must also
   * stop playback; this only prevents further queue items from speaking.
   */
  halt(): void {
    this.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  get size(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.disposed && this.pending.length > 0 && this.options.canPlay()) {
        const text = this.pending.shift()!;
        this.activeText = text;
        try {
          await this.options.play(text);
        } catch (error) {
          this.options.onError?.(error);
        } finally {
          this.activeText = null;
        }
      }
    } finally {
      this.draining = false;
      if (!this.disposed && this.pending.length > 0 && this.options.canPlay()) {
        this.kick();
      }
    }
  }
}
