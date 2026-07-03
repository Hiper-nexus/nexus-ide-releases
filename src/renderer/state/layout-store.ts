import { create } from 'zustand';
import type {
  LayoutNode,
  PaneModel,
  SplitDirection,
  WorkspaceLayout,
} from '../../shared/types';
import {
  closePane,
  createPane,
  initialTree,
  listPanes,
  splitPane,
  updatePane,
} from '../lib/split-tree';

/**
 * The single source of truth for the pane grid. Holds the layout tree and the
 * focused pane, exposes immutable mutations, and persists to the main process
 * (debounced) on every structural change.
 */

interface LayoutState {
  root: LayoutNode;
  focusedPaneId: string | null;
  hydrated: boolean;

  split(paneId: string, direction: SplitDirection): void;
  close(paneId: string): void;
  focus(paneId: string): void;
  setTitle(paneId: string, title: string): void;
  hydrate(layout: WorkspaceLayout | null): void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist(state: Pick<LayoutState, 'root' | 'focusedPaneId'>): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void window.nexus.layout.save({
      root: state.root,
      focusedPaneId: state.focusedPaneId,
    });
  }, 300);
}

/**
 * Synchronously persist the current layout, bypassing the debounce. Called on
 * `beforeunload` so a structural change made <300ms before the window closes is
 * never lost when the debounced timer dies with the renderer.
 */
export function flushLayout(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const { root, focusedPaneId } = useLayoutStore.getState();
  void window.nexus.layout.save({ root, focusedPaneId });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushLayout);
}

function firstPaneId(root: LayoutNode): string | null {
  const panes = listPanes(root);
  return panes.length > 0 ? panes[0].id : null;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  root: initialTree(),
  focusedPaneId: null,
  hydrated: false,

  split: (paneId, direction) => {
    const newPane: PaneModel = createPane('shell');
    const root = splitPane(get().root, paneId, direction, newPane);
    set({ root, focusedPaneId: newPane.id });
    persist({ root, focusedPaneId: newPane.id });
  },

  close: (paneId) => {
    const next = closePane(get().root, paneId);
    // Never allow an empty workspace — reseed with a fresh pane.
    const root = next ?? initialTree();
    const focusedPaneId =
      get().focusedPaneId === paneId ? firstPaneId(root) : get().focusedPaneId;
    set({ root, focusedPaneId });
    persist({ root, focusedPaneId });
  },

  focus: (paneId) => {
    if (get().focusedPaneId === paneId) return;
    set({ focusedPaneId: paneId });
    persist({ root: get().root, focusedPaneId: paneId });
  },

  setTitle: (paneId, title) => {
    const clean = title.trim();
    if (!clean) return;
    const root = updatePane(get().root, paneId, { title: clean });
    set({ root });
    persist({ root, focusedPaneId: get().focusedPaneId });
  },

  hydrate: (layout) => {
    if (!layout) {
      const root = initialTree();
      set({ root, focusedPaneId: firstPaneId(root), hydrated: true });
      return;
    }
    const focusedPaneId =
      layout.focusedPaneId ?? firstPaneId(layout.root);
    set({ root: layout.root, focusedPaneId, hydrated: true });
  },
}));
