import { claimPaneNumber } from './pane-numbers';
import type {
  LayoutNode,
  PaneKind,
  PaneModel,
  SplitDirection,
} from '../../shared/types';

/**
 * Pure, immutable operations on the binary layout tree. No React, no side
 * effects — every function returns a fresh tree so the store can swap it in.
 */

// The caps live in shared/ so the main-process scheduler derives its pane
// budget from the same renderer limit this tree enforces.
export {
  MAX_LIVE_PANES_HARD,
  MAX_LIVE_PANES_SOFT,
} from '../../shared/pane-limits';

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createPane(
  kind: PaneKind = 'shell',
  cwd?: string,
  adapterId?: string,
  model?: string,
): PaneModel {
  const title =
    kind === 'cli-agent' && adapterId
      ? adapterId
      : kind === 'browser'
        ? 'browser'
        : 'shell';
  const paneId = id('pane');
  // Nome durável atribuído no nascimento — é o que o operador vai falar.
  return {
    id: paneId,
    kind,
    title,
    paneNumber: claimPaneNumber(paneId),
    cwd,
    adapterId,
    model,
  };
}

export function createLeaf(pane: PaneModel): LayoutNode {
  return { kind: 'leaf', id: id('leaf'), pane };
}

/** Build the initial single-pane workspace. */
export function initialTree(): LayoutNode {
  return createLeaf({
    ...createPane('shell'),
    isStructuralPlaceholder: true,
  });
}

/**
 * The marker lives here (initialTree mints it; claimStructuralPlaceholder
 * clears it). A fresh workspace owns exactly one such shell until the first
 * real surface mounts — presentation paths replace it instead of splitting
 * beside it, and this predicate is the single source of that identity.
 */
export function isStructuralPlaceholderPane(pane: PaneModel): boolean {
  return pane.kind === 'shell' && pane.isStructuralPlaceholder === true;
}

/**
 * Lay out N panes as a balanced grid (recursively bisecting the list,
 * alternating row/column by depth). Guarantees EXACTLY `panes.length` leaves —
 * used by Modo Livre so "2 panes" reliably opens two, "4 panes" a 2×2, etc.
 */
export function buildGridTree(panes: PaneModel[], depth = 0): LayoutNode {
  if (panes.length === 0) return createLeaf(createPane('shell'));
  if (panes.length === 1) return createLeaf(panes[0]);
  const mid = Math.ceil(panes.length / 2);
  const direction: SplitDirection = depth % 2 === 0 ? 'row' : 'column';
  return {
    kind: 'split',
    id: id('split'),
    direction,
    children: [
      buildGridTree(panes.slice(0, mid), depth + 1),
      buildGridTree(panes.slice(mid), depth + 1),
    ],
  };
}

/**
 * Onde um pane spawnado pela ORQUESTRAÇÃO deve nascer: no maior leaf, cortado
 * no eixo mais comprido. Sem isso cada worker fatiava o pane focado em 'row'
 * e um squad de 6 virava uma tira de colunas ilegíveis.
 */
export function pickBalancedTarget(
  root: LayoutNode,
): { paneId: string; direction: SplitDirection } {
  let best: { paneId: string; direction: SplitDirection; area: number } = {
    paneId: '',
    direction: 'row',
    area: -1,
  };
  const walk = (node: LayoutNode, w: number, h: number): void => {
    if (node.kind === 'leaf') {
      const area = w * h;
      if (area > best.area) {
        best = {
          paneId: node.pane.id,
          direction: w >= h ? 'row' : 'column',
          area,
        };
      }
      return;
    }
    const [a, b] = node.children;
    if (node.direction === 'row') {
      walk(a, w / 2, h);
      walk(b, w / 2, h);
    } else {
      walk(a, w, h / 2);
      walk(b, w, h / 2);
    }
  };
  // Proporção típica da área de panes — o desempate direcional considera a
  // tela larga.
  walk(root, 16, 9);
  return { paneId: best.paneId, direction: best.direction };
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
    const next: PaneModel = { ...root.pane, ...patch };
    // Explicit undefined must clear optional keys (e.g. spent orchRequestId).
    for (const key of Object.keys(patch) as (keyof PaneModel)[]) {
      if (patch[key] === undefined) {
        delete next[key];
      }
    }
    return { ...root, pane: next };
  }
  return {
    ...root,
    children: [
      updatePane(root.children[0], paneId, patch),
      updatePane(root.children[1], paneId, patch),
    ],
  };
}
