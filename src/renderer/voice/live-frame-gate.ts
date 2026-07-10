/**
 * Holds a short local pre-roll until the capture has evidence of real speech.
 * This prevents a Live socket from receiving seconds of room noise while the
 * user decides whether to speak, without clipping the first syllable.
 */
export class LiveFrameGate {
  private buffered: Float32Array[] = [];
  private bufferedSamples = 0;
  private open = false;

  constructor(private readonly maxBufferedSamples: number) {}

  isOpen(): boolean {
    return this.open;
  }

  reset(): void {
    this.buffered = [];
    this.bufferedSamples = 0;
    this.open = false;
  }

  offer(frame: Float32Array, hasSpeech: boolean): Float32Array[] {
    if (this.open) return [frame];

    const copy = Float32Array.from(frame);
    this.buffered.push(copy);
    this.bufferedSamples += copy.length;

    if (!hasSpeech) {
      this.trim();
      return [];
    }

    this.open = true;
    const pending = this.buffered;
    this.buffered = [];
    this.bufferedSamples = 0;
    return pending;
  }

  private trim(): void {
    while (this.bufferedSamples > this.maxBufferedSamples && this.buffered.length > 1) {
      const removed = this.buffered.shift();
      this.bufferedSamples -= removed?.length ?? 0;
    }
  }
}
