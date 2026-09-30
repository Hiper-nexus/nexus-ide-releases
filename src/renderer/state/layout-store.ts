import { create } from 'zustand';
import type { SpawnRouteInfo } from '../../shared/spawn-route';
import {
  claimPaneNumber,
  hydratePaneNumbers,
  releasePaneNumber,
} from '../lib/pane-numbers';
import type {
  LayoutNode,
  PaneModel,
  SplitDirection,
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
  withPaneNumbers,
} from '../lib/split-tree';
import { getActiveWorkspacePath } from './active-workspace';
import { useOrchStore } from './orch-store';
import { paneScopeResolver, spaceIdOfScopeKey } from '../lib/pane-spaces';
import { notifyIfLastMissionPaneClosed } from '../orch/mission-last-pane-notify';
import { stashPendingContinuity } from '../orch/stranded-mission-handoff';
import { isAutomatedReviewerPaneIdentity } from '../../shared/automated-reviewer-pane';

interface LayoutState {
  root: LayoutNode;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  stageFocusMode: boolean;
  stagePaneId: string | null;
  hydrated: boolean;

  split(paneId: string, direction: SplitDirection): void;
  /**
   * Pane de agente pedido pelo OPERADOR (voz, "+ Pane"). `accountId` fixa a
   * credencial escolhida na hora; ausente mantém o comportamento histórico —
   * o host descobre a conta ativa do provider no spawn (ensurePaneAccountPin).
   */
  spawnAgent(
    adapterId: string,
    model: string,
    options?: {
      readonly accountId?: string;
      readonly continuityPack?: string;
      readonly effort?: string;
    },
  ): string | undefined;
  /** Replace the whole grid with an explicit set of panes (Modo Livre). */
  setPanes(panes: PaneModel[]): void;
  /**
   * Add a fresh shell terminal pane alongside the others. Callers that must
   * wait for PTY readiness can opt out of focus until the session exists.
   */
  addShellPane(options?: { readonly focus?: boolean }): string;
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
    /** Pane que pediu este helper: o helper nasce na aba dele (C3/B1). */
    parentPaneId?: string;
    /** Origem da rota, só exibição. */
    spawnRoute?: SpawnRouteInfo;
  }): string;
  /**
   * Remove a pane. `reason` is logged for operational forensics (why did two
   * panes disappear?) — never omit on automated paths.
   */
  close(paneId: string, reason?: string): void;
  /** Temporarily show one pane full-size in the grid without mutating the tree. */
  toggleMaximizePane(paneId: string): void;
  /** Alterna o modo Stage Focus: pane focado em destaque (75%) com rail de cards vivos. */
  toggleStageFocus(paneId?: string): void;
  /** Define explicitamente o pane no palco principal em Stage Focus mode. */
  setStagePane(paneId: string): void;
  /** Drop a spent orchRequestId so Reiniciar does not reuse a dead token. */
  clearOrchRequestId(paneId: string): void;
  /** Claim the canonical structural vacancy as an operator shell. */
  claimStructuralPlaceholder(paneId: string): void;
  focus(paneId: string): void;
  setTitle(paneId: string, title: string): void;
  setPaneCwd(paneId: string, cwd: string): void;
  syncMissionSpaces(): void;
  /** User rename — pins the title so shell escapes stop overriding it. */
  renameTitle(paneId: string, title: string): void;
  setBrowserUrl(paneId: string, url: string): void;
  /** Pin the account used by this pane (used by account failover + resume). */
  setAccountId(paneId: string, accountId: string | undefined): void;
  /** Pin the model used by this pane (used by model failover: rejected model → catalog fallback). */
  setPaneModel(paneId: string, model: string | undefined): void;
  /**
   * Adota o pane no ESPAÇO do operador (F-560). Quem cria pane pelo "+ Pane"
   * dentro de um espaço quer o pane NAQUELE espaço — sem o carimbo o pane
   * nasceria solto e pularia para outra aba no próximo restart.
   */
  assignPaneSpace(paneId: string, spaceId: string, spaceTitle: string, isolated?: boolean): void;
  /**
   * Renomeia o espaço do operador inteiro: todos os panes carimbados com
   * `spaceId` passam a exibir o novo título na aba. Panes adotados por uma
   * missão não são tocados (a aba deles é a da missão, não a do espaço).
   */
  renamePaneSpace(spaceId: string, title: string): void;
  /**
   * Dá nome à aba dos panes sem espaço ("Terminais"): eles viram um espaço
   * com esse nome. Devolve false se não havia o que nomear.
   */
  nameLooseSpace(spaceId: string, title: string): boolean;
  promoteMissionPaneRole(missionId: string, paneId: string): void;
  /**
   * Espelha no layout a liderança que o MAIN já confirmou (onda 2 da
   * religação). `leaderPaneId === null` significa "esta missão não tem líder
   * confirmado" — ninguém pinta estrela.
   *
   * É a ÚNICA escrita de papel de missão do renderer, e é idempotente de
   * propósito: aplicar o mesmo snapshot duas vezes não gera `set`/`persist`
   * (o `persist` é debounced por workspace; escrever a cada broadcast virava
   * tempestade de save/IPC).
   */
  reflectMissionLeader(missionId: string, leaderPaneId: string | null): void;
  setPaneRole(paneId: string, role: 'orchestrator' | 'worker' | undefined): void;
  /**
   * Convert a dead mission/agent pane into an operator shell in place.
   * Clears mission role/adapter binding so the host can spawn a login shell.
   */
  reclaimAsOperatorShell(paneId: string): PaneModel | null;
  /**
   * Restore a persisted tree. A restore is a HINT, never authority: with
   * `preserveLiveMissionPanes` the panes bound to a live mission survive it
   * (see enforceLayoutInvariants / I3). `outgoingPaneIds` are panes of the
   * workspace that is LEAVING: they never cross into the tree being restored.
   */
  hydrate(
    layout: WorkspaceLayout | null,
    options?: {
      readonly preserveLiveMissionPanes?: boolean;
      readonly outgoingPaneIds?: ReadonlySet<string>;
    },
  ): void;
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

