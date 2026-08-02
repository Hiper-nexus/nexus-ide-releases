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
  /**
   * Restore a persisted tree. A restore is a HINT, never authority: with
   * `preserveLiveMissionPanes` the panes bound to a live mission survive it
   * (see enforceLayoutInvariants / I3).
   */
  hydrate(
    layout: WorkspaceLayout | null,
    options?: { readonly preserveLiveMissionPanes?: boolean },
  ): void;
  toggleView(): void;
  updateCanvasNodeLayout(paneId: string, patch: Partial<CanvasNodeLayout>): void;
  setCanvasViewport(vp: { x: number; y: number; zoom: number }): void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Layouts are keyed per workspace folder. `persistKey` is the ADDRESS saves are
 * written to, and whether persistence is attached at all (null = detached).
 *
 * It is NOT proof of ownership: a switch adopts the new key before the target's
 * layout read resolves, so between those two moments the key already names the
 * incoming workspace while the tree in memory is still the outgoing one. Only
 * `layoutWorkspacePath` below answers "whose panes are these?".
 */
let persistKey: string | null = null;

/**
 * Which workspace the CURRENT in-memory tree belongs to. `persistKey` cannot
 * answer this: it is nulled while a switch is being prepared, and it is adopted
 * BEFORE the target's layout read resolves, yet the tree (and its live mission
 * panes) still belongs to the previous workspace during that whole window.
 *
 * Two things depend on the distinction:
 *   - a restore of the SAME workspace is a refresh, where live mission panes
 *     outrank the saved copy (see hydrate / I3);
 *   - a save may only be written under the key that OWNS the tree being
 *     written (see persist / flushLayout), or a mid-switch operator action
 *     lands the outgoing panes in the incoming workspace.
 */
let layoutWorkspacePath: string | null = null;

/**
 * Whether the in-memory tree may be written under `key`. Persisting is the one
 * operation where "which workspace is being opened" is the wrong question: the
 * only correct key is the one the CURRENT tree belongs to.
 */
function ownsPersistedLayout(key: string): boolean {
  return layoutWorkspacePath === key;
}

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

/**
 * Debounced save of the CURRENT store state.
 *
 * It deliberately takes no snapshot argument: callers used to pass the raw tree
 * they had just computed, which now differs from what the store committed
 * (enforceLayoutInvariants may drop a placeholder or a stale zoom). Persisting
 * the caller's copy would write back the exact ghost the invariant removed.
 */
function persist(): void {
  if (!persistKey) return; // No workspace open — nothing to persist against.
  const key = persistKey;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // Checked HERE, not at schedule time: the debounce is exactly long enough
    // for a workspace switch to adopt the new key while the tree on screen is
    // still the old one.
    if (!ownsPersistedLayout(key)) {
      console.warn(
        `[layout] skip save under ${key}: tree belongs to ${layoutWorkspacePath ?? 'no workspace'}`,
      );
      return;
    }
    const state = useLayoutStore.getState();
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
  if (!ownsPersistedLayout(persistKey)) {
    console.warn(
      `[layout] skip flush under ${persistKey}: tree belongs to ${layoutWorkspacePath ?? 'no workspace'}`,
    );
    return;
  }
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

/**
 * Number of workspace-layout reads in flight. `hydrated` alone cannot gate
 * presentations: it is a one-shot latch that never goes back down, so from the
 * second read onward every presentation sailed straight past the gate and the
 * restore landed on top of it. "Settled" means hydrated AND nothing loading.
 */
let layoutLoadsInFlight = 0;
const layoutSettleWaiters = new Set<() => void>();

function isWorkspaceLayoutSettled(): boolean {
  return useLayoutStore.getState().hydrated && layoutLoadsInFlight === 0;
}

function releaseLayoutSettleWaiters(): void {
  if (!isWorkspaceLayoutSettled()) return;
  for (const waiter of [...layoutSettleWaiters]) waiter();
}

function beginWorkspaceLayoutLoad(): void {
  layoutLoadsInFlight += 1;
}

function endWorkspaceLayoutLoad(): void {
  layoutLoadsInFlight = Math.max(0, layoutLoadsInFlight - 1);
  releaseLayoutSettleWaiters();
}

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
  // Arm the settle gate BEFORE the first await: a presentation racing this read
  // must wait for the tree it is about to land on.
  beginWorkspaceLayoutLoad();
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
    if (treeVersion !== versionAtStart) {
      // That live tree IS this workspace's tree now. Recording it matters: the
      // next re-read has to recognise it as a refresh, or it would treat the
      // mission on screen as foreign and restore right over it.
      layoutWorkspacePath = workspacePath;
      return layout !== null;
    }
    const durableLayout = layout ? sanitizeWorkspaceLayout(layout) : null;
    if (durableLayout) restoredPanesHandler?.(listPanes(durableLayout.root));
    // Re-reading the workspace the tree already belongs to is a refresh, not a
    // switch: whatever mission is live on screen outranks the saved copy.
    const sameWorkspace = layoutWorkspacePath === workspacePath;
    useLayoutStore
      .getState()
      .hydrate(durableLayout, { preserveLiveMissionPanes: sameWorkspace });
    layoutWorkspacePath = workspacePath;
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
  const settleLoad = (): void => {
    if (inFlightSwitch?.promise === run) inFlightSwitch = null;
    endWorkspaceLayoutLoad();
  };
  void run.then(settleLoad, settleLoad);
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
  // The read failed; the RUNTIME did not. A live main-owned mission must not be
  // wiped off the screen by an unreadable file — that produced the "empty pane
  // covering the mission; I close it and the mission reappears" report.
  useLayoutStore.getState().hydrate(null, {
    preserveLiveMissionPanes: layoutWorkspacePath === workspacePath,
  });
  layoutWorkspacePath = workspacePath;
  throw lastError;
}

