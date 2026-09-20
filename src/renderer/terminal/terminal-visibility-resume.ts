/**
 * Operations required to reveal a terminal without painting an intermediate
 * renderer/grid state.
 *
 * WebGL attachment can change xterm's character metrics. The renderer must be
 * resumed before fit, and queued PTY bytes must only be submitted after that
 * fit has settled the visible grid.
 */
export interface TerminalVisibilityResumeOperations {
  resumeRenderer(): void;
  /**
   * Measure and apply the visible grid. Returns whether the slot was
   * actually measurable and fitted — the real implementation (fitHostGrid)
   * never throws on failure, it catches its own errors and reports them as
   * `false` (see F-356: a `void`-typed contract here silently discarded that
   * `false` and let propagate/flush/repaint run against the STALE grid).
   */
  fitVisibleGrid(): boolean;
  propagateSize(): void;
  flushOutput(): void;
  repaint(): void;
}

/**
 * Resume a visible terminal in the only safe order:
 * renderer → grid → PTY size → queued output → repaint.
 *
 * A temporarily unmeasurable slot defers output promotion. Its
 * ResizeObserver will retry after layout instead of writing a TUI backlog into
 * the previous grid.
 */
export function resumeTerminalVisibilityBeforePaint(
  operations: TerminalVisibilityResumeOperations,
): boolean {
  try {
    operations.resumeRenderer();
  } catch {
    // GPU reacquisition is best effort; xterm can continue on its DOM renderer.
  }
  let fitted: boolean;
  try {
    fitted = operations.fitVisibleGrid();
  } catch {
    fitted = false;
  }
  if (!fitted) return false;
  try {
    operations.propagateSize();
  } catch {
    // A transient PTY resize failure must not strand an otherwise visible UI.
  }
  operations.flushOutput();
  operations.repaint();
  return true;
}
