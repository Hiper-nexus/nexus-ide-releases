import { beforeEach, describe, expect, it } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { defaultCanvasLayout } from '../lib/canvas-layout';
import { buildGridTree } from '../lib/split-tree';
import { useLayoutStore } from './layout-store';

const basePane: PaneModel = {
  id: 'pane-a',
  kind: 'shell',
  title: 'Terminal',
};

describe('layout-store canvas placement', () => {
  beforeEach(() => {
    const root = buildGridTree([basePane]);
    useLayoutStore.setState({
      root,
      focusedPaneId: basePane.id,
      hydrated: true,
      viewKind: 'canvas',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('places a new terminal beside the focused pane even when its canvas layout is missing', () => {
    const paneId = useLayoutStore.getState().addShellPane();
    const layouts = useLayoutStore.getState().canvasNodeLayouts;
    const focusedLayout = defaultCanvasLayout(0);

    expect(layouts[basePane.id]).toEqual(focusedLayout);
    expect(layouts[paneId].position).toEqual({
      x: focusedLayout.position.x + focusedLayout.size.width + 24,
      y: focusedLayout.position.y,
    });
    expect(layouts[paneId].size).toEqual(focusedLayout.size);
  });
});
