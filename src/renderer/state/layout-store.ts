import { create } from 'zustand';
import type {
  CanvasNodeLayout,
  LayoutNode,
  PaneModel,
  SplitDirection,
  ViewKind,
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
import {
  defaultCanvasLayout,
  ensureCanvasLayouts,
} from '../lib/canvas-layout';

const DEFAULT_CANVAS_VIEWPORT = { x: 0, y: 0, zoom: 1 };

interface LayoutState {
  root: LayoutNode;
  focusedPaneId: string | null;
  hydrated: boolean;
  viewKind: ViewKind;
  canvasNodeLayouts: Record<string, CanvasNodeLayout>;
  canvasViewport: { x: number; y: number; zoom: number };

  split(paneId: string, direction: SplitDirection): void;
  spawnAgent(adapterId: string, model: string): void;
  close(paneId: string): void;
  focus(paneId: string): void;
  setTitle(paneId: string, title: string): void;
  hydrate(layout: WorkspaceLayout | null): void;
  toggleView(): void;
  updateCanvasNodeLayout(paneId: string, patch: Partial<CanvasNodeLayout>): void;
  setCanvasViewport(vp: { x: number; y: number; zoom: number }): void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

type PersistPayload = Pick<
  LayoutState,
  'root' | 'focusedPaneId' | 'viewKind' | 'canvasNodeLayouts' | 'canvasViewport'
>;

function persist(state: PersistPayload): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void window.nexus.layout.save({
      root: state.root,
      focusedPaneId: state.focusedPaneId,
      viewKind: state.viewKind,
      canvasNodeLayouts: state.canvasNodeLayouts,
      canvasViewport: state.canvasViewport,
    });
  }, 300);
}

export function flushLayout(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const { root, focusedPaneId, viewKind, canvasNodeLayouts, canvasViewport } =
    useLayoutStore.getState();
  void window.nexus.layout.save({
    root,
    focusedPaneId,
    viewKind,
    canvasNodeLayouts,
    canvasViewport,
  });
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
  viewKind: 'grid',
  canvasNodeLayouts: {},
  canvasViewport: DEFAULT_CANVAS_VIEWPORT,

  split: (paneId, direction) => {
    const newPane: PaneModel = createPane('shell');
    const root = splitPane(get().root, paneId, direction, newPane);
    const s = { ...get(), root, focusedPaneId: newPane.id };
    set({ root, focusedPaneId: newPane.id });
    persist(s);
  },

  spawnAgent: (adapterId, model) => {
    const { focusedPaneId: targetId, root: currentRoot, viewKind, canvasNodeLayouts } = get();
    const newPane: PaneModel = createPane('cli-agent', undefined, adapterId, model);
    const pivotId = targetId ?? firstPaneId(currentRoot);
    const root = pivotId
      ? splitPane(currentRoot, pivotId, 'row', newPane)
      : splitPane(initialTree(), firstPaneId(initialTree()) ?? '', 'row', newPane);

    const paneCount = listPanes(root).length;
    const updatedLayouts =
      viewKind === 'canvas'
        ? { ...canvasNodeLayouts, [newPane.id]: defaultCanvasLayout(paneCount - 1) }
        : canvasNodeLayouts;

    const focusedPaneId = newPane.id;
    set({ root, focusedPaneId, canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), root, focusedPaneId, canvasNodeLayouts: updatedLayouts });
  },

  close: (paneId) => {
    const next = closePane(get().root, paneId);
    const root = next ?? initialTree();
    const focusedPaneId =
      get().focusedPaneId === paneId ? firstPaneId(root) : get().focusedPaneId;
    const s = { ...get(), root, focusedPaneId };
    set({ root, focusedPaneId });
    persist(s);
  },

  focus: (paneId) => {
    if (get().focusedPaneId === paneId) return;
    set({ focusedPaneId: paneId });
    // Focus changes don't debounce-persist — too frequent, not load-bearing.
  },

  setTitle: (paneId, title) => {
    const clean = title.trim();
    if (!clean) return;
    const root = updatePane(get().root, paneId, { title: clean });
    set({ root });
    persist({ ...get(), root });
  },

  hydrate: (layout) => {
    if (!layout) {
      const root = initialTree();
      set({
        root,
        focusedPaneId: firstPaneId(root),
        hydrated: true,
        viewKind: 'grid',
        canvasNodeLayouts: {},
        canvasViewport: DEFAULT_CANVAS_VIEWPORT,
      });
      return;
    }
    const focusedPaneId = layout.focusedPaneId ?? firstPaneId(layout.root);
    set({
      root: layout.root,
      focusedPaneId,
      hydrated: true,
      viewKind: layout.viewKind ?? 'grid',
      canvasNodeLayouts: layout.canvasNodeLayouts ?? {},
      canvasViewport: layout.canvasViewport ?? DEFAULT_CANVAS_VIEWPORT,
    });
  },

  toggleView: () => {
    const { viewKind, root, canvasNodeLayouts, canvasViewport } = get();
    if (viewKind === 'grid') {
      const panes = listPanes(root);
      const updatedLayouts = ensureCanvasLayouts(panes, canvasNodeLayouts);
      const s = { ...get(), viewKind: 'canvas' as const, canvasNodeLayouts: updatedLayouts };
      set({ viewKind: 'canvas', canvasNodeLayouts: updatedLayouts });
      persist(s);
    } else {
      const s = { ...get(), viewKind: 'grid' as const };
      set({ viewKind: 'grid' });
      persist({ ...s, canvasNodeLayouts, canvasViewport });
    }
  },

  updateCanvasNodeLayout: (paneId, patch) => {
    const { canvasNodeLayouts } = get();
    const existing = canvasNodeLayouts[paneId] ?? defaultCanvasLayout(0);
    const updated = { ...existing, ...patch };
    const updatedLayouts = { ...canvasNodeLayouts, [paneId]: updated };
    set({ canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), canvasNodeLayouts: updatedLayouts });
  },

  setCanvasViewport: (vp) => {
    set({ canvasViewport: vp });
    // Debounce viewport persist separately (fires on every pan/zoom frame).
    persist({ ...get(), canvasViewport: vp });
  },
}));
