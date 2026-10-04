import { expect, it, vi } from 'vitest';
import { createSoakUi } from './soak-smoke';
import { isSoakRendererUrl } from '../shared/soak-smoke';
it('only opts in from the Main private marker on the initial packaged app URL', () => {
  expect(isSoakRendererUrl('nexus-app://bundle/index.html?nexusSmokeSoak=1')).toBe(true);
  for (const url of ['nexus-app://bundle/index.html', 'https://example.invalid/index.html?nexusSmokeSoak=1',
    'nexus-app://bundle/other.html?nexusSmokeSoak=1', 'nexus-app://bundle/index.html?nexusSmokeSoak=0']) expect(isSoakRendererUrl(url)).toBe(false);
});
it('only manipulates panes minted by its own UI flight', async () => {
  const remove = vi.fn(), view = vi.fn(async () => ({ frames: 2, renderedMarker: true, scroll: true, resize: true, rendererHosts: 1 }));
  const ui = createSoakUi({ open: async () => 'owned-pane', wait: async () => 'owned-session', close: remove, view });
  await expect(ui.view('foreign-pane', 'marker', 0)).rejects.toThrow();
  await expect(ui.close('foreign-pane')).rejects.toThrow();
  expect(view).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  await expect(ui.open()).resolves.toEqual({ paneId: 'owned-pane', sessionId: 'owned-session' });
  await ui.view('owned-pane', 'marker', 0); await ui.close('owned-pane');
  expect(remove).toHaveBeenCalledExactlyOnceWith('owned-pane');
});
it('removes its exact pane when session acquisition fails', async () => {
  const close = vi.fn(); const ui = createSoakUi({ open: async () => 'owned-pane', wait: async () => null, close, view: vi.fn() });
  await expect(ui.open()).rejects.toThrow(); expect(close).toHaveBeenCalledExactlyOnceWith('owned-pane');
});
