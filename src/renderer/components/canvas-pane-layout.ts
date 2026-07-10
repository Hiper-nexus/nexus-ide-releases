/** A terminal below this footprint stops being a useful operating surface. */
export const MIN_CANVAS_PANE_WIDTH = 440;
export const MIN_CANVAS_PANE_HEIGHT = 300;

export function ensureReadableCanvasSize(size: {
  width: number;
  height: number;
}): { width: number; height: number } {
  return {
    width: Math.max(MIN_CANVAS_PANE_WIDTH, size.width),
    height: Math.max(MIN_CANVAS_PANE_HEIGHT, size.height),
  };
}
