import type { LicenseErrorCode, LicenseDenialReason } from './license-errors';
import type { SpawnRouteInfo } from './spawn-route';
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

/**
 * F-757: área da stack que os arquivos do projeto provaram. `evidence` é o
 * caminho relativo do arquivo que a provou: só aparece na tela, nunca vai ao
 * modelo de decisão.
 */
export interface CatalogProjectArea {
  id: string;
  label: string;
  evidence: string;
}

/** Item do catálogo que o modelo de decisão escolheu para uma ou mais áreas. */
export interface CatalogRecommendation {
  kind: 'agent' | 'skill';
  slug: string;
  name: string;
  category: string;
  /** Rótulos das áreas em que ele foi escolhido. */
  areas: string[];
  /** Arquivos que provaram essas áreas (mesma ordem de `areas`). */
  evidence: string[];
  /** Confiança da escolha (0..1, 2 casas). */
  confidence: number;
}

export interface CatalogRecommendationsResult {
  ok: boolean;
  /** Por que não há lista. */
  reason?: 'disabled' | 'no-credential' | 'no-areas' | 'catalog-unavailable' | 'no-answer';
  areas?: CatalogProjectArea[];
  recommendations?: CatalogRecommendation[];
  /** Quem decidiu. */
  provider?: 'jev' | 'clef';
  decidedAt?: number;
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

/**
 * Mirrors `DESIGN_KIT_SOURCES` in src/main/design/design-kit-source.ts. Kept in
 * step by a compile-time assertion in
 * src/main/orch/design-system-import-fallback.test.ts.
 */
export type DesignSystemSourceId = 'local-catalog' | 'getdesign' | 'designmd.ai';

export interface DesignSystemImportAttempt {
  sourceId: DesignSystemSourceId;
  ok: boolean;
  /** Why this source did not serve; null when it did. */
  detail: string | null;
}

export type DesignSystemImportResult =
  | {
      ok: true;
      draftId: string;
      targetPath: string;
      status: string;
      evidencePath: string;
      /**
       * Which source actually produced the draft. designmd.ai answers 401
       * without `external:designmd-api-key`, so the import walks down to the
       * keyless sources — the operator must never be told "imported" without
       * being told from where.
       */
      servedBy: DesignSystemSourceId;
      /** Every source tried, in order, with the reason each one did not serve. */
      attempts: DesignSystemImportAttempt[];
      /** Present on keyless imports: the kit and content that were read. */
      sourceId?: DesignSystemSourceId;
      kitId?: string;
      contentHash?: string;
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
    /**
     * F-572: RSS da árvore de processos de cada sessão PTY (CLI + filhos MCP),
     * medida no host PTY. Ausente quando o host não respondeu ou a plataforma
     * não tem `ps`. O Electron não enxerga esses processos — no incidente de
     * 16/09 o app somava ~450 MB enquanto 22 panes esgotavam a RAM.
     */
    footprints?: Array<{
      sessionId: string;
      rootPid: number;
      processCount: number;
      rssBytes: number | null;
    }>;
    footprintTotalRssBytes?: number;
  };
  /** F-572: amostra da memória do sistema usada pelo gate de admissão. */
  systemMemory?: {
    freeMB: number | null;
    swapUsedMB: number | null;
  };
  /** F-572: limites vigentes do teto de panes de agente. */
  paneAdmission?: {
    enabled: boolean;
    maxAgentPanes: number;
    minFreeMB: number;
    maxSwapUsedMB: number;
    liveAgentPanes: number;
  };
  warmPool?: {
    hits: number;
    misses: number;
    readyCount: number;
    minHeadroom: number;
    skippedByCpu: number;
    evictedStale: number;
    replenished: number;
  };
}

/**
 * 0.76.45: broadcast periódico main → todos os renderers (perf:paneFootprints).
 * Mesmo dado do panes.footprints do PerfSnapshot (probePaneFootprints +
 * getCachedSystemMemory), mas empurrado a cada 30s e indexado por sessionId
 * para lookup O(1) no badge de custo do PaneToolbar, em vez de poll.
 */
