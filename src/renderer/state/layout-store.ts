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
  buildGridTree,
  closePane,
  createPane,
  initialTree,
  listPanes,
  splitPane,
  updatePane,
  pickBalancedTarget,
} from '../lib/split-tree';
import {
  defaultCanvasLayout,
  ensureCanvasLayouts,
  nextCanvasLayout,
} from '../lib/canvas-layout';
import { getActiveWorkspacePath } from './active-workspace';
import { useHomeStore } from './home-store';

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
  /** Replace the whole grid with an explicit set of panes (Modo Livre). */
  setPanes(panes: PaneModel[]): void;
  /** Add a fresh shell terminal pane (＋ Terminal) alongside the others. */
  addShellPane(): string;
  /** Add an embedded browser pane. */
  addBrowserPane(url?: string): string;
  /**
   * Orchestration-requested agent pane (MCP pane_spawn). Returns the new
   * paneId; the orchRequestId rides along into the PTY spawn so the main
   * process can bind the pane to its skill-gate context.
   */
  spawnOrchPane(req: {
    adapterId: string;
    model?: string;
    effort?: string;
    cwd?: string;
    title?: string;
    orchRequestId: string;
    agentName?: string;
    role?: 'orchestrator' | 'worker';
  }): string;
  close(paneId: string): void;
  focus(paneId: string): void;
  setTitle(paneId: string, title: string): void;
  /** User rename — pins the title so shell escapes stop overriding it. */
  renameTitle(paneId: string, title: string): void;
  setBrowserUrl(paneId: string, url: string): void;
  /** Pin the account used by this pane (used by account failover + resume). */
  setAccountId(paneId: string, accountId: string | undefined): void;
  hydrate(layout: WorkspaceLayout | null): void;
  toggleView(): void;
  updateCanvasNodeLayout(paneId: string, patch: Partial<CanvasNodeLayout>): void;
  setCanvasViewport(vp: { x: number; y: number; zoom: number }): void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Layouts are keyed per workspace folder. `persistKey`
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
 * Monotonic counter bumped by every LOCAL structural tree mutation (setPanes,
 * split, spawn, close). A workspace-layout load captures it before its await;
 * if it moved, a user action raced the load and IS the newer truth — the
 * loaded layout must not clobber it (that clobber killed and respawned the
 * squad orchestrator's PTY: the "claude opens twice" bug).
 */
let treeVersion = 0;
export function bumpTreeVersion(): void {
  treeVersion += 1;
}

let inFlightSwitch: { path: string; promise: Promise<boolean> } | null = null;

/**
 * Swap the pane tree to another workspace: flush the outgoing layout, load
 * the target's saved layout (or a fresh single-shell tree) and hydrate.
 * Concurrent calls for the SAME path share one promise, so every awaiter
 * really waits for the one hydrate (the old early-return resolved before the
 * in-flight hydrate landed, letting mission launches race it). Returns whether
 * a saved layout existed.
 */
export function switchWorkspaceLayout(workspacePath: string): Promise<boolean> {
  if (inFlightSwitch?.path === workspacePath) return inFlightSwitch.promise;
  if (persistKey === workspacePath && !inFlightSwitch) {
    return Promise.resolve(true);
  }
  const run = (async () => {
    flushLayout();
    persistKey = workspacePath;
    const versionAtStart = treeVersion;
    const layout = await window.nexus.layout.load(workspacePath);
    // A stale response from a slower earlier switch must not clobber the tree.
    if (persistKey !== workspacePath) return true;
    // A local mutation landed while we were loading — it wins; don't hydrate.
    if (treeVersion !== versionAtStart) return layout !== null;
    useLayoutStore.getState().hydrate(layout);
    return layout !== null;
  })();
  inFlightSwitch = { path: workspacePath, promise: run };
  void run.finally(() => {
    if (inFlightSwitch?.promise === run) inFlightSwitch = null;
  });
  return run;
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
    bumpTreeVersion();
    const s = { ...get(), root, focusedPaneId: newPane.id };
    set({ root, focusedPaneId: newPane.id });
    persist(s);
  },

  spawnOrchPane: (req) => {
    const { root: currentRoot, viewKind, canvasNodeLayouts } = get();
    const base = createPane(
      'cli-agent',
      req.cwd ?? getActiveWorkspacePath() ?? undefined,
      req.adapterId,
      req.model,
    );
    const newPane: PaneModel = {
      ...base,
      title: req.title ?? base.title,
      effort: req.effort,
      orchRequestId: req.orchRequestId,
      agentName: req.agentName,
      role: req.role,
    };
    // Alvo balanceado: workers de squad em grade ~quadrada, nunca em tira.
    const target = pickBalancedTarget(currentRoot);
    const root = target.paneId
      ? splitPane(currentRoot, target.paneId, target.direction, newPane)
      : splitPane(initialTree(), firstPaneId(initialTree()) ?? '', 'row', newPane);

    const existingPanes = listPanes(currentRoot);
    const paneCount = listPanes(root).length;
    const baseCanvasLayouts =
      viewKind === 'canvas'
        ? ensureCanvasLayouts(existingPanes, canvasNodeLayouts)
        : canvasNodeLayouts;
    const pivot = target.paneId ?? firstPaneId(currentRoot);
    const updatedLayouts =
      viewKind === 'canvas'
        ? {
            ...baseCanvasLayouts,
            [newPane.id]: nextCanvasLayout(baseCanvasLayouts, pivot, paneCount - 1),
          }
        : canvasNodeLayouts;

    bumpTreeVersion();
    set({ root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    return newPane.id;
  },

  addShellPane: () => {
    const { root: currentRoot, focusedPaneId, viewKind, canvasNodeLayouts } = get();
    const newPane = createPane('shell', getActiveWorkspacePath() ?? undefined);
    const pivot = focusedPaneId ?? firstPaneId(currentRoot);
    const root = pivot
      ? splitPane(currentRoot, pivot, 'row', newPane)
      : buildGridTree([newPane]);
    const existingPanes = listPanes(currentRoot);
    const paneCount = listPanes(root).length;
    const baseCanvasLayouts =
      viewKind === 'canvas'
        ? ensureCanvasLayouts(existingPanes, canvasNodeLayouts)
        : canvasNodeLayouts;
    const updatedLayouts =
      viewKind === 'canvas'
        ? {
            ...baseCanvasLayouts,
            [newPane.id]: nextCanvasLayout(baseCanvasLayouts, pivot, paneCount - 1),
          }
        : canvasNodeLayouts;
    bumpTreeVersion();
    set({ root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    return newPane.id;
  },

  setPanes: (panes) => {
    if (panes.length === 0) return;
    const root = buildGridTree(panes);
    const focusedPaneId = panes[0].id;
    const { viewKind, canvasNodeLayouts } = get();
    const updatedLayouts =
      viewKind === 'canvas'
        ? panes.reduce(
            (acc, pane, index) => ({
              ...acc,
              [pane.id]: defaultCanvasLayout(index),
            }),
            {} as Record<string, CanvasNodeLayout>,
          )
        : canvasNodeLayouts;
    bumpTreeVersion();
    set({ root, focusedPaneId, canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), root, focusedPaneId, canvasNodeLayouts: updatedLayouts });
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

    const existingPanes = listPanes(currentRoot);
    const paneCount = listPanes(root).length;
    const baseCanvasLayouts =
      viewKind === 'canvas'
        ? ensureCanvasLayouts(existingPanes, canvasNodeLayouts)
        : canvasNodeLayouts;
    const updatedLayouts =
      viewKind === 'canvas'
        ? {
            ...baseCanvasLayouts,
            [newPane.id]: nextCanvasLayout(baseCanvasLayouts, pivotId, paneCount - 1),
          }
        : canvasNodeLayouts;

    const focusedPaneId = newPane.id;
    bumpTreeVersion();
    set({ root, focusedPaneId, canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), root, focusedPaneId, canvasNodeLayouts: updatedLayouts });
  },

  close: (paneId) => {
    const next = closePane(get().root, paneId);
    const root = next ?? initialTree();
    const focusedPaneId =
      get().focusedPaneId === paneId ? firstPaneId(root) : get().focusedPaneId;
    bumpTreeVersion();
    const s = { ...get(), root, focusedPaneId };
    set({ root, focusedPaneId });
    persist(s);
    // Closing the LAST pane replaces it with a fresh shell — visually a no-op.
    // Surface the Home deck so the click has feedback and a next step.
    if (next === null) useHomeStore.getState().show();
  },

  addBrowserPane: (url) => {
    const { root: currentRoot, focusedPaneId, viewKind, canvasNodeLayouts } = get();
    const newPane: PaneModel = {
      ...createPane('browser', getActiveWorkspacePath() ?? undefined),
      title: 'browser',
      browserUrl: url,
    };
    const pivot = focusedPaneId ?? firstPaneId(currentRoot);
    const root = pivot
      ? splitPane(currentRoot, pivot, 'row', newPane)
      : buildGridTree([newPane]);
    const existingPanes = listPanes(currentRoot);
    const paneCount = listPanes(root).length;
    const baseCanvasLayouts =
      viewKind === 'canvas'
        ? ensureCanvasLayouts(existingPanes, canvasNodeLayouts)
        : canvasNodeLayouts;
    const updatedLayouts =
      viewKind === 'canvas'
        ? {
            ...baseCanvasLayouts,
            [newPane.id]: nextCanvasLayout(baseCanvasLayouts, pivot, paneCount - 1),
          }
        : canvasNodeLayouts;
    bumpTreeVersion();
    set({ root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    return newPane.id;
  },

  focus: (paneId) => {
    if (get().focusedPaneId === paneId) return;
    set({ focusedPaneId: paneId });
    // Focus changes don't debounce-persist — too frequent, not load-bearing.
  },

  setTitle: (paneId, title) => {
    const clean = title.trim();
    if (!clean) return;
    // Shell OSC-title escapes must not overwrite a user-pinned pane name.
    const pane = listPanes(get().root).find((p) => p.id === paneId);
    if (pane?.titlePinned) return;
    const root = updatePane(get().root, paneId, { title: clean });
    set({ root });
    persist({ ...get(), root });
  },

  renameTitle: (paneId, title) => {
    const clean = title.trim();
    if (!clean) return;
    const root = updatePane(get().root, paneId, {
      title: clean,
      titlePinned: true,
    });
    set({ root });
    persist({ ...get(), root });
  },

  setBrowserUrl: (paneId, url) => {
    const root = updatePane(get().root, paneId, { browserUrl: url });
    set({ root });
    persist({ ...get(), root });
  },

  setAccountId: (paneId, accountId) => {
    const root = updatePane(get().root, paneId, { accountId });
    const state = { ...get(), root };
    set({ root });
    persist(state);
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
