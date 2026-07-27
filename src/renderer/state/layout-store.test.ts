import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { defaultCanvasLayout } from '../lib/canvas-layout';
import { buildGridTree, listPanes } from '../lib/split-tree';
import { switchWorkspaceLayout, useLayoutStore } from './layout-store';

const basePane: PaneModel = {
  id: 'pane-a',
  kind: 'shell',
  title: 'Terminal',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('layout-store pane maximize', () => {
  beforeEach(() => {
    const panes: PaneModel[] = [
      { id: 'pane-a', kind: 'shell', title: 'A' },
      { id: 'pane-b', kind: 'shell', title: 'B' },
    ];
    useLayoutStore.setState({
      root: buildGridTree(panes),
      focusedPaneId: 'pane-a',
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('toggles one maximized pane without removing the others', () => {
    const beforeIds = listPanes(useLayoutStore.getState().root).map((pane) => pane.id);

    useLayoutStore.getState().toggleMaximizePane('pane-b');

    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-b');
    expect(useLayoutStore.getState().maximizedPaneId).toBe('pane-b');
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual(beforeIds);

    useLayoutStore.getState().toggleMaximizePane('pane-b');

    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual(beforeIds);
  });

  it('clears maximized state when that pane closes', () => {
    useLayoutStore.getState().toggleMaximizePane('pane-b');

    useLayoutStore.getState().close('pane-b', 'test');

    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual(['pane-a']);
  });
});

describe('layout-store workspace load failure', () => {
  it('detaches persistence so outgoing panes cannot be saved under the failed target', async () => {
    const save = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      nexus: {
        layout: {
          load: vi.fn(async () => {
            throw new Error('layout unavailable');
          }),
          save,
          saveSync: vi.fn(),
        },
      },
    });

    await expect(
      switchWorkspaceLayout('/workspace/unavailable'),
    ).rejects.toThrow('layout unavailable');

    useLayoutStore.getState().addShellPane();
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(save).not.toHaveBeenCalled();
  });
});