export interface PaneFootprintBroadcast {
  capturedAt: number;
  bySessionId: Record<string, { rssBytes: number | null; processCount: number }>;
  systemMemory: { freeMB: number | null; swapUsedMB: number | null } | null;
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
   * NOME humano durável do pane: inteiro curto, monotônico por workspace, nunca
   * reusado. É o que o operador fala, dita e escreve ("pane 248 travou") — o
   * `id` continua sendo a identidade interna e a chave durável.
   *
   * NÃO confundir com o slot de ⌘1-9: aquele é POSIÇÃO no layout visível e muda
   * quando panes abrem e fecham. Nome é identidade; slot é reflexo espacial.
   */
  paneNumber?: number;
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
  /** Semantic transport for agent panes; ACP renders a typed activity feed. */
  agentTransport?: 'cli-pty' | 'acp';
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
   * ESPAÇO do pane: o agrupamento do operador para panes que não pertencem a
   * uma missão do motor. Existe porque "abrir 3 terminais" e "rodar a missão A"
   * compartilham UMA árvore de layout por workspace — sem uma chave de escopo,
   * a vista Terminais só sabia filtrar por missão e despejava tudo no mesmo
   * mosaico (o operador via os painéis novos grudados na missão aberta).
   *
   * Nunca substitui `missionId`: missão vence espaço quando os dois existem.
   * O renderer é o dono; o main não deriva autoridade nenhuma daqui.
   */
  spaceId?: string;
  /** New tabs opt into a Main-owned worktree; absent on legacy shared tabs. */
  isolateSpace?: true;
  /**
   * Rótulo do espaço, desnormalizado no pane de propósito. O espaço É o
   * conjunto dos seus panes — sem registro paralelo para dessincronizar, e o
   * nome sobrevive ao restart pelo mesmo caminho que o resto do layout.
   */
  spaceTitle?: string;
  /**
   * Este pane do operador ADOTOU uma missão (o agente dele a criou, ou o
   * operador o fez orquestrador). A missão mora na aba deste pane — a aba é a
   * feature — em vez de abrir uma aba própria ao lado dos panes que a
   * começaram. Só agrupamento visual; o main não deriva autoridade daqui.
   */
  missionHost?: true;
  /**
   * F-231: casa persistida de um pane SOLTO aberto pelo "+ Pane" dentro de uma
   * aba de missão ("Nesta aba (solto)"). Não é participação na missão — é só o
   * agrupamento da aba, então o pane não é puxado para "Terminais" e volta à
   * mesma aba depois do restart. O `paneScopeKey` só honra a marca enquanto o
   * escopo apontado existe (missão encerrada devolve o pane aos soltos).
   */
  homeScopeKey?: string;
  /**
   * Origem da rota de um pane aberto por agente do operador (chip "Jev" /
   * "sem Jev"). Informação do nascimento: fica FORA do paneModelSchema de
   * propósito, então não persiste nem volta no restart.
   */
  spawnRoute?: SpawnRouteInfo;
  /**
   * Process-local orchestration surface. It may be visible while active but
   * must never enter the durable workspace layout or cold-start restore.
   */
  transient?: true;
  /** Bounded ANSI snapshot used only to repaint scrollback after a cold restart. */
  terminalScrollback?: string;
  /**
   * Colunas que o terminal tinha quando `terminalScrollback` foi capturado.
   * O replay só é seguro na MESMA largura — uma TUI posiciona a moldura com
   * cursor absoluto, então uma grade diferente entrelaça caixa e texto de forma
   * irreversível (reflow não reconstrói cursor absoluto).
   */
  terminalScrollbackCols?: number;
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

export interface WorkspaceLayout {
  root: LayoutNode;
  focusedPaneId: string | null;
}

/** Payload to open a PTY session for a pane. */
export interface SpawnRequest {
  cwd?: string;
  /** Opaque tab id; Main allocates/verifies the worktree in the active scope. */
  worktreeSpaceId?: string;
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
  /**
   * F-213: telemetria do lado do renderer — quanto tempo se passou entre a
   * intenção de nascer o pane (espera de grade, conta fixada, fila held) e a
   * chamada `pty.spawn`. Somente leitura; o main nunca decide nada por ele.
   */
  rendererWaitMs?: number;
}

export type SpawnResult =
  | {
      ok: true;
      sessionId: string;
      /** Effective working directory resolved by Main for an isolated tab. */
      cwd?: string;
      /** Main-selected account to retain in the trusted renderer's pane layout. */
      accountId?: string;
      resumeMode?: 'exact' | 'latest' | 'unsupported' | 'fresh-context';
      /** Existing main-owned mission PTY was attached; no provider restart. */
      adopted?: boolean;
      /** Current state snapshot for an adopted session (push may predate listeners). */
      state?: PaneSessionState;
      /** F-966: avisos de versão da CLI (faixa quebrada, modelo novo demais); não bloqueiam. */
      warnings?: string[];
    }
  | { ok: false; error: string; code?: LicenseErrorCode; blockedReason?: LicenseDenialReason };

export interface PtyDataEvent {
  sessionId: string;
  data: string;
  sequence: number;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
  /**
   * F-721: presente só quando o próprio Nexus encerrou o processo (respawn,
   * fechamento pedido, teardown) — a origem rotulada do pedido. Saída natural
   * não leva o campo. O renderer o usa para não tratar uma morte deliberada
   * como "falha ao retomar".
   */
  terminationOrigin?: string;
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
