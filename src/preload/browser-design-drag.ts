/**
 * Geometric reorder math for design-mode drag (VISUAL-EDIT-001, F3 — o "stub
 * geométrico" do blueprint Onlook, simples de propósito: flex/grid de fluxo
 * único primeiro; layouts 2D complexos ficam com o agente). Pure functions so
 * the drop target is testable without a DOM.
 */

export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FlowAxis = 'x' | 'y';

/** Single-flow heuristic: whichever axis spreads the siblings more. */
export function detectFlowAxis(rects: FlowRect[]): FlowAxis {
  if (rects.length < 2) return 'y';
  const xs = rects.map((rect) => rect.x + rect.width / 2);
  const ys = rects.map((rect) => rect.y + rect.height / 2);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  return spreadX > spreadY ? 'x' : 'y';
}

/** Insertion slot (0..n): how many sibling midpoints sit before the pointer. */
export function dropInsertionIndex(
  rects: FlowRect[],
  pointer: { x: number; y: number },
  axis: FlowAxis,
): number {
  let index = 0;
  for (const rect of rects) {
    const midpoint =
      axis === 'x' ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
    if ((axis === 'x' ? pointer.x : pointer.y) > midpoint) index += 1;
  }
  return index;
}

/** Convert an insertion slot into the splice target index used by reorder. */
export function insertionToReorderIndex(
  fromIndex: number,
  insertionIndex: number,
): number {
  return insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
}