/** Leaving to the launcher: flush and stop persisting. */
export function detachWorkspaceLayout(): void {
  flushLayout();
  persistKey = null;
  // The panes are about to be disposed with their PTYs; nothing may follow the
  // tree into the next workspace.
  layoutWorkspacePath = null;
}

const LAYOUT_SETTLE_TIMEOUT_MS = 15_000;

/**
 * Resolves once the workspace layout is SETTLED: hydrated at least once and no
 * read in flight. Main-owned pane presentations await this so a restore can
 * never land on top of panes presented first.
 *
 * The `hydrated` flag alone was not enough. It is a one-shot latch, so it only
 * ever gated the FIRST boot read; every later read (workspace re-activation,
 * retry, Main-owned switch) ran with `hydrated === true` and the gate became a
 * no-op — which is why the ghost pane kept coming back after the ordering fix.
 * The timeout keeps presentations alive when no workspace ever hydrates
 * (launcher, tests).
 */
export function whenWorkspaceLayoutSettled(
  timeoutMs = LAYOUT_SETTLE_TIMEOUT_MS,
): Promise<void> {
  if (isWorkspaceLayoutSettled()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      layoutSettleWaiters.delete(check);
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const check = (): void => {
      if (isWorkspaceLayoutSettled()) finish();
    };
    layoutSettleWaiters.add(check);
    const unsubscribe = useLayoutStore.subscribe(check);
    timer = setTimeout(finish, timeoutMs);
    check();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => flushLayout(true));
}

function firstPaneId(root: LayoutNode): string | null {
  const panes = listPanes(root);
  return panes.length > 0 ? panes[0].id : null;
}

/**
 * The operator split / reused THIS pane on purpose. If it is the structural
 * placeholder they are claiming it, so it stops being a vacancy before the
 * invariant below gets to reclaim it.
 */
function claimPlaceholderTarget(root: LayoutNode, paneId: string | null): LayoutNode {
  if (!paneId) return root;
  const pane = listPanes(root).find((candidate) => candidate.id === paneId);
  if (!pane || !isStructuralPlaceholderPane(pane)) return root;
  return updatePane(root, paneId, { isStructuralPlaceholder: undefined });
}

/**
 * A returned paneId is a CONTRACT: the caller spawns a PTY on it, waits for its
 * session, writes a command into it. `splitPane` returns the tree UNCHANGED
 * when the pivot is not in it, so a stale pivot made the insertion a silent
 * no-op while the store still handed the id back — the caller then waited out
 * its full session timeout on a pane that exists nowhere.
 *
 * Fall back to appending the pane to the grid so the id is always honest.
 */
function rootWithPaneGuaranteed(
  proposed: LayoutNode,
  previous: LayoutNode,
  pane: PaneModel,
): LayoutNode {
  if (listPanes(proposed).some((candidate) => candidate.id === pane.id)) {
    return proposed;
  }
  console.warn(
    `[layout] split pivot not in tree — appending pane=${pane.id} to the grid`,
  );
  return buildGridTree([...listPanes(previous), pane]);
}

