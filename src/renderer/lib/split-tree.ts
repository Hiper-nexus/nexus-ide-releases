import type {
  LayoutNode,
  PaneModel,
  SessionKind,
  SplitDirection,
} from '../../shared/types';

/**
 * Pure, immutable operations on the binary layout tree. No React, no side
 * effects — every function returns a fresh tree so the store can swap it in.
 */

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createPane(kind: SessionKind = 'shell', cwd?: string): PaneModel {
  return {
    id: id('pane'),
    kind,
    title: kind === 'shell' ? 'shell' : 'agent',
    cwd,
  };
}

export function createLeaf(pane: PaneModel): LayoutNode {
  return { kind: 'leaf', id: id('leaf'), pane };
}

/** Build the initial single-pane workspace. */
export function initialTree(): LayoutNode {
  return createLeaf(createPane('shell'));
}

/**
 * Split the leaf hosting `paneId` along `direction`, inserting a fresh pane as
 * the second child. Returns a new tree (unchanged if the pane isn't found).
 */
export function splitPane(
  root: LayoutNode,
  paneId: string,
  direction: SplitDirection,
  newPane: PaneModel,
): LayoutNode {
  if (root.kind === 'leaf') {
    if (root.pane.id !== paneId) return root;
    return {
      kind: 'split',
      id: id('split'),
      direction,
      children: [root, createLeaf(newPane)],
    };
  }
  return {
    ...root,
    children: [
      splitPane(root.children[0], paneId, direction, newPane),
      splitPane(root.children[1], paneId, direction, newPane),
    ],
  };
}

/**
 * Remove the leaf hosting `paneId`, collapsing its parent split into the
 * surviving sibling. Returns null if the removed pane was the last one.
 */
export function closePane(root: LayoutNode, paneId: string): LayoutNode | null {
  if (root.kind === 'leaf') {
    return root.pane.id === paneId ? null : root;
  }
  const [a, b] = root.children;
  const left = closePane(a, paneId);
  const right = closePane(b, paneId);

  // A child collapsed to null → promote the sibling in its place.
  if (left === null) return right;
  if (right === null) return left;
  if (left === a && right === b) return root;
  return { ...root, children: [left, right] };
}

/** Depth-first list of every pane in layout order. */
export function listPanes(root: LayoutNode): PaneModel[] {
  if (root.kind === 'leaf') return [root.pane];
  return [...listPanes(root.children[0]), ...listPanes(root.children[1])];
}

export function findPane(root: LayoutNode, paneId: string): PaneModel | null {
  return listPanes(root).find((p) => p.id === paneId) ?? null;
}

/** Update a pane's fields in place (immutably) — used for live titles. */
export function updatePane(
  root: LayoutNode,
  paneId: string,
  patch: Partial<PaneModel>,
): LayoutNode {
  if (root.kind === 'leaf') {
    if (root.pane.id !== paneId) return root;
    return { ...root, pane: { ...root.pane, ...patch } };
  }
  return {
    ...root,
    children: [
      updatePane(root.children[0], paneId, patch),
      updatePane(root.children[1], paneId, patch),
    ],
  };
}