/** Fita ANSI mais a largura em que foi capturada — o replay depende das duas. */
export interface TerminalSnapshot {
  readonly data: string;
  readonly cols: number;
}

let terminalSnapshotProvider:
  | ((paneId: string) => TerminalSnapshot | undefined)
  | null = null;

export function setTerminalSnapshotProvider(
  provider: ((paneId: string) => TerminalSnapshot | undefined) | null,
): void {
  terminalSnapshotProvider = provider;
}

function rootWithTerminalSnapshots(root: LayoutNode): LayoutNode {
  if (!terminalSnapshotProvider) return root;
  if (root.kind === 'leaf') {
    if (root.pane.kind === 'browser') return root;
    // I6 (write side). A vacancy has no session to snapshot, and writing one
    // into it is what taught the placeholder to impersonate a terminal on the
    // next restore. Whatever a stray host reports for this id, it is not this
    // pane's work.
    if (isStructuralPlaceholderPane(root.pane)) return root;
    const snapshot = terminalSnapshotProvider(root.pane.id);
    return {
      ...root,
      pane: {
        ...root.pane,
        ...(snapshot
          ? {
              terminalScrollback: snapshot.data,
              terminalScrollbackCols: snapshot.cols,
            }
          : {}),
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

  return { ...layout, root, focusedPaneId };
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
  const { root, focusedPaneId } = useLayoutStore.getState();
  const durableLayout = sanitizeWorkspaceLayout({ root, focusedPaneId });
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
    // Trocar de workspace: o que já está na árvore agora é do workspace que
    // SAI. Só o que aterrissar durante a leitura pode pertencer ao alvo.
    const outgoingPaneIds: ReadonlySet<string> | undefined =
      layoutWorkspacePath === workspacePath
        ? undefined
        : new Set(listPanes(useLayoutStore.getState().root).map((pane) => pane.id));
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
    // A local mutation landed while we were loading.
    //
    // A tentação é carimbar a árvore viva como deste workspace, como o código
    // fazia antes. Isso está ERRADO: `hydrate` não rodou, então a árvore viva
    // ainda é a do workspace que está SAINDO. `layoutWorkspacePath` é o único
    // respondedor de `ownsPersistedLayout`, e o carimbo fazia a debounce de
    // 300 ms gravar os panes de A sob a chave de B — terminal de um workspace
    // aparecendo dentro de outro.
    //
    // Mas sair daqui sem nada também está errado: sem posse, `persist` e
    // `flushLayout` passam a PULAR toda gravação deste workspace para sempre
    // (`ownsPersistedLayout` false), e o operador perde os terminais em
    // silêncio. O desfecho correto é hidratar o alvo — a leitura já chegou —
    // preservando os panes de MISSÃO que aterrissaram nesta janela, que é
    // exatamente o que o carimbo existia para proteger.
    //
    // SÓ os que aterrissaram. Os panes de missão que já estavam na árvore são
    // do workspace que sai: carregá-los punha a missão de A no grid de B
    // (campo 23/09) — e a debounce seguinte os gravava no layout de B.
    if (treeVersion !== versionAtStart) {
      const durableLayout = layout ? sanitizeWorkspaceLayout(layout) : null;
      if (durableLayout) {
        restoredPanesHandler?.(listPanes(durableLayout.root));
      }
      useLayoutStore.getState().hydrate(durableLayout, {
        preserveLiveMissionPanes: true,
        outgoingPaneIds,
      });
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
 * I6 — a vacancy carries no session residue.
 *
 * `terminalScrollback` is a SESSION artifact. Persisted into a structural
 * placeholder it survives every restore, and `attachHost` replays it before
 * anything else: the operator reads "[nexus] process exited (code 0)", a fresh
 * shell spawns underneath and prints "sessão anterior encerrada · nova sessão
 * iniciada". A vacancy that replays a dead session is indistinguishable from
 * work in progress — that is precisely how the reported "pane solto tapando
 * tudo" survived four fixes that all reasoned about the TREE and never about
 * what the surviving node was allowed to CARRY.
 *
 * Applied at the seam and not at the restore path on purpose: the poisoned
 * rows are already on disk, and any future writer (recovery, reopen, a layout
 * import) would otherwise re-introduce them.
 */
function rootWithoutVacancyResidue(root: LayoutNode): LayoutNode {
  let next = root;
  for (const pane of listPanes(root)) {
    if (!isStructuralPlaceholderPane(pane)) continue;
    if (
      pane.terminalScrollback === undefined &&
      pane.terminalScrollbackCols === undefined
    ) {
      continue;
    }
    next = updatePane(next, pane.id, {
      terminalScrollback: undefined,
      terminalScrollbackCols: undefined,
    });
  }
  return next;
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
 *       It may not point at a pane that left the tree. F-521 (2026-09-14)
 *       relaxou a regra antiga "zoom cai em todo write que adiciona panes":
 *       panes de orquestração abrem POR TRÁS do orquestrador em modo foco —
 *       derrubar o zoom de todo write ganhador punia o operador que pediu
 *       foco e sabotava o `focus:false` do addShellPane. Hoje o zoom só cai
 *       quando o write pede explicitamente (`maximizedPaneId: null` no
 *       partial — foco deliberado no pane novo) ou quando o pane sai da
 *       árvore; panes novos montados atrás do zoom são intenção, não vazamento.
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
 *
 *   I6  A vacancy carries no session residue (see rootWithoutVacancyResidue).
 *       I1 only asks WHETHER the placeholder may stay; I6 asks what it may
 *       LOOK like while it legitimately does.
 */
function bindMissionSpaces(root: LayoutNode): LayoutNode {
  const { missions, paneMissions } = useOrchStore.getState();
  let next = root;
  for (const pane of listPanes(root)) {
    const mission = missions.find(item => item.id === (pane.missionId ?? paneMissions[pane.id]));
    const spaceId = mission?.intentContract?.workspaceBinding?.spaceId;
    if (!spaceId || (pane.spaceId === spaceId && pane.isolateSpace && pane.missionHost)) continue;
    next = updatePane(next, pane.id, { spaceId,
      spaceTitle: pane.spaceId === spaceId ? pane.spaceTitle ?? mission!.title : mission!.title,
      isolateSpace: true, missionHost: true });
  }
  return next;
}

export function enforceLayoutInvariants(
  previous: Pick<LayoutState, 'root' | 'focusedPaneId' | 'maximizedPaneId'> & {
    readonly stagePaneId?: string | null;
  },
  partial: Partial<LayoutState>,
): Partial<LayoutState> {
  if (partial.root === undefined) {
    // The tree does not change, so I1/I2's "did this write add panes?" question
    // does not apply — but I5 still does, against the tree that IS live.
    if (
      partial.focusedPaneId === undefined &&
      partial.maximizedPaneId === undefined &&
      partial.stagePaneId === undefined
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
    const requestedStagePane =
      partial.stagePaneId !== undefined
        ? partial.stagePaneId
        : previous.stagePaneId;
    return {
      ...partial,
      focusedPaneId:
        requestedFocus && liveIds.has(requestedFocus)
          ? requestedFocus
          : (live[0]?.id ?? null),
      maximizedPaneId:
        requestedZoom && liveIds.has(requestedZoom) ? requestedZoom : null,
      stagePaneId:
        requestedStagePane && liveIds.has(requestedStagePane)
          ? requestedStagePane
          : null,
    };
  }
  // I6 runs FIRST: the panes read below must already be residue-free, or a
  // surviving vacancy would be re-published carrying a dead session's output.
  const proposedRoot = bindMissionSpaces(rootWithoutVacancyResidue(partial.root));
  const proposed = listPanes(proposedRoot);
  const durable = proposed.filter((pane) => !isStructuralPlaceholderPane(pane));
  const reclaimsVacancy = durable.length > 0 && durable.length < proposed.length;
  if (reclaimsVacancy) {
    console.info(
      `[layout] dropped ${proposed.length - durable.length} structural placeholder(s) beside ${durable.length} live pane(s)`,
    );
  }
  const root = reclaimsVacancy ? buildGridTree(durable) : proposedRoot;
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

  const requestedZoom =
    partial.maximizedPaneId !== undefined
      ? partial.maximizedPaneId
      : previous.maximizedPaneId;
  // F-521: zoom não cai mais só porque o write ganhou panes — só se o write
  // pedir explicitamente (null) ou o pane maximizado sair da árvore.
  const maximizedPaneId =
    requestedZoom && liveIds.has(requestedZoom) ? requestedZoom : null;

  const requestedStagePane =
    partial.stagePaneId !== undefined
      ? partial.stagePaneId
      : previous.stagePaneId;
  const stagePaneId =
    requestedStagePane && liveIds.has(requestedStagePane)
      ? requestedStagePane
      : null;

  return { ...partial, root, focusedPaneId, maximizedPaneId, stagePaneId };
}

/**
 * Uma coroa só POR ABA entre os panes que o operador governa, e ninguém muda
 * de aba por causa dela. Antes de coroar `leaderId`:
 *  - os panes soltos (sem espaço e sem missão) que hoje moram num espaço só
 *    porque o coordenador local está lá ganham o carimbo desse espaço — a casa
 *    deles não pode depender de qual coordenador vem primeiro na árvore;
 *  - as outras coroas sem missão do MESMO escopo viram worker. Panes de
 *    missão ficam de fora — a estrela deles é do Main.
 */
function crownLocalLeader(
  root: LayoutNode,
  leaderId: string,
  paneMissions: Readonly<Record<string, string>>,
): LayoutNode {
  const panes = listPanes(root);
  const leader = panes.find((pane) => pane.id === leaderId);
  if (!leader) return root;
  const scopeOf = paneScopeResolver(panes, paneMissions);
  const targetScope = scopeOf(leader);
  const unbound = (pane: PaneModel): boolean => !(pane.missionId ?? paneMissions[pane.id]);
  let next = root;
  for (const pane of panes) {
    if (pane.spaceId || !unbound(pane)) continue;
    const spaceId = spaceIdOfScopeKey(scopeOf(pane));
    if (!spaceId) continue;
    const sibling = panes.find((candidate) => candidate.spaceId === spaceId);
    next = updatePane(next, pane.id, {
      spaceId,
      spaceTitle: sibling?.spaceTitle,
      isolateSpace: sibling?.isolateSpace,
    });
  }
  for (const pane of panes) {
    if (pane.id === leaderId || pane.role !== 'orchestrator' || !unbound(pane)) continue;
    if (scopeOf(pane) !== targetScope) continue;
    next = updatePane(next, pane.id, { role: 'worker' });
  }
  return next;
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
  stageFocusMode: false,
  stagePaneId: null,
  hydrated: false,

  split: (paneId, direction) => {
    // O irmão HERDA o espaço de quem foi dividido (F-560). Sem isto, dividir um
    // painel de "Meus terminais 2" cuspia o novo pane na aba dos soltos — o
    // operador dividia a tela e metade dela sumia da vista em que estava.
    // Missão não se herda por split: papel de missão é concedido pelo main.
    const source = listPanes(get().root).find((pane) => pane.id === paneId);
    // O vínculo OBSERVADO conta tanto quanto o gravado: um pane que só está em
    // orch-store.paneMissions é tratado como pane de missão pela aba, então o
    // irmão dele não pode herdar um espaço antigo e aparecer noutro lugar.
    const sourceHasMission = Boolean(
      source?.missionId ?? useOrchStore.getState().paneMissions[paneId],
    );
    const inheritedSpace =
      (!sourceHasMission || source?.isolateSpace) && source?.spaceId
        ? { spaceId: source.spaceId, spaceTitle: source.spaceTitle, isolateSpace: source.isolateSpace }
        : {};
    const newPane: PaneModel = {
      ...createPane('shell', getActiveWorkspacePath() ?? undefined),
      ...inheritedSpace,
    };
    // Splitting the placeholder IS using it — claim it so the vacancy rule
    // does not reclaim the terminal the operator just asked to keep.
    const claimed = claimPlaceholderTarget(get().root, paneId);
    const root = splitPane(claimed, paneId, direction, newPane);
    bumpTreeVersion();
    // Split é interação DIRETA do operador com o pane ampliado: o resultado
    // tem que aparecer. Sem o null explícito, o invariante F-521 manteria o
    // zoom e montaria a metade nova invisível com o foco dentro dela.
    set({ root, focusedPaneId: newPane.id, maximizedPaneId: null });
    persist();
  },

  spawnOrchPane: (req) => {
    const { root: currentRoot, focusedPaneId, maximizedPaneId } = get();
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
    // O id descartado por `createPane` devolve o número à fila antes de o id
    // real reivindicar o dele: sem isto cada spawn de orquestração queimaria um
    // número para sempre, e o operador subiria para "pane 40" com 6 panes na
    // tela. O registro é o MESMO — nunca existem dois numeradores.
    if (req.paneId !== base.id) releasePaneNumber(base.id);
    // Helper aberto por agente do operador nasce na aba do pai — mesma regra
    // do split (F-560): missão não se herda, e pane de missão não herda aba.
    const parent = req.parentPaneId
      ? existingPanes.find((pane) => pane.id === req.parentPaneId)
      : undefined;
    const parentHasMission = Boolean(
      parent && (parent.missionId ?? useOrchStore.getState().paneMissions[parent.id]),
    );
    const inheritedSpace =
      parent?.spaceId && !parentHasMission && !req.missionId
        ? { spaceId: parent.spaceId, spaceTitle: parent.spaceTitle, isolateSpace: parent.isolateSpace }
        : {};
    const newPane: PaneModel = {
      ...base,
      id: req.paneId,
      paneNumber: claimPaneNumber(req.paneId),
      title: req.title ?? base.title,
      accountId: req.accountId,
      effort: req.effort,
      orchRequestId: req.orchRequestId,
      missionId: req.missionId,
      transient: req.transient,
      agentName: req.agentName,
      role: req.role,
      ...inheritedSpace,
      ...(req.spawnRoute ? { spawnRoute: req.spawnRoute } : {}),
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

    bumpTreeVersion();
    const livePanes = listPanes(root);
    // Modo foco (F-521): com um pane ampliado ATIVO (o operador colocou o
    // orquestrador em foco), o worker novo NÃO rouba o foco nem derruba o
    // zoom — o orquestrador permanece em foco e o worker entra no grid por
    // trás.
    const keepMaximize =
      maximizedPaneId !== null &&
      livePanes.some((pane) => pane.id === maximizedPaneId);
    // Worker (helper ou worker de missão) aberto por agente é trabalho de
    // fundo: o foco fica onde o operador está, e com ele a aba — o
    // TerminalWorkspace segue focusedPaneId até o escopo do pane. Mesma regra
    // de focusFreshlyPresentedPane (orch-bridge), onde worker nunca toma foco.
    // Orquestrador novo e grade sem foco vivo mantêm o legado: foco no pane
    // recém-apresentado, que também encerra qualquer maximize stale.
    const keepFocus =
      keepMaximize ||
      ((req.role ?? 'worker') === 'worker' &&
        focusedPaneId !== null &&
        livePanes.some((pane) => pane.id === focusedPaneId));
    set({
      root,
      focusedPaneId: keepFocus ? focusedPaneId : newPane.id,
      maximizedPaneId: keepMaximize ? maximizedPaneId : null,
    });
    persist();
    return newPane.id;
  },

  addShellPane: (options) => {
    const {
      root: currentRoot,
      focusedPaneId,
      maximizedPaneId,
    } = get();
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
    bumpTreeVersion();
    const focusNewPane = options?.focus !== false;
    set({
      root,
      focusedPaneId: focusNewPane ? newPane.id : focusedPaneId,
      maximizedPaneId: focusNewPane ? null : maximizedPaneId,
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
    const currentFocusedId = get().focusedPaneId;
    const focusedPaneId =
      currentFocusedId && capped.some((pane) => pane.id === currentFocusedId)
        ? currentFocusedId
        : capped[0]!.id;
    bumpTreeVersion();
    // Substituição deliberada do grid (retomada/apresentação de missão, Modo
    // Livre) encerra qualquer zoom de pane único: um maximize stale deixava o
    // pane ampliado (às vezes um shell vazio) cobrindo os panes recém-montados.
    set({ root, focusedPaneId, maximizedPaneId: null });
    persist();
  },

  spawnAgent: (adapterId, model, options) => {
    const { focusedPaneId: targetId, root: currentRoot } = get();
    if (listPanes(currentRoot).length >= MAX_LIVE_PANES_HARD) {
      console.warn(
        `[layout] refuse spawnAgent (hard=${MAX_LIVE_PANES_HARD}) adapter=${adapterId}`,
      );
      return undefined;
    }
    const newPane: PaneModel = {
      ...createPane(
        'cli-agent',
        getActiveWorkspacePath() ?? undefined,
        adapterId,
        model,
      ),
      // Só grava quando o operador escolheu a conta: `accountId: undefined`
      // no modelo persistido não é a mesma coisa que a chave ausente.
      ...(options?.accountId ? { accountId: options.accountId } : {}),
      ...(options?.effort ? { effort: options.effort } : {}),
    };
    // Continuity is a fresh-session prompt, never missionId on this pane
    // (Main would reject stale persisted mission authority).
    if (options?.continuityPack) {
      stashPendingContinuity(newPane.id, options.continuityPack);
    }
    const pivotId = targetId ?? firstPaneId(currentRoot);
    // splitPane com pivô fora da árvore é no-op silencioso — sem a garantia o
    // id devolvido seria de um pane que não existe (mesmo contrato de
    // addShellPane/addBrowserPane via rootWithPaneGuaranteed).
    const root = pivotId
      ? rootWithPaneGuaranteed(
          splitPane(currentRoot, pivotId, 'row', newPane),
          currentRoot,
          newPane,
        )
      : splitPane(initialTree(), firstPaneId(initialTree()) ?? '', 'row', newPane);

    const focusedPaneId = newPane.id;
    bumpTreeVersion();
    set({
      root,
      focusedPaneId,
      maximizedPaneId: null,
    });
    persist();
    return newPane.id;
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
    const stageFocusMode = afterCount <= 1 ? false : get().stageFocusMode;
    const stagePaneId =
      afterCount <= 1
        ? null
        : get().stagePaneId === paneId
          ? (firstPaneId(root) ?? null)
          : get().stagePaneId;
    bumpTreeVersion();
    set({ root, focusedPaneId, maximizedPaneId, stageFocusMode, stagePaneId });
    persist();
    // The tree cannot be empty, so closing the final pane leaves the canonical
    // structural vacancy in place. Product navigation is the sole visible
    // authority: Terminal keeps showing the actionable vacancy, while closing
    // a runtime pane from Settings, Memory, Task Board, Setup, or Mission Board
    // must not eject the operator from that destination.
    // A live Main-owned mission that loses its last visible pane keeps running
    // in the background; the notification offers recovery without taking over
    // the current product destination.
    const closedPane = before.find((pane) => pane.id === paneId);
    if (closedPane) {
      notifyIfLastMissionPaneClosed(closedPane, reason, listPanes(root));
    }
    // Libera DEPOIS do aviso — a notificação ainda cita o pane que morreu.
    // O número volta para a fila: o próximo pane recebe o MENOR livre, para o
    // operador seguir falando números curtos em vez de "pane 312". Enquanto o
    // pane vive o número é só dele; citar o número de um pane já fechado é
    // recusado com a lista dos válidos, nunca redirecionado para outro pane.
    releasePaneNumber(paneId);
  },

  toggleMaximizePane: (paneId) => {
    const exists = listPanes(get().root).some((pane) => pane.id === paneId);
    if (!exists) return;
    const maximizedPaneId = get().maximizedPaneId === paneId ? null : paneId;
    set({ maximizedPaneId, focusedPaneId: paneId });
  },

  toggleStageFocus: (paneId) => {
    const all = listPanes(get().root);
    if (all.length <= 1) {
      if (get().stageFocusMode) {
        set({ stageFocusMode: false, stagePaneId: null });
      }
      return;
    }
    const targetId = paneId ?? get().stagePaneId ?? get().focusedPaneId ?? all[0]?.id;
    if (!targetId) return;
    const exists = all.some((pane) => pane.id === targetId);
    if (!exists) return;
    const nextMode = !get().stageFocusMode;
    set({
      stageFocusMode: nextMode,
      stagePaneId: nextMode ? targetId : null,
      focusedPaneId: targetId,
      maximizedPaneId: null,
    });
  },

  setStagePane: (paneId) => {
    const exists = listPanes(get().root).some((pane) => pane.id === paneId);
    if (!exists) return;
    set({ stagePaneId: paneId, focusedPaneId: paneId });
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
    const { root: currentRoot, focusedPaneId } = get();
    if (paneId && listPanes(currentRoot).some((pane) => pane.id === paneId)) {
      throw new Error(`browser pane identity already exists: ${paneId}`);
    }
    const base = createPane('browser', getActiveWorkspacePath() ?? undefined);
    // Pane de posse do Main chega com id próprio, e o número TEM de seguir o id
    // real. Herdar o número que `createPane` reservou para o id descartado faria
    // "pane N" resolver para um pane que não existe — exatamente o erro que a
    // numeração existe para impedir. Libera o descartado, reivindica pelo real.
    if (paneId && paneId !== base.id) releasePaneNumber(base.id);
    const newPane: PaneModel = {
      ...base,
      ...(paneId ? { id: paneId, paneNumber: claimPaneNumber(paneId) } : {}),
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
    bumpTreeVersion();
    set({
      root,
      focusedPaneId: newPane.id,
      maximizedPaneId: null,
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

  setPaneModel: (paneId, model) => {
    const root = updatePane(get().root, paneId, { model });
    set({ root });
    persist();
  },

  setPaneCwd: (paneId, cwd) => {
    const root = updatePane(get().root, paneId, { cwd });
    set({ root });
    persist();
  },

  syncMissionSpaces: () => {
    const root = bindMissionSpaces(get().root);
    if (root === get().root) return;
    set({ root });
    persist();
  },

  assignPaneSpace: (paneId, spaceId, spaceTitle, isolated = false) => {
    const pane = listPanes(get().root).find((item) => item.id === paneId);
    // Missão vence espaço: um pane já adotado por uma missão não é recarimbado
    // aqui, senão ele sairia da aba da missão que lidera.
    if (!pane || pane.missionId) return;
    const isolateSpace = isolated || listPanes(get().root).some((p) => p.spaceId === spaceId && p.isolateSpace);
    const root = updatePane(get().root, paneId, { spaceId, spaceTitle, isolateSpace: isolateSpace ? true : undefined });
    set({ root });
    persist();
  },

  renamePaneSpace: (spaceId, title) => {
    const clean = title.trim();
    if (!clean) return;
    let root = get().root;
    let changed = false;
    for (const pane of listPanes(root)) {
      // Mesma fronteira do assignPaneSpace: o carimbo de espaço do pane já
      // adotado por missão é inerte e a aba dele é a da missão — reescrevê-lo
      // faria o espaço "voltar" num pane que o operador vê na missão. O
      // anfitrião é a exceção: a missão mora na aba dele, o nome é da aba.
      if (pane.spaceId !== spaceId || (pane.missionId && !pane.missionHost)) continue;
      if (pane.spaceTitle === clean) continue;
      root = updatePane(root, pane.id, { spaceTitle: clean });
      changed = true;
    }
    if (!changed) return;
    set({ root });
    persist();
  },

  nameLooseSpace: (spaceId, title) => {
    const clean = title.trim();
    if (!clean) return false;
    let root = get().root;
    let changed = false;
    for (const pane of listPanes(root)) {
      // Os membros da aba "Terminais": sem espaço e sem missão própria — o
      // anfitrião entra (a missão dele mora nesta aba e vai junto).
      if (pane.spaceId || (pane.missionId && !pane.missionHost)) continue;
      if (pane.isStructuralPlaceholder || pane.transient) continue;
      root = updatePane(root, pane.id, { spaceId, spaceTitle: clean });
      changed = true;
    }
    if (!changed) return false;
    set({ root });
    persist();
    return true;
  },

  reflectMissionLeader: (missionId, leaderPaneId) => {
    const panes = listPanes(get().root);
    // Classificação = vínculo GRAVADO ou o observado do orch-store. Ler só o
    // gravado deixaria de fora o pane que a aba já mostra como da missão.
    const belongsToMission = (pane: PaneModel): boolean =>
      pane.missionId === missionId ||
      (!pane.missionId &&
        useOrchStore.getState().paneMissions[pane.id] === missionId);
    let root = get().root;
    let changed = false;
    // Adoção de um pane do operador: a coroa local que a aba já tinha sai, ou
    // a aba ficaria com duas (e o indicador poderia apontar a errada).
    // O broadcast do Main já pode ter vinculado o pane à missão: a aba dele é
    // a de ANTES da adoção.
    const adopted = panes.find(
      (pane) => pane.id === leaderPaneId && pane.missionId === undefined,
    );
    if (adopted) {
      const { [adopted.id]: _adopting, ...paneMissions } = useOrchStore.getState().paneMissions;
      const crowned = crownLocalLeader(root, adopted.id, paneMissions);
      changed = crowned !== root;
      root = crowned;
    }
    const released: string[] = [];
    for (const pane of panes) {
      const isLeader = leaderPaneId !== null && pane.id === leaderPaneId;
      // F-527: o líder nomeado é promovido mesmo sem vínculo prévio (é a
      // adoção); os demais só entram na conta se já forem DESTA missão. Panes
      // soltos (shells do operador, outra missão) nunca são tocados.
      if (!isLeader && !belongsToMission(pane)) continue;
      // Coroa foi para outro pane: o anfitrião adotado volta a ser a mão do
      // operador (o Main já o devolveu a `user`), não um worker da missão.
      if (!isLeader && leaderPaneId !== null && pane.missionHost) {
        root = updatePane(root, pane.id, {
          role: undefined,
          missionId: undefined,
          missionHost: undefined,
        });
        released.push(pane.id);
        changed = true;
        continue;
      }
      const needsWrite = isLeader
        ? pane.role !== 'orchestrator' || pane.missionId === undefined
        : pane.role !== 'worker';
      if (!needsWrite) continue;
      root = isLeader
        ? updatePane(root, pane.id, {
            role: 'orchestrator',
            missionId: pane.missionId ?? missionId,
            // Adoção de um pane que não era de missão nenhuma: a missão passa a
            // morar na aba DELE (a aba é a feature). O pane que o motor abriu
            // para a missão já nasce com missionId e não hospeda nada.
            ...(pane.missionId === undefined ? { missionHost: true as const } : {}),
          })
        : updatePane(root, pane.id, { role: 'worker' });
      changed = true;
    }
    // Replay do mesmo snapshot: nada mudou, nada é escrito.
    if (!changed) return;
    // Antes do set: bindMissionSpaces re-carimbaria o anfitrião pelo índice.
    for (const paneId of released) useOrchStore.getState().unbindPaneMission(paneId, missionId);
    set({ root });
    persist();
  },

  promoteMissionPaneRole: (missionId, paneId) => {
    // Delega: promover X é o caso particular de "o Main confirmou X" com um só
    // membro. Manter a eleição aqui era o que deixava o layout discordar do
    // Main quando os dois lados escolhiam panes diferentes.
    get().reflectMissionLeader(missionId, paneId);
  },

  setPaneRole: (paneId, role) => {
    const panes = listPanes(get().root);
    const target = panes.find((pane) => pane.id === paneId);
    if (!target) return;
    // Papel de MISSÃO é do Main. Um pane que já pertence a uma missão não pode
    // ganhar nem perder estrela por aqui: era este caminho que elegia líder
    // localmente (e, no demote global, apagava a estrela de OUTRA missão).
    if (
      target.missionId ||
      useOrchStore.getState().paneMissions[paneId]
    ) {
      return;
    }
    let root = get().root;
    if (role === 'orchestrator') {
      // Rebaixar em todas as abas era o "promover na aba B troca o
      // orquestrador geral": o coordenador da aba A perdia a coroa.
      root = crownLocalLeader(root, paneId, useOrchStore.getState().paneMissions);
    }
    root = updatePane(root, paneId, { role });
    set({ root });
    persist();
  },

  reclaimAsOperatorShell: (paneId) => {
    const pane = listPanes(get().root).find((candidate) => candidate.id === paneId);
    if (!pane) return null;
    const root = updatePane(get().root, paneId, {
      kind: 'shell',
      adapterId: undefined,
      model: undefined,
      role: undefined,
      missionId: undefined,
      orchRequestId: undefined,
      agentName: undefined,
      title: 'shell',
    });
    set({ root });
    persist();
    return listPanes(root).find((candidate) => candidate.id === paneId) ?? null;
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
    const outgoing = options.outgoingPaneIds;
    const carried =
      options.preserveLiveMissionPanes === true
        ? listPanes(get().root).filter(
            (pane) =>
              pane.missionId !== undefined && !outgoing?.has(pane.id),
          )
        : [];
    if (!layout) {
      const restored = initialTree();
      const bare =
        carried.length > 0 ? buildGridTree(carried) : restored;
      // Re-semeia a numeração para ESTE workspace: sem isto o registro
      // continuaria com os números do workspace anterior e o operador leria no
      // header um número que aponta para um pane que não está mais na tela.
      //
      // Só os panes CARREGADOS (missão viva que atravessa a troca) trazem
      // número legítimo. O placeholder que `initialTree` acabou de criar pegou
      // o menor livre do registro do workspace que está SAINDO; deixá-lo entrar
      // no seed faria um workspace novo e vazio abrir em "pane 4". Ele
      // reivindica do zero.
      const carriedIds = new Set(carried.map((pane) => pane.id));
      const seeds = listPanes(bare).map((pane) =>
        carriedIds.has(pane.id) ? pane : { ...pane, paneNumber: undefined },
      );
      const root = withPaneNumbers(bare, hydratePaneNumbers(seeds));
      set({
        root,
        focusedPaneId: firstPaneId(root),
        maximizedPaneId: null,
        hydrated: true,
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
    const bare =
      survivors.length > 0
        ? buildGridTree([...restoredPanes, ...survivors])
        : durableLayout.root;
    // O número SOBREVIVE AO RESTART aqui: o layout persistido guarda
    // `paneNumber` por pane, e `hydratePaneNumbers` devolve exatamente aquele
    // número ao mesmo pane. Layout gravado antes da numeração existir chega sem
    // o campo e recebe o menor livre — workspace antigo abre normal.
    const root = withPaneNumbers(bare, hydratePaneNumbers(listPanes(bare)));
    // Zoom é volátil (não faz parte do layout persistido) e o restore não é
    // intenção de zoom: encerra explicitamente. Desde a F-521 o invariante
    // mantém o zoom em writes que ganham panes — sem o null explícito, panes
    // restaurados montariam vivos por trás do zoom do estado anterior.
    set({
      root,
      focusedPaneId:
        durableLayout.focusedPaneId ?? firstPaneId(durableLayout.root),
      maximizedPaneId: null,
      hydrated: true,
    });
  },
  };
});

// Mission metadata can arrive after the first pane presentation. Persist the
// same association in either arrival order, without rebuilding grid geometry.
useOrchStore.subscribe((state, previous) => {
  if (state.missions !== previous.missions || state.paneMissions !== previous.paneMissions) {
    useLayoutStore.getState().syncMissionSpaces();
  }
});
