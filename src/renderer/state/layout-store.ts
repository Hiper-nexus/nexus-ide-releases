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
  createLeaf,
  initialTree,
  isStructuralPlaceholderPane,
  listPanes,
  MAX_LIVE_PANES_HARD,
  MAX_LIVE_PANES_SOFT,
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
import { notifyIfLastMissionPaneClosed } from '../orch/mission-last-pane-notify';
import { isAutomatedReviewerPaneIdentity } from '../../shared/automated-reviewer-pane';

const DEFAULT_CANVAS_VIEWPORT = { x: 0, y: 0, zoom: 1 };

interface LayoutState {
  root: LayoutNode;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
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
  addBrowserPane(
    url?: string,
    paneId?: string,
    browserOpenRequestId?: string,
  ): string;
  /**
   * Orchestration-requested agent pane (MCP pane_spawn). Returns the new
   * paneId; the orchRequestId rides along into the PTY spawn so the main
   * process can bind the pane to its skill-gate context.
   */
  spawnOrchPane(req: {
    /** Stable physical pane id minted and sealed by the main process. */
    paneId: string;
    adapterId: string;
    model?: string;
    accountId?: string;
    effort?: string;
    cwd?: string;
    title?: string;
    orchRequestId: string;
    missionId?: string;
    transient?: true;
    agentName?: string;
    role?: 'orchestrator' | 'worker';
  }): string;
  /**
   * Remove a pane. `reason` is logged for operational forensics (why did two
   * panes disappear?) — never omit on automated paths.
   */
  close(paneId: string, reason?: string): void;
  /** Temporarily show one pane full-size in the grid without mutating the tree. */
  toggleMaximizePane(paneId: string): void;
  /** Drop a spent orchRequestId so Reiniciar does not reuse a dead token. */
  clearOrchRequestId(paneId: string): void;
  /** Claim Home's empty-state shell so automation can never discard it. */
  claimStructuralPlaceholder(paneId: string): void;
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
let terminalSnapshotProvider: ((paneId: string) => string | undefined) | null = null;

export function setTerminalSnapshotProvider(
  provider: ((paneId: string) => string | undefined) | null,
): void {
  terminalSnapshotProvider = provider;
}

function rootWithTerminalSnapshots(root: LayoutNode): LayoutNode {
  if (!terminalSnapshotProvider) return root;
  if (root.kind === 'leaf') {
    if (root.pane.kind === 'browser') return root;
    const terminalScrollback = terminalSnapshotProvider(root.pane.id);
    return {
      ...root,
      pane: {
        ...root.pane,
        ...(terminalScrollback ? { terminalScrollback } : {}),
      },
    };
  }
  return {
    ...root,
    children: [
      rootWithTerminalSnapshots(root.children[0]),
      rootWithTerminalSnapshots(root.children[1]),
    ],
  };
}

function isTransientLayoutPane(pane: PaneModel): boolean {
  return pane.transient === true || isAutomatedReviewerPaneIdentity(pane);
}

/**
 * Process-local PREVC panes may be visible during a live review, but they are
 * not workspace composition. Strip both the explicit marker and the exact
 * legacy identity before persistence, hydration, or restore policy runs.
 */
export function sanitizeWorkspaceLayout(
  layout: WorkspaceLayout,
): WorkspaceLayout {
  const transientPaneIds = listPanes(layout.root)
    .filter(isTransientLayoutPane)
    .map((pane) => pane.id);
  let durableRoot: LayoutNode | null = layout.root;
  for (const paneId of transientPaneIds) {
    if (!durableRoot) break;
    durableRoot = closePane(durableRoot, paneId);
  }
  const root = durableRoot ?? initialTree();
  const durablePaneIds = new Set(listPanes(root).map((pane) => pane.id));
  const focusedPaneId =
    layout.focusedPaneId && durablePaneIds.has(layout.focusedPaneId)
      ? layout.focusedPaneId
      : firstPaneId(root);
  const canvasNodeLayouts = layout.canvasNodeLayouts
    ? Object.fromEntries(
        Object.entries(layout.canvasNodeLayouts).filter(([paneId]) =>
          durablePaneIds.has(paneId),
        ),
      )
    : undefined;

  return {
    ...layout,
    root,
    focusedPaneId,
    ...(canvasNodeLayouts ? { canvasNodeLayouts } : {}),
  };
}

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
    const durableLayout = sanitizeWorkspaceLayout({
      root: state.root,
      focusedPaneId: state.focusedPaneId,
      viewKind: state.viewKind,
      canvasNodeLayouts: state.canvasNodeLayouts,
      canvasViewport: state.canvasViewport,
    });
    void window.nexus.layout.save(key, {
      ...durableLayout,
      root: rootWithTerminalSnapshots(durableLayout.root),
    });
  }, 300);
}

