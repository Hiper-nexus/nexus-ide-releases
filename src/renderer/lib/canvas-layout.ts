import type { CanvasNodeLayout, PaneModel } from '../../shared/types';

/**
 * Canvas layout utilities — pure functions, no side effects.
 *
 * Panes in the canvas default to a 3-column cascade so a fresh switch from
 * grid mode places every terminal in a readable, non-overlapping position.
 */

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 380;
const COLS = 3;
const COL_STRIDE = DEFAULT_WIDTH + 24;
const ROW_STRIDE = DEFAULT_HEIGHT + 24;
const ORIGIN_X = 24;
const ORIGIN_Y = 24;

/** Stable default layout for a pane at a given slot index. */
export function defaultCanvasLayout(index: number): CanvasNodeLayout {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    position: { x: ORIGIN_X + col * COL_STRIDE, y: ORIGIN_Y + row * ROW_STRIDE },
    size: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
    z: index,
  };
}

/**
 * Returns a copy of `existing` with entries added for any pane that does not
 * yet have a canvas layout. Preserves all existing entries unchanged.
 */
export function ensureCanvasLayouts(
  panes: PaneModel[],
  existing: Record<string, CanvasNodeLayout>,
): Record<string, CanvasNodeLayout> {
  const result: Record<string, CanvasNodeLayout> = { ...existing };
  panes.forEach((pane, i) => {
    if (!result[pane.id]) {
      result[pane.id] = defaultCanvasLayout(i);
    }
  });
  return result;
}

/**
 * Removes entries for panes that no longer exist (stale cleanup).
 */
export function pruneCanvasLayouts(
  layouts: Record<string, CanvasNodeLayout>,
  livePaneIds: ReadonlySet<string>,
): Record<string, CanvasNodeLayout> {
  const result: Record<string, CanvasNodeLayout> = {};
  for (const [id, layout] of Object.entries(layouts)) {
    if (livePaneIds.has(id)) result[id] = layout;
  }
  return result;
}
