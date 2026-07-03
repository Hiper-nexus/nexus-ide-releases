import { describe, expect, it } from 'vitest';
import { closePane, createLeaf, createPane, splitPane, updatePane } from './split-tree';
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