export function flushLayout(sync = false): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistKey) return;
  const { root, focusedPaneId, viewKind, canvasNodeLayouts, canvasViewport } =
    useLayoutStore.getState();
  const durableLayout = sanitizeWorkspaceLayout({
    root,
    focusedPaneId,
    viewKind,
    canvasNodeLayouts,
    canvasViewport,
  });
  const snapshot = {
    ...durableLayout,
    root: rootWithTerminalSnapshots(durableLayout.root),
  };
  if (sync) {
    window.nexus.layout.saveSync(persistKey, snapshot);
  } else {
    void window.nexus.layout.save(persistKey, snapshot);
  }
}

/**
 * Persist the outgoing workspace while main still recognizes the renderer's
 * old authority, then detach its persistence key. `workspace.open` changes
 * that authority immediately; an old async save after that point must (and
 * does) fail closed as a cross-workspace write.
 *
 * If the workspace open fails, call `switchWorkspaceLayout(previousPath)` to
 * restore persistence for the still-active workspace.
 */
export function prepareWorkspaceLayoutSwitch(): string | null {
  const previousPath = persistKey;
  flushLayout(true);
  persistKey = null;
  return previousPath;
}

/** Whether the in-memory tree is currently attached to a persistence key. */
export function hasAttachedWorkspaceLayout(): boolean {
  return persistKey !== null;
}

/**
 * Main can announce a workspace change that did not originate in this
 * renderer (for example, a future native open-file route). At that point the
 * old renderer authority is already gone, so attempting a final save would be
 * both stale and correctly rejected by Main. Cancel it and detach instead.
 *
 * Normal renderer-owned transitions must use prepareWorkspaceLayoutSwitch()
 * before invoking Main so their outgoing layout is still flushed.
 */
export function abandonWorkspaceLayoutAfterMainSwitch(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistKey = null;
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

let restoredPanesHandler: ((panes: readonly PaneModel[]) => void) | null = null;

/** Terminal runtime hook: restored CLI panes must request provider resume on first spawn. */
export function setRestoredPanesHandler(
  handler: ((panes: readonly PaneModel[]) => void) | null,
): void {
  restoredPanesHandler = handler;
}

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
    let layout: WorkspaceLayout | null;
    try {
      layout = await window.nexus.layout.load(workspacePath);
    } catch (cause) {
      // Never leave the outgoing in-memory tree attached to the new workspace
      // after a failed load: its next mutation would persist foreign panes
      // under the target root.
      if (persistKey === workspacePath) persistKey = null;
      throw cause;
    }
    // A stale response from a slower earlier switch must not clobber the tree.
    if (persistKey !== workspacePath) return true;
    // A local mutation landed while we were loading — it wins; don't hydrate.
    if (treeVersion !== versionAtStart) return layout !== null;
    const durableLayout = layout ? sanitizeWorkspaceLayout(layout) : null;
    if (durableLayout) restoredPanesHandler?.(listPanes(durableLayout.root));
    useLayoutStore.getState().hydrate(durableLayout);
    if (
      layout &&
      durableLayout &&
      durableLayout.root !== layout.root
    ) {
      // Durable GC for layouts written by releases predating `transient`.
      void window.nexus.layout.save(workspacePath, durableLayout);
    }
    return layout !== null;
  })();
  inFlightSwitch = { path: workspacePath, promise: run };
  const clearInFlight = (): void => {
    if (inFlightSwitch?.promise === run) inFlightSwitch = null;
  };
  void run.then(clearInFlight, clearInFlight);
  return run;
}

const WORKSPACE_LAYOUT_LOAD_ATTEMPTS = 2;

/**
 * A transient layout read must not leave the renderer on BootScreen forever.
 * Retry once, then hydrate an unsaved shell while keeping persistence detached
 * so a failed read can never overwrite the durable layout it could not load.
 */
export async function switchWorkspaceLayoutWithFallback(
  workspacePath: string,
  options: { readonly isCurrent?: () => boolean } = {},
): Promise<boolean> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt < WORKSPACE_LAYOUT_LOAD_ATTEMPTS;
    attempt += 1
  ) {
    if (options.isCurrent && !options.isCurrent()) return false;
    try {
      return await switchWorkspaceLayout(workspacePath);
    } catch (error) {
      lastError = error;
    }
  }
  if (options.isCurrent && !options.isCurrent()) return false;
  useLayoutStore.getState().hydrate(null);
  throw lastError;
}