/**
 * THE layout invariant. Every write that touches the pane tree passes through
 * here, so a new call site cannot reintroduce the two defects this store keeps
 * growing back — and no future path has to remember to re-implement them:
 *
 *   I1  A structural placeholder is a VACANCY, not content. The moment the tree
 *       holds one real pane, no placeholder may remain beside it. This rule used
 *       to be re-implemented at six call sites in three mutually inconsistent
 *       ways (`length === 1 && placeholder`, `every(kind === 'shell')`, an
 *       inline copy in mission-reopen) — and `hydrate`, the one path that can
 *       install a placeholder OVER live content, never implemented it at all.
 *
 *   I2  A zoom is a view of ONE pane: PaneGrid renders only `maximizedPaneId`.
 *       It may not survive a write that ADDS panes (they would be mounted, live
 *       and invisible), nor point at a pane that left the tree. Seven call
 *       sites carried a hand-written `maximizedPaneId: null`; `hydrate`
 *       deliberately carried the zoom forward instead.
 *
 * Focus is normalized with it: it may only name a pane that survived the write.
 *
 *   I5  The two pointers (focus, zoom) may only name a pane that is IN the
 *       tree — including on writes that do not carry a `root`. Skipping those
 *       writes was not free: `setPanes` truncates at MAX_LIVE_PANES_HARD, the
 *       presentation channel focuses the pane it just presented, and on a
 *       saturated grid that pane is precisely the one truncation dropped. The
 *       phantom focus then became the split pivot of the next addShellPane,
 *       `splitPane` silently no-opped, and the store handed back the id of a
 *       pane that exists nowhere for a caller to spawn a PTY on.
 */
export function enforceLayoutInvariants(
  previous: Pick<LayoutState, 'root' | 'focusedPaneId' | 'maximizedPaneId'>,
  partial: Partial<LayoutState>,
): Partial<LayoutState> {
  if (partial.root === undefined) {
    // The tree does not change, so I1/I2's "did this write add panes?" question
    // does not apply — but I5 still does, against the tree that IS live.
    if (
      partial.focusedPaneId === undefined &&
      partial.maximizedPaneId === undefined
    ) {
      return partial;
    }
    const live = listPanes(previous.root);
    const liveIds = new Set(live.map((pane) => pane.id));
    const requestedFocus =
      partial.focusedPaneId !== undefined
        ? partial.focusedPaneId
        : previous.focusedPaneId;
    const requestedZoom =
      partial.maximizedPaneId !== undefined
        ? partial.maximizedPaneId
        : previous.maximizedPaneId;
    return {
      ...partial,
      focusedPaneId:
        requestedFocus && liveIds.has(requestedFocus)
          ? requestedFocus
          : (live[0]?.id ?? null),
      maximizedPaneId:
        requestedZoom && liveIds.has(requestedZoom) ? requestedZoom : null,
    };
  }
  const proposed = listPanes(partial.root);
  const durable = proposed.filter((pane) => !isStructuralPlaceholderPane(pane));
  const reclaimsVacancy = durable.length > 0 && durable.length < proposed.length;
  if (reclaimsVacancy) {
    console.info(
      `[layout] dropped ${proposed.length - durable.length} structural placeholder(s) beside ${durable.length} live pane(s)`,
    );
  }
  const root = reclaimsVacancy ? buildGridTree(durable) : partial.root;
  const live = reclaimsVacancy ? durable : proposed;
  const liveIds = new Set(live.map((pane) => pane.id));

  const requestedFocus =
    partial.focusedPaneId !== undefined
      ? partial.focusedPaneId
      : previous.focusedPaneId;
  const focusedPaneId =
    requestedFocus && liveIds.has(requestedFocus)
      ? requestedFocus
      : (live[0]?.id ?? null);

  const previousIds = new Set(listPanes(previous.root).map((pane) => pane.id));
  const gainedPanes = live.some((pane) => !previousIds.has(pane.id));
  const requestedZoom =
    partial.maximizedPaneId !== undefined
      ? partial.maximizedPaneId
      : previous.maximizedPaneId;
  const maximizedPaneId =
    requestedZoom && liveIds.has(requestedZoom) && !gainedPanes
      ? requestedZoom
      : null;

  return { ...partial, root, focusedPaneId, maximizedPaneId };
}

