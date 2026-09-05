import type { LayoutNode } from '../../shared/types';

const MIN_PANE_WIDTH = 96;
const MIN_PANE_HEIGHT = 64;
const SEPARATOR_SIZE = 8;

/** Nested percentage splits must not shrink close controls under separators. */
export function minimumPaneGridSize(node: LayoutNode): { width: number; height: number } {
  if (node.kind === 'leaf') return { width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT };
  const a = minimumPaneGridSize(node.children[0]);
  const b = minimumPaneGridSize(node.children[1]);
  return node.direction === 'row'
    ? { width: a.width + b.width + SEPARATOR_SIZE, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height + SEPARATOR_SIZE };
}
