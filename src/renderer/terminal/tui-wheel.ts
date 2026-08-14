/**
 * Wheel → PageUp/PageDown for TUI apps (Grok, Claude, Codex, vim).
 *
 * Alternate screen is the careful TUI signal: shell/log scroll stays on the
 * normal buffer and keeps xterm viewport scrolling.
 */

export const TUI_WHEEL_PAGE_UP = '\x1b[5~';
export const TUI_WHEEL_PAGE_DOWN = '\x1b[6~';
/** One typical mouse-wheel notch; ignores trackpad jitter. */
export const TUI_WHEEL_DELTA_THRESHOLD = 40;

export function isTuiAlternateBuffer(
  bufferType: string | undefined,
): boolean {
  return bufferType === 'alternate';
}

export function tuiWheelPageSequence(input: {
  readonly bufferType: string | undefined;
  readonly deltaY: number;
}): string | null {
  if (!isTuiAlternateBuffer(input.bufferType)) return null;
  if (!Number.isFinite(input.deltaY)) return null;
  if (Math.abs(input.deltaY) < TUI_WHEEL_DELTA_THRESHOLD) return null;
  return input.deltaY < 0 ? TUI_WHEEL_PAGE_UP : TUI_WHEEL_PAGE_DOWN;
}
