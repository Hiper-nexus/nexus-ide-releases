/**
 * Catalog / browser / design / layout / PTY payload types shared across IPC.
 * Extracted from types.ts for the Akita ~800-line module budget.
 */
import type {
  BrowserDesignAnnotationIntent,
  BrowserDesignAnnotationPriority,
  BrowserDesignAnnotationSummary,
  BrowserDesignEvent,
} from './browser-design';

/** One locally installed catalog component / plugin file / hook home. */
export interface InstalledItemInfo {
  kind: string;
  name: string;
  file: string;
  size: number;
  modifiedAt: number;
}

/** Arsenal enriquecido (harness-enrich): tier + blurb por item instalado. */
export type HarnessTier = 'scout' | 'builder' | 'reviewer';

export interface EnrichedCatalogItem {
  name: string;
  kind: 'agent' | 'skill';
  tier: HarnessTier;
  blurb: string;
  whenToUse?: string;
}

export interface EnrichedCatalogInfo {
  version: 1;
  updatedAt: number;
  items: EnrichedCatalogItem[];
}

/** One browsable aitmpl catalog component. */
export interface CatalogEntryInfo {
  kind: 'agent' | 'skill';
  slug: string;
  name: string;
  category: string;
}

export interface CatalogIndexResult {
  ok: boolean;
  index?: {
    fetchedAt: number;
    agents: CatalogEntryInfo[];
    skills: CatalogEntryInfo[];
  };
  error?: string;
}

/** Contract for the catalog-install tool (skip-if-exists). */
export interface CatalogInstallResult {
  ok: boolean;
  skipped?: boolean;
  installed?: { name: string; path: string };
  error?: string;
}

export interface DesignSystemImportRequest {
  identifier: string;
  targetPath?: string;
}

export type DesignSystemImportResult =
  | {
      ok: true;
      draftId: string;
      targetPath: string;
      status: string;
      evidencePath: string;
    }
  | { ok: false; error: string };

export interface NativeToolInfo {
  name: string;
  description: string;
}

export interface BrowserPaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
}

export interface BrowserPaneState {
  paneId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error?: string;
}

export interface BrowserScreenshotResult {
  artifactId: string;
  projectId: string;
  checkoutId: string;
  paneId: string;
  path: string;
  storageKey: string;
  sha256: string;
  width: number;
  height: number;
  url: string;
  title: string;
  capturedAt: number;
}

/** Dev server announced by a PTY pane's output (VISUAL-EDIT-001, F1.5). */
export interface DevServerDetectedPayload {
  paneId: string | null;
  sessionId: string;
  url: string;
  urls: string[];
  detectedAt: number;
}

/** Deterministic write-back status (VISUAL-EDIT-001, F3). */
export interface DesignWritebackStatusPayload {
  enabled: boolean;
  active: boolean;
  styleMode: 'tailwind' | 'inline';
  canUndo: boolean;
  canRedo: boolean;
  /** Main-verified mission/PREVC authority for direct filesystem effects. */
  authorityReady: boolean;
  authorityError?: string;
}

export interface DesignMissionBindingPayload {
  browserPaneId: string;
  paneId: string;
  missionId: string;
}

export type DesignWritebackActionPayload =
  | { kind: 'style'; nexusId: string; styles: Record<string, string> }
  | { kind: 'text'; nexusId: string; text: string }
  | { kind: 'move'; nexusId: string; direction: 'up' | 'down' }
  | {
      kind: 'reorder';
      parentNexusId: string;
      fromIndex: number;
      toIndex: number;
    }
  | { kind: 'delete'; nexusId: string }
  | { kind: 'duplicate'; nexusId: string };

export interface DesignActionResultPayload {
  ok: true;
  file: string;
  kind: string;
}

export interface BrowserDesignEventPayload {
  paneId: string;
  event: BrowserDesignEvent;
}

export interface BrowserDesignSendPayload {
  targetPaneId: string;
  instruction?: string;
  dir?: string;
  styleDiff?: Record<string, { from: string; to: string }>;
  intent?: 'context' | 'clone';
  /** Prepare the prompt without injecting into the target PTY (for clipboard copy). */
  dryRun?: boolean;
}

export interface BrowserDesignSendResult {
  ok: true;
  targetPaneId: string;
  targetSessionId: string;
  promptChars: number;
  screenshotPath?: string;
  /** Present only when dryRun=true: the formatted prompt, for clipboard copy. */
  prompt?: string;
  /** True when a workspace DESIGN.md was attached as design-system context. */
  designSystemAttached?: boolean;
}

