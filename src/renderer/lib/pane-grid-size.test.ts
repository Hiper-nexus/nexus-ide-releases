import { expect, it } from 'vitest';
import { minimumPaneGridSize } from './pane-grid-size';
import { createLeaf, createPane, splitPane } from './split-tree';
it('reserves physical space for close controls through nested horizontal splits', () => {
  const first = createPane();
  const root = splitPane(createLeaf(first), first.id, 'row', createPane());
  expect(minimumPaneGridSize(root)).toEqual({ width: 200, height: 64 });
});

it('preserves a close target in deeply nested restored layouts', () => {
  let pane = createPane();
  let root = createLeaf(pane);
  for (let i = 1; i < 16; i += 1) {
    const next = createPane();
    root = splitPane(root, pane.id, 'row', next);
    pane = next;
  }
  expect(minimumPaneGridSize(root)).toEqual({ width: 1656, height: 64 });
});