export const useLayoutStore = create<LayoutState>((rawSet, get) => {
  /**
   * Single write seam. Not a convenience: it is what makes the invariant a
   * property of the STORE instead of a rule every caller has to remember.
   */
  const set = (partial: Partial<LayoutState>): void => {
    rawSet(enforceLayoutInvariants(get(), partial));
  };
  return {
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
    // Splitting the placeholder IS using it — claim it so the vacancy rule
    // does not reclaim the terminal the operator just asked to keep.
    const claimed = claimPlaceholderTarget(get().root, paneId);
    const root = splitPane(claimed, paneId, direction, newPane);
    bumpTreeVersion();
    set({ root, focusedPaneId: newPane.id });
    persist();
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
    persist();
    return newPane.id;
  },

  addShellPane: () => {
    const { root: currentRoot, focusedPaneId, viewKind, canvasNodeLayouts } = get();
    const newPane = createPane('shell', getActiveWorkspacePath() ?? undefined);
    const pivot = focusedPaneId ?? firstPaneId(currentRoot);
    // ＋ Terminal on a fresh workspace means "I want two terminals", so the
    // placeholder being split becomes the operator's first one.
    const claimed = claimPlaceholderTarget(currentRoot, pivot);
    const root = pivot
      ? rootWithPaneGuaranteed(
          splitPane(claimed, pivot, 'row', newPane),
          claimed,
          newPane,
        )
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
    persist();
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
    persist();
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
    persist();
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
    set({ root, focusedPaneId, maximizedPaneId });
    persist();
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
    persist();
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
    persist();
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
      ? rootWithPaneGuaranteed(
          splitPane(currentRoot, pivot, 'row', newPane),
          currentRoot,
          newPane,
        )
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
    persist();
    return newPane.id;
  },

  focus: (paneId) => {
    // Focar um pane que não está na árvore não é "focar nada": o id fica
    // gravado em focusedPaneId e vira o PIVÔ de addShellPane/addBrowserPane —
    // o split não acha o pivô, não insere nada, e o pane novo nunca aparece.
    // Acontece de verdade quando o cap de setPanes descarta o pane que a
    // apresentação acabou de montar (grid saturado de squad).
    if (!listPanes(get().root).some((pane) => pane.id === paneId)) {
      console.warn(`[layout] focus no-op: pane not in tree pane=${paneId}`);
      return;
    }
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
    persist();
  },

  renameTitle: (paneId, title) => {
    const clean = title.trim();
    if (!clean) return;
    const root = updatePane(get().root, paneId, {
      title: clean,
      titlePinned: true,
    });
    set({ root });
    persist();
  },

  setBrowserUrl: (paneId, url) => {
    const root = updatePane(get().root, paneId, { browserUrl: url });
    set({ root });
    persist();
  },

  setAccountId: (paneId, accountId) => {
    const root = updatePane(get().root, paneId, { accountId });
    set({ root });
    persist();
  },

  hydrate: (layout, options = {}) => {
    // I3 — a restore is a HINT, a live mission is AUTHORITY.
    //
    // `hydrate` is the only tree write that can install a saved tree over
    // whatever is on screen, and it is the one path that never had a rule. A
    // re-read of the SAME workspace (re-activation, retry, unreadable file)
    // routinely returns a layout written BEFORE the mission started — the lone
    // structural placeholder — because the mission pane's debounced save had
    // not landed, or was cancelled outright by
    // abandonWorkspaceLayoutAfterMainSwitch. Letting that win is exactly the
    // reported bug: a shell replaying its persisted scrollback takes the whole
    // grid, the running mission is gone, and closing the shell forces a replay
    // that brings the mission back.
    const carried =
      options.preserveLiveMissionPanes === true
        ? listPanes(get().root).filter((pane) => pane.missionId !== undefined)
        : [];
    if (!layout) {
      const restored = initialTree();
      const root =
        carried.length > 0 ? buildGridTree(carried) : restored;
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
    const restoredPanes = listPanes(durableLayout.root);
    const restoredIds = new Set(restoredPanes.map((pane) => pane.id));
    const survivors = carried.filter((pane) => !restoredIds.has(pane.id));
    if (survivors.length > 0) {
      console.info(
        `[layout] restore kept ${survivors.length} live mission pane(s) the saved layout did not contain`,
      );
    }
    const root =
      survivors.length > 0
        ? buildGridTree([...restoredPanes, ...survivors])
        : durableLayout.root;
    // The zoom is deliberately NOT decided here: enforceLayoutInvariants owns
    // it, so a restore that adds panes can never leave one covering them.
    set({
      root,
      focusedPaneId:
        durableLayout.focusedPaneId ?? firstPaneId(durableLayout.root),
      hydrated: true,
      viewKind: durableLayout.viewKind ?? 'grid',
      canvasNodeLayouts: durableLayout.canvasNodeLayouts ?? {},
      canvasViewport:
        durableLayout.canvasViewport ?? DEFAULT_CANVAS_VIEWPORT,
    });
  },

  toggleView: () => {
    const { viewKind, root, canvasNodeLayouts } = get();
    if (viewKind === 'grid') {
      const panes = listPanes(root);
      const updatedLayouts = ensureCanvasLayouts(panes, canvasNodeLayouts);
      set({ viewKind: 'canvas', canvasNodeLayouts: updatedLayouts });
      persist();
    } else {
      set({ viewKind: 'grid' });
      persist();
    }
  },

  updateCanvasNodeLayout: (paneId, patch) => {
    const { canvasNodeLayouts } = get();
    const existing = canvasNodeLayouts[paneId] ?? defaultCanvasLayout(0);
    const updated = { ...existing, ...patch };
    const updatedLayouts = { ...canvasNodeLayouts, [paneId]: updated };
    set({ canvasNodeLayouts: updatedLayouts });
    persist();
  },

  setCanvasViewport: (vp) => {
    set({ canvasViewport: vp });
    // Debounce viewport persist separately (fires on every pan/zoom frame).
    persist();
  },
  };
});