/** Leaving to the launcher: flush and stop persisting. */
export function detachWorkspaceLayout(): void {
  flushLayout();
  persistKey = null;
}

const LAYOUT_SETTLE_TIMEOUT_MS = 15_000;

/**
 * Resolves once the workspace layout hydrate has landed (immediately when it
 * already did). Main-owned pane presentations await this so the persisted
 * layout can never hydrate OVER panes presented first — the race that left an
 * empty structural placeholder covering a live mission until any layout
 * mutation forced a replay. The timeout keeps presentations alive when no
 * workspace ever hydrates (launcher, tests).
 */
export function whenWorkspaceLayoutSettled(
  timeoutMs = LAYOUT_SETTLE_TIMEOUT_MS,
): Promise<void> {
  if (useLayoutStore.getState().hydrated) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const unsubscribe = useLayoutStore.subscribe((state) => {
      if (state.hydrated) finish();
    });
    timer = setTimeout(finish, timeoutMs);
    if (useLayoutStore.getState().hydrated) finish();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => flushLayout(true));
}

function firstPaneId(root: LayoutNode): string | null {
  const panes = listPanes(root);
  return panes.length > 0 ? panes[0].id : null;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  root: initialTree(),
  focusedPaneId: null,
  maximizedPaneId: null,
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
    // A stale maximize would keep covering the freshly split pane.
    const s = { ...get(), root, focusedPaneId: newPane.id, maximizedPaneId: null };
    set({ root, focusedPaneId: newPane.id, maximizedPaneId: null });
    persist(s);
  },

  spawnOrchPane: (req) => {
    const { root: currentRoot, viewKind, canvasNodeLayouts } = get();
    const existingPanes = listPanes(currentRoot);
    if (existingPanes.some((pane) => pane.id === req.paneId)) {
      throw new Error(
        `Main-owned pane id already exists in layout: ${req.paneId}`,
      );
    }
    const liveCount = existingPanes.length;
    if (liveCount >= MAX_LIVE_PANES_SOFT) {
      console.warn(
        `[layout] refuse orch spawn (live=${liveCount} soft=${MAX_LIVE_PANES_SOFT} hard=${MAX_LIVE_PANES_HARD}) title=${req.title ?? req.adapterId}`,
      );
      throw new Error(
        `Limite de panes (${MAX_LIVE_PANES_SOFT}). Feche algum antes de spawnar outro worker.`,
      );
    }
    const base = createPane(
      'cli-agent',
      req.cwd ?? getActiveWorkspacePath() ?? undefined,
      req.adapterId,
      req.model,
    );
    const newPane: PaneModel = {
      ...base,
      id: req.paneId,
      title: req.title ?? base.title,
      accountId: req.accountId,
      effort: req.effort,
      orchRequestId: req.orchRequestId,
      missionId: req.missionId,
      transient: req.transient,
      agentName: req.agentName,
      role: req.role,
    };
    // Um placeholder estrutural solitário nunca é conteúdo do operador: o
    // primeiro pane real da orquestração o SUBSTITUI (mesma regra de
    // panesAfterMainOwnedPresentation). Splitar ao lado deixava um tile vazio
    // permanente no grid — e, se maximizado, cobrindo os panes da missão.
    const replaceLonePlaceholder =
      existingPanes.length === 1 &&
      isStructuralPlaceholderPane(existingPanes[0]!);
    // Alvo balanceado: workers de squad em grade ~quadrada, nunca em tira.
    const target = replaceLonePlaceholder
      ? { paneId: null, direction: 'row' as SplitDirection }
      : pickBalancedTarget(currentRoot);
    const root = replaceLonePlaceholder
      ? createLeaf(newPane)
      : target.paneId
        ? splitPane(currentRoot, target.paneId, target.direction, newPane)
        : splitPane(initialTree(), firstPaneId(initialTree()) ?? '', 'row', newPane);

    const paneCount = listPanes(root).length;
    const baseCanvasLayouts =
      viewKind === 'canvas'
        ? ensureCanvasLayouts(existingPanes, canvasNodeLayouts)
        : canvasNodeLayouts;
    const pivot = target.paneId ?? firstPaneId(currentRoot);
    const updatedLayouts =
      viewKind === 'canvas'
        ? replaceLonePlaceholder
          ? { [newPane.id]: defaultCanvasLayout(0) }
          : {
              ...baseCanvasLayouts,
              [newPane.id]: nextCanvasLayout(baseCanvasLayouts, pivot, paneCount - 1),
            }
        : canvasNodeLayouts;

    bumpTreeVersion();
    // O foco deliberado no pane recém-montado encerra qualquer maximize stale
    // (mesmo idioma de focus()/setPanes): senão o pane ampliado continua
    // cobrindo o agente que a orquestração acabou de apresentar.
    set({ root, focusedPaneId: newPane.id, maximizedPaneId: null, canvasNodeLayouts: updatedLayouts });
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
    set({
      root,
      focusedPaneId: newPane.id,
      maximizedPaneId: null,
      canvasNodeLayouts: updatedLayouts,
    });
    persist({ ...get(), root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    return newPane.id;
  },

  setPanes: (panes) => {
    if (panes.length === 0) return;
    // Hard cap: reopen/merge must not flood a small screen silently.
    const capped =
      panes.length > MAX_LIVE_PANES_HARD
        ? panes.slice(0, MAX_LIVE_PANES_HARD)
        : panes;
    if (capped.length < panes.length) {
      console.warn(
        `[layout] setPanes capped ${panes.length}→${capped.length} (hard=${MAX_LIVE_PANES_HARD})`,
      );
    }
    const root = buildGridTree(capped);
    const focusedPaneId = capped[0]!.id;
    const { viewKind, canvasNodeLayouts } = get();
    const updatedLayouts =
      viewKind === 'canvas'
        ? capped.reduce(
            (acc, pane, index) => ({
              ...acc,
              [pane.id]: defaultCanvasLayout(index),
            }),
            {} as Record<string, CanvasNodeLayout>,
          )
        : canvasNodeLayouts;
    bumpTreeVersion();
    // Substituição deliberada do grid (retomada/apresentação de missão, Modo
    // Livre) encerra qualquer zoom de pane único: um maximize stale deixava o
    // pane ampliado (às vezes um shell vazio) cobrindo os panes recém-montados.
    set({ root, focusedPaneId, maximizedPaneId: null, canvasNodeLayouts: updatedLayouts });
    persist({ ...get(), root, focusedPaneId, canvasNodeLayouts: updatedLayouts });
  },

  spawnAgent: (adapterId, model) => {
    const { focusedPaneId: targetId, root: currentRoot, viewKind, canvasNodeLayouts } = get();
    if (listPanes(currentRoot).length >= MAX_LIVE_PANES_HARD) {
      console.warn(
        `[layout] refuse spawnAgent (hard=${MAX_LIVE_PANES_HARD}) adapter=${adapterId}`,
      );
      return;
    }
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
    set({
      root,
      focusedPaneId,
      maximizedPaneId: null,
      canvasNodeLayouts: updatedLayouts,
    });
    persist({ ...get(), root, focusedPaneId, canvasNodeLayouts: updatedLayouts });
  },

  close: (paneId, reason = 'unspecified') => {
    const before = listPanes(get().root);
    const beforeCount = before.length;
    if (!before.some((p) => p.id === paneId)) {
      console.warn(
        `[layout] close no-op pane=${paneId} reason=${reason} live=${beforeCount}`,
      );
      return;
    }
    const next = closePane(get().root, paneId);
    const root = next ?? initialTree();
    const afterCount = listPanes(root).length;
    // Guardrail: pure closePane must remove exactly one leaf (or last→shell).
    if (next !== null && afterCount !== beforeCount - 1) {
      console.error(
        `[layout] close anomaly pane=${paneId} reason=${reason} before=${beforeCount} after=${afterCount}`,
      );
    } else {
      console.info(
        `[layout] close pane=${paneId} reason=${reason} before=${beforeCount} after=${afterCount}`,
      );
    }
    const focusedPaneId =
      get().focusedPaneId === paneId ? firstPaneId(root) : get().focusedPaneId;
    const maximizedPaneId =
      get().maximizedPaneId === paneId ? null : get().maximizedPaneId;
    bumpTreeVersion();
    const s = { ...get(), root, focusedPaneId, maximizedPaneId };
    set({ root, focusedPaneId, maximizedPaneId });
    persist(s);
    // Closing the LAST pane replaces it with a fresh shell — visually a no-op.
    // Surface the Home deck so the click has feedback and a next step.
    //
    // This must fire for EVERY reason, not only an operator click. Gating it on
    // `reason === 'user'` (an attempt to stop Home from covering a dead
    // mission's transcript) left the window completely black when the runtime
    // closed the last pane: there was no transcript left to protect and nothing
    // took Home's place. Keeping a dead mission's output on screen has to be
    // solved by not closing its pane, never by rendering nothing.
    if (next === null) useHomeStore.getState().show();
    // Missão viva que perdeu o último pane visível continua rodando Main-owned
    // em segundo plano — avisa com ação de reabrir (o Home acima permanece;
    // o toast cavalga por cima dele). Ver mission-last-pane-notify.ts.
    const closedPane = before.find((pane) => pane.id === paneId);
    if (closedPane) {
      notifyIfLastMissionPaneClosed(closedPane, reason, listPanes(root));
    }
  },

  toggleMaximizePane: (paneId) => {
    const exists = listPanes(get().root).some((pane) => pane.id === paneId);
    if (!exists) return;
    const maximizedPaneId = get().maximizedPaneId === paneId ? null : paneId;
    set({ maximizedPaneId, focusedPaneId: paneId });
  },

  clearOrchRequestId: (paneId) => {
    const pane = listPanes(get().root).find((p) => p.id === paneId);
    if (!pane?.orchRequestId) return;
    const root = updatePane(get().root, paneId, { orchRequestId: undefined });
    set({ root });
    persist({ ...get(), root });
  },

  claimStructuralPlaceholder: (paneId) => {
    const pane = listPanes(get().root).find(
      (candidate) => candidate.id === paneId,
    );
    if (
      pane?.kind !== 'shell' ||
      pane.isStructuralPlaceholder !== true
    ) return;
    const root = updatePane(get().root, paneId, {
      isStructuralPlaceholder: undefined,
    });
    set({ root });
    persist({ ...get(), root });
  },

  addBrowserPane: (url, paneId, browserOpenRequestId) => {
    const { root: currentRoot, focusedPaneId, viewKind, canvasNodeLayouts } = get();
    if (paneId && listPanes(currentRoot).some((pane) => pane.id === paneId)) {
      throw new Error(`browser pane identity already exists: ${paneId}`);
    }
    const newPane: PaneModel = {
      ...createPane('browser', getActiveWorkspacePath() ?? undefined),
      ...(paneId ? { id: paneId } : {}),
      title: 'browser',
      browserUrl: url,
      browserOpenRequestId,
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
    set({
      root,
      focusedPaneId: newPane.id,
      maximizedPaneId: null,
      canvasNodeLayouts: updatedLayouts,
    });
    persist({ ...get(), root, focusedPaneId: newPane.id, canvasNodeLayouts: updatedLayouts });
    return newPane.id;
  },

  focus: (paneId) => {
    // Um pane maximizado cobre o grid inteiro (PaneGrid renderiza só ele).
    // Foco programático em OUTRO pane (retomada de missão, CTA de toast,
    // paleta, "focar agente" do rail) é um pedido explícito de mostrar esse
    // pane — sem derrubar o maximize ele vira no-op invisível e o operador
    // fica olhando um pane vazio com os panes reais montados embaixo.
    const maximizedPaneId =
      get().maximizedPaneId === paneId ? get().maximizedPaneId : null;
    if (get().focusedPaneId === paneId && get().maximizedPaneId === maximizedPaneId)
      return;
    set({ focusedPaneId: paneId, maximizedPaneId });
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
        maximizedPaneId: null,
        hydrated: true,
        viewKind: 'grid',
        canvasNodeLayouts: {},
        canvasViewport: DEFAULT_CANVAS_VIEWPORT,
      });
      return;
    }
    const durableLayout = sanitizeWorkspaceLayout(layout);
    const focusedPaneId =
      durableLayout.focusedPaneId ?? firstPaneId(durableLayout.root);
    const currentMaximized = get().maximizedPaneId;
    const maximizedPaneId = listPanes(durableLayout.root).some(
      (pane) => pane.id === currentMaximized,
    )
      ? currentMaximized
      : null;
    set({
      root: durableLayout.root,
      focusedPaneId,
      maximizedPaneId,
      hydrated: true,
      viewKind: durableLayout.viewKind ?? 'grid',
      canvasNodeLayouts: durableLayout.canvasNodeLayouts ?? {},
      canvasViewport:
        durableLayout.canvasViewport ?? DEFAULT_CANVAS_VIEWPORT,
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
