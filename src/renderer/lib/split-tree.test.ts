import { describe, expect, it } from 'vitest';
import {
  buildGridTree,
  closePane,
  createLeaf,
  createPane,
  listPanes,
  paneSlotOf,
  splitPane,
  updatePane,
} from './split-tree';
import type { LayoutNode } from '../../shared/types';

/**
 * Pure-tree unit tests. No Electron, DOM, or React — split-tree is the one piece
 * of layout logic that must never regress, so it is covered in isolation.
 */

function leafOf(node: LayoutNode, index: 0 | 1): LayoutNode {
  if (node.kind !== 'split') throw new Error('expected split node');
  return node.children[index];
}

describe('split-tree', () => {
  it('splits a leaf into a two-child split, preserving the original pane', () => {
    const original = createLeaf(createPane('shell'));
    const target = original.kind === 'leaf' ? original.pane.id : '';
    const newPane = createPane('shell');

    const next = splitPane(original, target, 'row', newPane);

    expect(next.kind).toBe('split');
    expect(leafOf(next, 0)).toBe(original); // left child is the untouched original leaf
    const right = leafOf(next, 1);
    expect(right.kind === 'leaf' && right.pane.id).toBe(newPane.id);
  });

  it('closes the right child, collapsing into the left sibling', () => {
    const left = createLeaf(createPane('shell'));
    const right = createLeaf(createPane('shell'));
    const root: LayoutNode = { kind: 'split', id: 'split-1', direction: 'row', children: [left, right] };

    const rightId = right.kind === 'leaf' ? right.pane.id : '';
    expect(closePane(root, rightId)).toBe(left);
  });

  it('closes the left child, collapsing into the right sibling', () => {
    const left = createLeaf(createPane('shell'));
    const right = createLeaf(createPane('shell'));
    const root: LayoutNode = { kind: 'split', id: 'split-1', direction: 'row', children: [left, right] };

    const leftId = left.kind === 'leaf' ? left.pane.id : '';
    expect(closePane(root, leftId)).toBe(right);
  });

  it('returns null when the last remaining pane is closed', () => {
    const only = createLeaf(createPane('shell'));
    const id = only.kind === 'leaf' ? only.pane.id : '';
    expect(closePane(only, id)).toBeNull();
  });

  it('closes exactly one leaf in a 3-pane tree (sibling intact)', () => {
    const a = createPane('shell');
    const b = createPane('cli-agent', undefined, 'codex');
    const c = createPane('cli-agent', undefined, 'claude');
    const root = buildGridTree([a, b, c]);
    expect(listPanes(root)).toHaveLength(3);
    const next = closePane(root, b.id);
    expect(next).not.toBeNull();
    const remaining = listPanes(next!);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((p) => p.id).sort()).toEqual([a.id, c.id].sort());
  });

  it('leaves the tree unchanged (same reference) for an unknown pane id', () => {
    const left = createLeaf(createPane('shell'));
    const right = createLeaf(createPane('shell'));
    const root: LayoutNode = { kind: 'split', id: 'split-1', direction: 'row', children: [left, right] };

    expect(closePane(root, 'pane-does-not-exist')).toBe(root);
  });

  it('updatePane returns a new tree without mutating the original', () => {
    const leaf = createLeaf(createPane('shell'));
    const paneId = leaf.kind === 'leaf' ? leaf.pane.id : '';
    const originalTitle = leaf.kind === 'leaf' ? leaf.pane.title : '';

    const next = updatePane(leaf, paneId, { title: 'renamed' });

    expect(next).not.toBe(leaf); // fresh node
    expect(next.kind === 'leaf' && next.pane.title).toBe('renamed');
    expect(leaf.kind === 'leaf' && leaf.pane.title).toBe(originalTitle); // original untouched
  });
});

// SLOT ≠ NOME: o slot é a POSIÇÃO no layout visível (o que o ⌘1-9 foca) e
// muda quando o layout muda; o nome durável do pane nunca. Os dois nunca
// dividem namespace — o indicador de slot existe para o operador saber qual
// tecla foca o pane SEM confundir com o nome que ele dita.
describe('paneSlotOf (posição ⌘1-9)', () => {
  it('segue exatamente a ordem do listPanes, 1-based', () => {
    const panes = [createPane('shell'), createPane('shell'), createPane('shell')];
    const tree = buildGridTree(panes);
    const ordered = listPanes(tree);
    expect(paneSlotOf(tree, ordered[0]!.id)).toBe(1);
    expect(paneSlotOf(tree, ordered[2]!.id)).toBe(3);
  });

  it('reflete o layout novo quando um pane fecha (posição, não identidade)', () => {
    const panes = [createPane('shell'), createPane('shell'), createPane('shell')];
    const tree = buildGridTree(panes);
    const ordered = listPanes(tree);
    const closed = closePane(tree, ordered[0]!.id)!;
    expect(paneSlotOf(closed, ordered[1]!.id)).toBe(1);
  });

  it('null para pane desconhecido e para posições fora do alcance 1-9', () => {
    const many = Array.from({ length: 11 }, () => createPane('shell'));
    const tree = buildGridTree(many);
    const ordered = listPanes(tree);
    expect(paneSlotOf(tree, 'pane-fantasma')).toBeNull();
    expect(paneSlotOf(tree, ordered[9]!.id)).toBeNull();
    expect(paneSlotOf(tree, ordered[8]!.id)).toBe(9);
  });
});

describe('buildGridTree (Modo Livre)', () => {
  it('builds EXACTLY N leaves for N panes', () => {
    for (const n of [1, 2, 3, 4, 6]) {
      const panes = Array.from({ length: n }, () => createPane('shell'));
      const tree = buildGridTree(panes);
      expect(listPanes(tree)).toHaveLength(n);
    }
  });

  it('preserves each pane identity and order', () => {
    const panes = [
      createPane('cli-agent', undefined, 'claude', 'm'),
      createPane('shell'),
      createPane('cli-agent', undefined, 'codex', 'm'),
    ];
    const ids = listPanes(buildGridTree(panes)).map((p) => p.id);
    expect(ids).toEqual(panes.map((p) => p.id));
  });

  it('alternates split direction by depth for a grid feel', () => {
    const tree = buildGridTree(
      Array.from({ length: 4 }, () => createPane('shell')),
    );
    expect(tree.kind).toBe('split');
    if (tree.kind === 'split') {
      expect(tree.direction).toBe('row');
      expect(tree.children[0].kind).toBe('split');
      if (tree.children[0].kind === 'split') {
        expect(tree.children[0].direction).toBe('column');
      }
    }
  });

  it('never produces an empty tree', () => {
    expect(listPanes(buildGridTree([])).length).toBe(1);
  });
});
