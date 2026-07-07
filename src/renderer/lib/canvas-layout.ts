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
const SIBLING_GAP = 24;

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

function maxZ(layouts: Record<string, CanvasNodeLayout>): number {
  return Math.max(-1, ...Object.values(layouts).map((layout) => layout.z ?? 0));
}

function overlaps(
  candidate: CanvasNodeLayout,
  existing: CanvasNodeLayout,
): boolean {
  const a = {
    left: candidate.position.x,
    right: candidate.position.x + candidate.size.width,
    top: candidate.position.y,
    bottom: candidate.position.y + candidate.size.height,
  };
  const b = {
    left: existing.position.x,
    right: existing.position.x + existing.size.width,
    top: existing.position.y,
    bottom: existing.position.y + existing.size.height,
  };
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * New panes opened while the user is already in canvas mode should feel like a
 * deliberate split: place them beside the focused pane, not in a far cascade.
 */
export function nextCanvasLayout(
  layouts: Record<string, CanvasNodeLayout>,
  pivotPaneId: string | null,
  fallbackIndex: number,
): CanvasNodeLayout {
  const z = maxZ(layouts) + 1;
  const pivot = pivotPaneId ? layouts[pivotPaneId] : null;
  if (!pivot) return { ...defaultCanvasLayout(fallbackIndex), z };

  const candidate: CanvasNodeLayout = {
    position: {
      x: pivot.position.x + pivot.size.width + SIBLING_GAP,
      y: pivot.position.y,
    },
    size: { ...pivot.size },
    z,
  };
  const stride = pivot.size.width + SIBLING_GAP;
  const occupied = Object.entries(layouts).filter(([id]) => id !== pivotPaneId);
  while (occupied.some(([, layout]) => overlaps(candidate, layout))) {
    candidate.position.x += stride;
  }
  return candidate;
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
