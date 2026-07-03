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
import { getActiveWorkspacePath } from './active-workspace';

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
  /**
   * Orchestration-requested agent pane (MCP pane_spawn). Returns the new
   * paneId; the orchRequestId rides along into the PTY spawn so the main
   * process can bind the pane to its skill-gate context.
   */
  spawnOrchPane(req: {
    adapterId: string;
    model?: string;
    cwd?: string;
    title?: string;
    orchRequestId: string;
  }): string;
  close(paneId: string): void;
  focus(paneId: string): void;
  setTitle(paneId: string, title: string): void;
  hydrate(layout: WorkspaceLayout | null): void;
  toggleView(): void;
  updateCanvasNodeLayout(paneId: string, patch: Partial<CanvasNodeLayout>): void;
  setCanvasViewport(vp: { x: number; y: number; zoom: number }): void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Layouts are keyed per workspace folder (Overclock parity). `persistKey`
 * pins which workspace the CURRENT in-memory tree belongs to, so a debounced
 * save that fires mid-switch can never write panes into the wrong workspace.
 */
let persistKey: string | null = null;

type PersistPayload = Pick<
  LayoutState,
  'root' | 'focusedPaneId' | 'viewKind' | 'canvasNodeLayouts' | 'canvasViewport'
>;

function persist(state: PersistPayload): void {
  if (!persistKey) return; // No workspace open — nothing to persist against.
  const key = persistKey;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void window.nexus.layout.save(key, {
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
  if (!persistKey) return;
  const { root, focusedPaneId, viewKind, canvasNodeLayouts, canvasViewport } =
    useLayoutStore.getState();
  void window.nexus.layout.save(persistKey, {
    root,
    focusedPaneId,
    viewKind,
    canvasNodeLayouts,
    canvasViewport,
  });
}

/**
 * Swap the pane tree to another workspace: flush the outgoing layout, load
 * the target's saved layout (or a fresh single-shell tree) and hydrate.
 * Idempotent per workspace. Returns whether a saved layout existed — a fresh
 * folder (no layout) is what triggers the Livre/Squad question.
 */
export async function switchWorkspaceLayout(
  workspacePath: string,
): Promise<boolean> {
  if (persistKey === workspacePath) return true;
  flushLayout();
  persistKey = workspacePath;
  const layout = await window.nexus.layout.load(workspacePath);
  // A stale response from a slower earlier switch must not clobber the tree.
  if (persistKey !== workspacePath) return true;
  useLayoutStore.getState().hydrate(layout);
  return layout !== null;
}

/** Leaving to the launcher: flush and stop persisting. */
export function detachWorkspaceLayout(): void {
  flushLayout();
  persistKey = null;
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
    const newPane: PaneModel = createPane(
      'shell',
      getActiveWorkspacePath() ?? undefined,
    );
    const root = splitPane(get().root, paneId, direction, newPane);
    const s = { ...get(), root, focusedPaneId: newPane.id };
    set({ root, focusedPaneId: newPane.id });
    persist(s);
  },

  spawnOrchPane: (req) => {
    const { focusedPaneId: targetId, root: currentRoot, viewKind, canvasNodeLayouts } = get();
    const base = createPane(
      'cli-agent',
      req.cwd ?? getActiveWorkspacePath() ?? undefined,
      req.adapterId,
      req.model,
    );
    const newPane: PaneModel = {
      ...base,
      title: req.title ?? base.title,
      orchRequestId: req.orchRequestId,
    };
    const pivotId = targetId ?? firstPaneId(currentRoot);
    const root = pivotId
      ? splitPane(currentRoot, pivotId, 'row', newPane)
      : splitPane(initialTree(), firstPaneId(initialTree()) ?? '', 'row', newPane);

    const paneCount = listPanes(root).length;
    const updatedLayouts =
      viewKind === 'canvas'
        ? { ...canvasNodeLayouts, [newPane.id]: defaultCanvasLayout(paneCount - 1) }
        : canvasNodeLayouts;

    set({ root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    return newPane.id;
  },

  spawnAgent: (adapterId, model) => {
    const { focusedPaneId: targetId, root: currentRoot, viewKind, canvasNodeLayouts } = get();
    const newPane: PaneModel = createPane(
      'cli-agent',
      getActiveWorkspacePath() ?? undefined,
      adapterId,
      model,
    );
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
