export const RENDERER_MOUNT_DEADLINE_MS = 20_000;

/**
 * Main-owned deadline for the first renderer commit.
 *
 * The renderer cannot be trusted to answer a DOM probe while its JavaScript
 * thread is blocked. Keeping this timer in Main guarantees that a synchronous
 * React boot hang still reaches recovery. Re-arming invalidates the previous
 * navigation, and cancel() is safe after the callback has already been queued.
 */
export class RendererMountWatchdog {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onDeadline: () => void,
    private readonly deadlineMs = RENDERER_MOUNT_DEADLINE_MS,
  ) {}

  arm(): void {
    this.cancel();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.timer = null;
      this.onDeadline();
    }, this.deadlineMs);
  }

  cancel(): void {
    this.generation += 1;
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