export interface BrowserDesignAnnotatePayload {
  comment: string;
  intent: BrowserDesignAnnotationIntent;
  priority?: BrowserDesignAnnotationPriority;
}

export interface BrowserDesignAnnotationsResult {
  paneId: string;
  annotations: BrowserDesignAnnotationSummary[];
}

export interface BrowserDesignAnnotationsSendPayload {
  /** Required for a real send; a dry run (clipboard copy) needs no target. */
  targetPaneId?: string;
  dir?: string;
  /** Prepare the prompt without injecting into the target PTY (for clipboard copy). */
  dryRun?: boolean;
}

export interface BrowserDesignAnnotationsSendResult {
  ok: true;
  /** Empty string on a targetless dry run. */
  targetPaneId: string;
  targetSessionId: string;
  promptChars: number;
  annotations: number;
  /** Present only when dryRun=true: the formatted prompt, for clipboard copy. */
  prompt?: string;
  /** True when a workspace DESIGN.md was attached as design-system context. */
  designSystemAttached?: boolean;
}

export interface PerfSnapshot {
  capturedAt: number;
  process: {
    pid: number;
    platform: NodeJS.Platform;
    arch: string;
    uptimeSec: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  appMetrics: Array<{
    pid: number;
    type: string;
    memory: {
      workingSetSize: number;
      peakWorkingSetSize: number;
      privateBytes: number;
      sharedBytes: number;
    };
    cpu: {
      percentCPUUsage: number;
      idleWakeupsPerSecond: number;
    };
  }>;
  panes: {
    livePtySessions: number;
    browserViews: number;
  };
}

export interface RecipeLintIssue {
  severity: 'error' | 'warning';
  squadId: string;
  squadName: string;
  agentId?: string;
  agentName?: string;
  field: 'allowedTools' | 'allowedSkills';
  ref: string;
  message: string;
}

export interface RecipeOverlayResult {
  ok: boolean;
  checkedAt: number;
  stacks: string[];
  overlay?: CatalogOverlayState;
  suggestions?: RecipeSuggestion[];
  categories: Record<string, number>;
  issues: RecipeLintIssue[];
}

export interface CatalogOverlayState {
  workspacePath?: string;
  stacks: string[];
  disabled: string[];
  tombstones: string[];
  categories: Record<string, string>;
  updatedAt: number;
}

export interface CatalogOverlayPatch {
  stacks?: string[];
  disabled?: string[];
  tombstones?: string[];
  categories?: Record<string, string>;
}

export interface RecipeSuggestion {
  id: string;
  title: string;
  stacks: string[];
  agents: string[];
  tools: string[];
  gaps: string[];
}

export interface AgentSpecWriteRequest {
  name: string;
  tools?: string[];
  skills?: string[];
  model?: string;
  effort?: string;
  category?: string;
  systemPrompt?: string;
}

/**
 * The kind of process backing a pane. `shell` uses the user's default shell;
 * `cli-agent` spawns an AI CLI via a declarative adapter JSON; `browser`
 * is a main-process WebContentsView, never a PTY session.
 */
export type PaneKind = 'shell' | 'cli-agent' | 'browser';
export type SessionKind = 'shell' | 'cli-agent';

export type SplitDirection = 'row' | 'column';

/** A single terminal pane (a leaf in the layout tree). */
export interface PaneModel {
  id: string;
  kind: PaneKind;
  title: string;
  /**
   * Renderer-owned empty-state shell. Automated presentation may replace this
   * pane only while the marker is present; opening the terminal claims it for
   * the operator and clears the marker.
   */
  isStructuralPlaceholder?: true;
  cwd?: string;
  /** Initial/current URL for browser panes. */
  browserUrl?: string;
  /**
   * Main-minted identity of the browser-open attempt that created this pane.
   * Automated cleanup must match this seal as well as the pane id.
   */
  browserOpenRequestId?: string;
  /** Set for cli-agent panes — identifies which adapter backs this pane. */
  adapterId?: string;
  /** The model selected for this agent pane (e.g. "claude-sonnet-4-5"). */
  model?: string;
  /** Account pinned to this pane; absent means the provider's active/default. */
  accountId?: string;
  /** Papel na missão (orquestração) — vira o badge de identidade do pane. */
  role?: 'orchestrator' | 'worker';
  /** Agente do squad operando este pane (ex.: "Frontend"). */
  agentName?: string;
  /**
   * Per-pane reasoning effort override (task-router decision). Falls back to
   * the provider's configured effort when absent; silently ignored by CLIs
   * whose adapter declares no effort levels.
   */
  effort?: string;
  /** User renamed this pane → ignore the shell's OSC title escapes. */
  titlePinned?: boolean;
  /**
   * Present when the pane was requested by the orchestration layer (MCP
   * pane_spawn). Correlates the eventual PTY spawn with the pending skill-gate
   * context minted for that request.
   */
  orchRequestId?: string;
  /** Mission selector for a main-verified post-approval orchestrator spawn. */
  missionId?: string;
  /**
   * Process-local orchestration surface. It may be visible while active but
   * must never enter the durable workspace layout or cold-start restore.
   */
  transient?: true;
  /** Bounded ANSI snapshot used only to repaint scrollback after a cold restart. */
  terminalScrollback?: string;
}

/**
 * Recursive binary layout tree. A leaf hosts one pane; a split holds exactly
 * two children arranged along a direction. Splitting a pane replaces its leaf
 * with a split node; closing a pane collapses the split back to its sibling.
 */
export type LayoutNode =
  | { kind: 'leaf'; id: string; pane: PaneModel }
  | {
      kind: 'split';
      id: string;
      direction: SplitDirection;
      children: [LayoutNode, LayoutNode];
    };

export type ViewKind = 'grid' | 'canvas';

/** Position/size of one pane in the infinite canvas. */
export interface CanvasNodeLayout {
  position: { x: number; y: number };
  size: { width: number; height: number };
  z: number;
}

export interface WorkspaceLayout {
  root: LayoutNode;
  focusedPaneId: string | null;
  /** Active view: grid (default) or infinite canvas. */
  viewKind?: ViewKind;
  /** Per-pane canvas position+size, keyed by paneId. */
  canvasNodeLayouts?: Record<string, CanvasNodeLayout>;
  /** Last canvas viewport (x, y, zoom) for restore. */
  canvasViewport?: { x: number; y: number; zoom: number };
}

/** Payload to open a PTY session for a pane. */
export interface SpawnRequest {
  cwd?: string;
  shell?: string;
  cols: number;
  rows: number;
  kind: SessionKind;
  /** Present when kind === 'cli-agent'. */
  adapterId?: string;
  /** Present when kind === 'cli-agent'. Falls back to adapter's default model. */
  model?: string;
  /** Optional per-pane account; validated against adapter ownership in main. */
  accountId?: string;
  /** Correlates an orchestration-requested spawn with its gate context. */
  orchRequestId?: string;
  /** Main verifies this mission has a current approved dispatch contract. */
  missionId?: string;
  /** Re-spawn continuing the previous conversation (adapter resumeArgs). */
  resume?: boolean;
  /** Skip a stale captured id and use the adapter's latest-session fallback. */
  resumeLatestOnly?: boolean;
  /**
   * Start a new provider conversation while restoring the main-owned authority
   * of this exact persisted mission pane. The main process still resolves the
   * pane spec by owner + workspace + paneId; the renderer cannot invent it.
   */
  restorePersistedAuthority?: boolean;
  /**
   * Pane dono do spawn (estável entre boots — vem do layout persistido).
   * Com ele + resume, o main retoma a sessão de provider CAPTURADA daquele
   * pane (`--resume <id>`) em vez do genérico `--continue`, que faria todos
   * os panes do workspace retomarem a MESMA última conversa.
   */
  paneId?: string;
  /** Per-spawn reasoning effort override (wins over the provider setting). */
  effort?: string;
}

export type SpawnResult =
  | {
      ok: true;
      sessionId: string;
      resumeMode?: 'exact' | 'latest' | 'unsupported';
      /** Existing main-owned mission PTY was attached; no provider restart. */
      adopted?: boolean;
      /** Current state snapshot for an adopted session (push may predate listeners). */
      state?: PaneSessionState;
    }
  | { ok: false; error: string };

export interface PtyDataEvent {
  sessionId: string;
  data: string;
  sequence: number;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
}

// 'exited'/'hibernated' são setados pelo renderer — o agente morreu/dormiu e o
// usuário precisa VER isso no toolbar, não descobrir pelo terminal mudo.
export type PaneSessionState =
  | 'spawning'
  | 'busy'
  | 'idle'
  | 'exited'
  | 'hibernated';

export interface PtyStateChangeEvent {
  sessionId: string;
  state: PaneSessionState;
}

/** Unsubscribe handle returned by the event subscription helpers. */
export type Unsubscribe = () => void;
