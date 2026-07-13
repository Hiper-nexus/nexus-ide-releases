import { z } from 'zod';
/**
 * Shared, transport-safe types used across main / preload / renderer.
 * Everything here must be JSON-serializable (it crosses the IPC boundary).
 */

import type { AdapterInfo } from './adapter-types';
import type { BrowserDesignEvent } from './browser-design';
import type { OnboardingState, OnboardingPatch } from './onboarding-types';
import type {
  PetGalleryImportResult,
  PetGalleryListResult,
  PetLibraryApplyResult,
  PetLibraryListResult,
  PetLibraryPreviewResult,
  PetPickImageResult,
  PetPickSheetResult,
  PetPrefs,
} from './pet-types';
import type { OrientationSnapshot } from './orientation-types';
import type { UpdateState } from './update-ipc';
import type {
  VoiceRuntimeInfo,
  TranscribeRequest,
  TranscribeResult,
  SpeakRequest,
  SpeakResult,
  SetConfigRequest,
  SetVoiceKeyRequest,
  JarvisRequest,
  JarvisReply,
  JarvisLiveInterruptEvent,
  JarvisLiveAudioOutEvent,
  JarvisLiveAudioPlaybackEvent,
  JarvisLiveRescueRequest,
  JarvisLiveRescueResult,
  JarvisLiveSayRequest,
  JarvisLiveStartRequest,
  JarvisLiveSmokeTestRequest,
  JarvisLiveSmokeTestResult,
  JarvisLiveState,
  JarvisLiveStatusPatch,
  JarvisLiveToolEvent,
  JarvisLiveToolCancellationEvent,
  JarvisLiveToolResultEvent,
  JarvisLiveToolTurnCompleteEvent,
  JarvisLiveTranscriptEvent,
  JarvisTranscriptAppendEvent,
  VoiceLogPayload,
} from './voice-ipc';
import type {
  Handoff,
  BrowserPaneOpenRequest,
  BrowserPaneOpenResult,
  McpRuntimeInfo,
  Mission,
  MissionPaneSpec,
  MissionPatch,
  OrchPaneSpawnRequest,
  OrchPaneSpawnResult,
  PaneRegistryEntry,
  Squad,
  TodoList,
  TodoStatus,
} from './orch-types';
import type {
  AudioSettings,
  AudioSettingsPatch,
  TerminalSettings,
  OrchSettings,
  TerminalSettingsPatch,
  UiSettings,
  UiSettingsPatch,
} from './settings-types';
import type { WorkspaceState } from './workspace-types';
import type {
  FileTreeResult,
  ReadFileResult,
} from './files-types';
import type {
  AccountActivatedEvent,
  AccountInfo,
  AccountQuotaInfo,
  AddAccountRequest,
  FailoverEvent,
} from './account-types';
import type { CostSnapshot } from './cost-types';
import type { UsageSnapshot } from './usage-types';
import type { PublicModelRankingSnapshot } from './eval-ranking-types';
import type { GamificationSnapshot } from './gamification-types';
import type {
  MediaProviderId,
  MediaProviderInfo,
  MediaUsageTotals,
} from './media-types';
import type { NotesApi } from './note-types';
import type { PipeApi } from './pipe-types';
import type { VisionApi } from './vision-ipc';
import type {
  AdapterAuthStatus,
  ProviderConfigPatch,
  ProviderSettingsInfo,
  SetKeyRequest,
  TestConnectionResult,
} from './provider-settings-types';
import type {
  RemoteBridgeInfo,
  RemoteBridgeStartRequest,
  RemoteCliDetection,
  RemoteSpawnRequest,
  RemoteSpawnResult,
} from './remote-types';
import type {
  McpConfirmResult,
  McpInvokeResult,
} from './mcp-types';
import type {
  AuditLogSnapshot,
  ReleaseReadinessSnapshot,
} from './ops-ipc';

export type { AdapterInfo };
export type {
  RemoteBridgeInfo,
  RemoteBridgeStartRequest,
  RemoteCliDetection,
  RemoteSpawnRequest,
  RemoteSpawnResult,
  RemoteTmuxSession,
} from './remote-types';

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
  workspacePath?: string;
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
  cwd?: string;
  /** Initial/current URL for browser panes. */
  browserUrl?: string;
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
  /** Re-spawn continuing the previous conversation (adapter resumeArgs). */
  resume?: boolean;
  /** Skip a stale captured id and use the adapter's latest-session fallback. */
  resumeLatestOnly?: boolean;
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
    }
  | { ok: false; error: string };

export interface PtyDataEvent {
  sessionId: string;
  data: string;
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

/**
 * The typed surface exposed on `window.nexus` by the preload script.
 * The renderer NEVER sees raw ipcRenderer — only this contract.
 */
import type {
  CheckoutRequest,
  InviteInfo,
  LicenseState,
  PlanId,
  TeamInfo,
} from './billing-types';

export interface NexusApi {
  /** Desktop pet (companion flutuante): prefs + pedido de abrir Settings. */
  pet: {
    getPrefs(): Promise<PetPrefs>;
    setPrefs(patch: Partial<PetPrefs>): Promise<PetPrefs>;
    onPrefsChanged(cb: (prefs: PetPrefs) => void): Unsubscribe;
    /** O pet pediu para abrir as configurações (menu "Configurar…"). */
    onOpenSettings(cb: () => void): Unsubscribe;
    /**
     * O pet pediu o Ops Board (missão concluída / falhou / precisa de
     * intervenção humana — clique no balão ou menu "Ver missões").
     */
    onOpenOps(cb: () => void): Unsubscribe;
    /**
     * Main avisa intervenção (missão blocked / agent waiting). Sempre chega
     * mesmo com pet desligado — a UI mostra toast e pode abrir o Ops Board.
     */
    onAttention(cb: (event: import('./pet-types').PetEvent) => void): Unsubscribe;
    /** Baixa um pet da galeria petdex por slug/URL (fetch no main). */
    galleryImport(slugOrUrl: string): Promise<PetGalleryImportResult>;
    /** Catálogo ao vivo da galeria (sitemap), com cache no main. */
    galleryList(): Promise<PetGalleryListResult>;
    /** Pacote offline de ~15 pets embutidos no app. */
    libraryList(): Promise<PetLibraryListResult>;
    /** Aplica um pet da biblioteca embutida (liga o pet + preset sheet). */
    libraryApply(id: string): Promise<PetLibraryApplyResult>;
    /** Sheet para preview na Settings (sem aplicar). */
    libraryPreview(id: string): Promise<PetLibraryPreviewResult>;
    /** Dialog nativo de spritesheet, aberto direto em ~/.codex/pets. */
    pickSheet(): Promise<PetPickSheetResult>;
    /** Picker da imagem-base para geração de pet (devolve só o path). */
    pickImage(): Promise<PetPickImageResult>;
  };
  /** App-shell lifecycle signals to the main process. */
  app: {
    /** Tell main that React committed its first frame (mount watchdog). */
    signalMounted(report?: { ok: boolean; error?: string }): void;
    /** Open an external http(s) URL in the OS browser. */
    openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
    /** Inicia o login OAuth (nonce local + browser) no processo main. */
    authLogin(provider: 'github' | 'google'): Promise<{ ok: boolean; error?: string }>;
    /**
     * Abre THIRD_PARTY_NOTICES.md no app do SO (Markdown viewer).
     * Cumpre atribuição MIT de terceiros sem tornar o código público.
     */
    openLegalNotices(): Promise<{ ok: boolean; path?: string; error?: string }>;
    /** Deep link / document open (nexus://open ou abrir-com). */
    onDeepOpenPath(
      cb: (payload: { path: string; isDir: boolean }) => void,
    ): Unsubscribe;
  };
  billing: {
    get(): Promise<LicenseState>;
    openCheckout(request: PlanId | CheckoutRequest): Promise<{ ok: boolean; error?: string }>;
    openPortal(): Promise<{ ok: boolean }>;
  };
  team: {
    get(): Promise<{ ok: boolean; data?: TeamInfo; error?: string }>;
    join(code: string): Promise<{ ok: boolean; error?: string }>;
    invite(): Promise<{ ok: boolean; data?: { code: string; url: string } & Partial<InviteInfo>; error?: string }>;
    removeMember(accountId: string): Promise<{ ok: boolean; error?: string }>;
    leave(): Promise<{ ok: boolean; error?: string }>;
  };
  pty: {
    spawn(req: SpawnRequest): Promise<SpawnResult>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    kill(sessionId: string): void;
    onData(sessionId: string, cb: (data: string) => void): Unsubscribe;
    onExit(
      sessionId: string,
      cb: (event: { exitCode: number; signal?: number }) => void,
    ): Unsubscribe;
    onStateChange(
      sessionId: string,
      cb: (state: PaneSessionState) => void,
    ): Unsubscribe;
  };
  browser: {
    create(paneId: string, url?: string): Promise<BrowserPaneState>;
    destroy(paneId: string): void;
    setBounds(paneId: string, bounds: BrowserPaneBounds): void;
    load(paneId: string, url: string): Promise<BrowserPaneState>;
    back(paneId: string): Promise<BrowserPaneState>;
    forward(paneId: string): Promise<BrowserPaneState>;
    reload(paneId: string): Promise<BrowserPaneState>;
    stop(paneId: string): Promise<BrowserPaneState>;
    onState(cb: (state: BrowserPaneState) => void): Unsubscribe;
    setDesignMode(
      paneId: string,
      active: boolean,
    ): Promise<{ paneId: string; active: boolean }>;
    sendDesignSelection(
      paneId: string,
      payload: BrowserDesignSendPayload,
    ): Promise<BrowserDesignSendResult>;
    onDesignEvent(cb: (payload: BrowserDesignEventPayload) => void): Unsubscribe;
    setStylePreview(
      paneId: string,
      selector: string,
      styles: Record<string, string>,
    ): Promise<{ paneId: string; applied: true; selector: string; properties: number }>;
    clearStylePreview(
      paneId: string,
      selector?: string,
    ): Promise<{ paneId: string; cleared: number }>;
  };
  devServer: {
    onDetected(cb: (payload: DevServerDetectedPayload) => void): Unsubscribe;
  };
  design: {
    status(binding?: DesignMissionBindingPayload): Promise<DesignWritebackStatusPayload>;
    start(binding: DesignMissionBindingPayload): Promise<{ ok: true; files: number; elements: number }>;
    stop(binding: DesignMissionBindingPayload): Promise<{ ok: true }>;
    apply(
      binding: DesignMissionBindingPayload,
      action: DesignWritebackActionPayload,
    ): Promise<DesignActionResultPayload>;
    undo(binding: DesignMissionBindingPayload): Promise<DesignActionResultPayload | null>;
    redo(binding: DesignMissionBindingPayload): Promise<DesignActionResultPayload | null>;
  };
  layout: {
    /** Layouts are keyed per workspace folder. */
    save(workspacePath: string, layout: WorkspaceLayout): Promise<{ ok: boolean }>;
    load(workspacePath: string): Promise<WorkspaceLayout | null>;
  };
  adapters: {
    list(): Promise<AdapterInfo[]>;
    onChanged(cb: (adapters: AdapterInfo[]) => void): Unsubscribe;
  };
  onboarding: {
    get(): Promise<OnboardingState>;
    set(patch: OnboardingPatch): Promise<OnboardingState>;
  };
  update: {
    /** Snapshot do estado do auto-update (fase, versão atual, disponível). */
    getState(): Promise<UpdateState>;
    /** Checa agora por versão nova; retorna o estado resultante. */
    check(): Promise<UpdateState>;
    /** Baixa + prepara a atualização disponível (Squirrel). */
    install(): Promise<UpdateState>;
    /** Update pronto → reinicia aplicando. */
    restart(): Promise<void>;
    onState(cb: (state: UpdateState) => void): Unsubscribe;
  };
  voice: {
    getInfo(): Promise<VoiceRuntimeInfo>;
    setConfig(patch: SetConfigRequest): Promise<VoiceRuntimeInfo>;
    setKey(req: SetVoiceKeyRequest): Promise<{ ok: boolean; error?: string }>;
    transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
    speak(req: SpeakRequest): Promise<SpeakResult>;
    /** Registra texto falado para supressão de eco no próximo STT. */
    recordEcho(text: string): Promise<{ ok: true }>;
    /** Barge-in: mata a fala do fallback `say` que toca no main. */
    stopSpeak(): Promise<void>;
    sendWakeAudio(chunk: ArrayBuffer): void;
    /** Evento do pipeline (mic morreu, wake detectado, falha de STT/brain) →
     *  log persistente em ~/.nexus/logs/voice.log (via main). */
    logVoice(payload: VoiceLogPayload): void;
    /** Abre Ajustes do macOS → Privacidade → Microfone (deep-link). */
    openMicSettings(): void;
    /** Abre Ajustes do macOS → Som (deep-link). */
    openSoundSettings(): void;
    onWakeDetected(cb: () => void): Unsubscribe;
    jarvis(req: JarvisRequest): Promise<JarvisReply>;
    /** Native confirmation before a voice-issued shell command runs (SEC#6). */
    confirmCommand(command: string): Promise<boolean>;
    /** macOS: tccutil reset Microphone <bundleId> + relaunch (grant TCC fantasma). */
    resetMicPermission(): Promise<{ ok: boolean; error?: string }>;
    liveStart(req?: JarvisLiveStartRequest): Promise<JarvisLiveState>;
    /** Pre-connect Live silently while wake-word listening is armed. */
    livePrewarm(enabled: boolean): Promise<JarvisLiveState>;
    liveStop(): Promise<JarvisLiveState>;
    liveHardRebuild(): Promise<JarvisLiveState>;
    liveHardTeardown(): Promise<JarvisLiveState>;
    liveQuiesce(reason: string): Promise<JarvisLiveState>;
    liveEndTurn(): Promise<JarvisLiveState>;
    liveEndUserAudio(): Promise<JarvisLiveState>;
    liveTurnBegin(turnId: string): void;
    liveSmokeTest(req: JarvisLiveSmokeTestRequest): Promise<JarvisLiveSmokeTestResult>;
    liveSay(req: JarvisLiveSayRequest): Promise<JarvisLiveState>;
    liveStatus(patch: JarvisLiveStatusPatch): Promise<JarvisLiveState>;
    liveTranscript(event: Omit<JarvisLiveTranscriptEvent, 'sessionId' | 'at'>): void;
    liveToolResult(event: Omit<JarvisLiveToolResultEvent, 'sessionId' | 'at'>): void;
    liveInterrupt(reason: string): Promise<JarvisLiveInterruptEvent>;
    /** Mic PCM 16 kHz base64 → transporte realtime (no-op no Classic). */
    liveMicIn(b64: string): void;
    /** Send one locally transcribed zero-frame turn back to Live, idempotently. */
    liveRescueIn(req: JarvisLiveRescueRequest): Promise<JarvisLiveRescueResult>;
    /** Contexto de tela (texto) → sessão live realtime. */
    liveContextIn(text: string): void;
    /** TTS PCM 24 kHz do transporte realtime para tocar no renderer. */
    onLiveAudioOut(cb: (event: JarvisLiveAudioOutEvent) => void): Unsubscribe;
    /** Evidência de que o WebAudio iniciou, falhou ou descartou um chunk Live. */
    liveAudioPlayback(event: JarvisLiveAudioPlaybackEvent): void;
    onPttStart(cb: () => void): Unsubscribe;
    onPttToggle(cb: () => void): Unsubscribe;
    onPttStop(cb: () => void): Unsubscribe;
    onInfoChanged(cb: (info: VoiceRuntimeInfo) => void): Unsubscribe;
    /** Narração proativa (handoff/travamento) — falar se não houver turno ativo. */
    onNarrate(cb: (event: import('./voice-ipc').VoiceNarrationEvent) => void): Unsubscribe;
    onLiveState(cb: (state: JarvisLiveState) => void): Unsubscribe;
    onLiveTranscript(cb: (event: JarvisLiveTranscriptEvent) => void): Unsubscribe;
    onTranscriptAppend(cb: (event: JarvisTranscriptAppendEvent) => void): Unsubscribe;
    onLiveToolCall(cb: (event: JarvisLiveToolEvent) => void): Unsubscribe;
    onLiveToolCancelled(cb: (event: JarvisLiveToolCancellationEvent) => void): Unsubscribe;
    onLiveToolResult(cb: (event: JarvisLiveToolResultEvent) => void): Unsubscribe;
    onLiveToolTurnComplete(
      cb: (event: JarvisLiveToolTurnCompleteEvent) => void,
    ): Unsubscribe;
    onLiveInterrupted(cb: (event: JarvisLiveInterruptEvent) => void): Unsubscribe;
  };
  orch: {
    /** Mirror the current pane set into the main-process registry. */
    syncPanes(entries: PaneRegistryEntry[]): void;
    sendPaneSpawnResult(result: OrchPaneSpawnResult): void;
    onPaneSpawnRequest(cb: (req: OrchPaneSpawnRequest) => void): Unsubscribe;
    sendBrowserOpenResult(result: BrowserPaneOpenResult): void;
    onBrowserOpenRequest(cb: (req: BrowserPaneOpenRequest) => void): Unsubscribe;
    onPaneCloseRequest(cb: (paneId: string) => void): Unsubscribe;
    listMissions(): Promise<Mission[]>;
    /** Recorded pane composition of a mission (for 1-click reopen). */
    listMissionPanes(missionId: string): Promise<MissionPaneSpec[]>;
    /** Point handoff delivery at the reopened orchestrator's new session. */
    rebindMissionOrchestrator(
      missionId: string,
      sessionId: string,
    ): Promise<{ ok: boolean }>;
    /** Patch a mission's editable fields (title/description/status/milestones). */
    /** Cria o registro da missão no lançamento (não depende do LLM). */
    createMission(input: {
      title: string;
      squadId?: string;
      orchestratorPane?: {
        paneId: string;
        adapterId: string;
        model?: string;
        accountId?: string;
        cwd?: string;
        title?: string;
        agentName?: string;
      };
    }): Promise<Mission>;
    updateMission(missionId: string, patch: MissionPatch): Promise<Mission>;
    removeMission(missionId: string): Promise<{ removed: boolean }>;
    listHandoffs(): Promise<Handoff[]>;
    getTodos(): Promise<TodoList[]>;
    /** Set a single todo item's status. */
    setTodoStatus(
      listId: string,
      itemId: string,
      status: TodoStatus,
    ): Promise<TodoList>;
    listSquads(): Promise<Squad[]>;
    designSquad(
      workspacePath: string,
      intent?: string,
    ): Promise<{ ok: boolean; squad?: Squad; error?: string; warning?: string }>;
    saveSquad(squad: Squad): Promise<{ ok: boolean; error?: string }>;
    deleteSquad(id: string): Promise<{ ok: boolean }>;
    exportSquads(): Promise<{ ok: boolean; path?: string; error?: string }>;
    importSquads(): Promise<{ ok: boolean; count?: number; error?: string }>;
    getMcpInfo(): Promise<McpRuntimeInfo>;
    getCatalogIndex(refresh?: boolean): Promise<CatalogIndexResult>;
    installCatalogItem(req: {
      kind: 'agent' | 'skill';
      slug: string;
    }): Promise<CatalogInstallResult>;
    getRecipeOverlay(workspacePath?: string): Promise<RecipeOverlayResult>;
    saveCatalogOverlay(patch: CatalogOverlayPatch): Promise<CatalogOverlayState>;
    proposeRecipes(workspacePath?: string): Promise<RecipeSuggestion[]>;
    writeAgentSpec(req: AgentSpecWriteRequest): Promise<{ ok: boolean; path?: string; error?: string }>;
    listInstalledCatalog(): Promise<InstalledItemInfo[]>;
    harnessEnriched(): Promise<EnrichedCatalogInfo | null>;
    harnessEnrich(): Promise<{
      ok: boolean;
      catalog?: EnrichedCatalogInfo;
      error?: string;
    }>;
    listNativeTools(): Promise<NativeToolInfo[]>;
    listPluginFiles(): Promise<InstalledItemInfo[]>;
    listHookHomes(): Promise<InstalledItemInfo[]>;
    searchDesignSystems(req?: {
      query?: string;
      tags?: string[];
      sort?: 'popular' | 'recent' | 'likes' | 'downloads';
      limit?: number;
    }): Promise<
      | { ok: true; kits: Array<{
          slug: string;
          name: string;
          description: string;
          author: string;
          url: string;
          tags: string[];
          license: string;
          downloadCount: number;
          likeCount: number;
        }> }
      | { ok: false; error: string }
    >;
    importDesignSystem(
      req: DesignSystemImportRequest,
    ): Promise<DesignSystemImportResult>;
    onMissionsChanged(cb: (missions: Mission[]) => void): Unsubscribe;
    onHandoffsChanged(cb: (handoffs: Handoff[]) => void): Unsubscribe;
    onTodosChanged(cb: (lists: TodoList[]) => void): Unsubscribe;
    onSquadsChanged(cb: (squads: Squad[]) => void): Unsubscribe;
  };
  remote: {
    bridgeStatus(): Promise<RemoteBridgeInfo>;
    bridgeStart(req?: RemoteBridgeStartRequest): Promise<RemoteBridgeInfo>;
    bridgeStop(): Promise<RemoteBridgeInfo>;
    bridgeRotatePairing(): Promise<RemoteBridgeInfo>;
    bridgeRevokeTokens(): Promise<RemoteBridgeInfo>;
    detectClis(target: string): Promise<RemoteCliDetection>;
    listTmux(target: string): Promise<RemoteSpawnResult>;
    createTmux(req: RemoteSpawnRequest): Promise<RemoteSpawnResult>;
  };
  settings: {
    get(): Promise<TerminalSettings>;
    set(patch: TerminalSettingsPatch): Promise<TerminalSettings>;
    onChanged(cb: (settings: TerminalSettings) => void): Unsubscribe;
    orchGet(): Promise<OrchSettings>;
    orchSet(patch: Partial<OrchSettings>): Promise<OrchSettings>;
    audioGet(): Promise<AudioSettings>;
    audioSet(patch: AudioSettingsPatch): Promise<AudioSettings>;
    onAudioChanged(cb: (audio: AudioSettings) => void): Unsubscribe;
    listShells(): Promise<string[]>;
    uiGet(): Promise<UiSettings>;
    uiSet(patch: UiSettingsPatch): Promise<UiSettings>;
    onUiChanged(cb: (ui: UiSettings) => void): Unsubscribe;
  };
  workspace: {
    get(): Promise<WorkspaceState>;
    pick(): Promise<WorkspaceState>;
    /** Folder picker that returns the path without opening the workspace. */
    pickPath(): Promise<string | null>;
    open(path: string): Promise<WorkspaceState>;
    close(): Promise<WorkspaceState>;
    remove(path: string): Promise<WorkspaceState>;
    onChanged(cb: (state: WorkspaceState) => void): Unsubscribe;
  };
  /** L1 structural Project Orientation Map (not business authority). */
  orientation: {
    get(): Promise<OrientationSnapshot | null>;
    ensure(): Promise<OrientationSnapshot | null>;
    refresh(): Promise<OrientationSnapshot | null>;
  };
  providers: {
    list(): Promise<ProviderSettingsInfo[]>;
    setConfig(patch: ProviderConfigPatch): Promise<ProviderSettingsInfo[]>;
    setKey(req: SetKeyRequest): Promise<{ ok: boolean; error?: string }>;
    testKey(adapterId: string): Promise<TestConnectionResult>;
    authStatus(): Promise<AdapterAuthStatus[]>;
    addModel(adapterId: string, model: string): Promise<ProviderSettingsInfo[]>;
    removeModel(adapterId: string, model: string): Promise<ProviderSettingsInfo[]>;
    onChanged(cb: (list: ProviderSettingsInfo[]) => void): Unsubscribe;
  };
  files: {
    list(relPath: string): Promise<FileTreeResult>;
    read(relPath: string): Promise<ReadFileResult>;
    write(relPath: string, content: string): Promise<{ ok: boolean; error?: string }>;
    saveDropped(name: string, base64: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    /** Resolve a dragged File to its absolute filesystem path (webUtils). */
    pathForFile(file: File): string;
  };
  /** GitHub / Linear / diff / SSH port-forward integrations (Sprint A–C). */
  integrations: {
    hasGithubToken(): Promise<boolean>;
    hasLinearKey(): Promise<boolean>;
    setGithubToken(token: string): Promise<{ ok: boolean; error?: string }>;
    setLinearKey(token: string): Promise<{ ok: boolean; error?: string }>;
    gitDiff(): Promise<
      | { ok: true; diff: string; branch: string | null; remote: string | null }
      | { ok: false; error: string }
    >;
    gitStatus(): Promise<
      | { ok: true; status: string; branch: string | null; remote: string | null }
      | { ok: false; error: string }
    >;
    createPr(req: {
      title: string;
      body?: string;
      sourceBranch?: string;
      targetBranch?: string;
      draft?: boolean;
    }): Promise<{ ok: true; url: string; number: number } | { ok: false; error: string }>;
    listPrs(): Promise<
      | { ok: true; prs: Array<{ number: number; title: string; url: string; state: string; sourceBranch: string; targetBranch: string }> }
      | { ok: false; error: string }
    >;
    listGithubIssues(opts?: {
      limit?: number;
      state?: 'open' | 'closed' | 'all';
    }): Promise<
      | { ok: true; issues: Array<{ id: string; provider: 'github' | 'linear'; number?: number; title: string; url: string; state: string; labels: string[] }> }
      | { ok: false; error: string }
    >;
    listLinearIssues(opts?: {
      limit?: number;
    }): Promise<
      | { ok: true; issues: Array<{ id: string; provider: 'github' | 'linear'; number?: number; title: string; url: string; state: string; labels: string[] }> }
      | { ok: false; error: string }
    >;
    startPortForward(req: {
      localPort: number;
      remoteHost?: string;
      remotePort: number;
      label?: string;
    }): Promise<
      | { ok: true; info: { id: string; localPort: number; remoteHost: string; remotePort: number; label?: string; localUrl: string } }
      | { ok: false; error: string }
    >;
    listPortForwards(): Promise<
      Array<{ id: string; localPort: number; remoteHost: string; remotePort: number; label?: string; localUrl: string }>
    >;
    closePortForward(id: string): Promise<{ ok: boolean }>;
    remoteWorktreeCreate(req: {
      host: string;
      username: string;
      remotePath: string;
      branch?: string;
    }): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  };
  accounts: {
    list(): Promise<AccountInfo[]>;
    quota(): Promise<AccountQuotaInfo[]>;
    add(req: AddAccountRequest): Promise<{ ok: boolean; id?: string; error?: string }>;
    addActiveClaude(label: string): Promise<{ ok: boolean; id?: string; email?: string; error?: string }>;
    addActiveSession(
      adapterId: string,
      label: string,
    ): Promise<{ ok: boolean; id?: string; email?: string; error?: string }>;
    supportsSnapshot(
      adapterId: string,
    ): Promise<{ ok: boolean; supported?: boolean }>;
    rename(id: string, label: string): Promise<{ ok: boolean }>;
    remove(id: string): Promise<{ ok: boolean }>;
    activate(id: string): Promise<{ ok: boolean; error?: string; needsRestart?: boolean }>;
    onChanged(cb: (list: AccountInfo[]) => void): Unsubscribe;
    onFailover(cb: (event: FailoverEvent) => void): Unsubscribe;
    onActivated(cb: (event: AccountActivatedEvent) => void): Unsubscribe;
  };
  cost: {
    snapshot(): Promise<CostSnapshot>;
    setCap(paneId: string, capUsd: number | null): Promise<{ ok: boolean; error?: string }>;
    onChanged(cb: (snapshot: CostSnapshot) => void): Unsubscribe;
  };
  /** Telemetria REAL de tokens (transcript watchers → SQLite). */
  usage: {
    snapshot(): Promise<UsageSnapshot>;
    onChanged(cb: (snapshot: UsageSnapshot) => void): Unsubscribe;
  };
  /** Gamificação power-scaling: XP por entrega, nunca por consumo. */
  gamification: {
    snapshot(): Promise<GamificationSnapshot>;
    selectSkin(skin: string | null): Promise<GamificationSnapshot>;
    exportProfile(): Promise<{ ok: boolean; path?: string; error?: string }>;
    importProfile(): Promise<{ ok: boolean; error?: string }>;
    prestige(): Promise<GamificationSnapshot>;
    recordJarvisAction(input: {
      actionType: string;
      ok: boolean;
    }): Promise<GamificationSnapshot>;
    onChanged(cb: (snapshot: GamificationSnapshot) => void): Unsubscribe;
  };
  perf: {
    snapshot(): Promise<PerfSnapshot>;
  };
  mcp: {
    invoke(
      tool: string,
      args?: Record<string, unknown>,
    ): Promise<McpInvokeResult>;
    confirm(
      tool: string,
      args?: Record<string, unknown>,
    ): Promise<McpConfirmResult>;
    clearSession(): Promise<{ ok: boolean }>;
  };
  ops: {
    auditLog(limit?: number): Promise<AuditLogSnapshot>;
    releaseReadiness(): Promise<ReleaseReadinessSnapshot>;
  };
  /**
   * Public multi-dimension LLM ranking (no secrets). Same DTO as
   * resources/model-ranking.json for the future customer landing page.
   */
  ranking: {
    public(): Promise<PublicModelRankingSnapshot>;
  };
  media: {
    listProviders(): Promise<MediaProviderInfo[]>;
    setKey(
      providerId: MediaProviderId,
      key: string,
    ): Promise<{ ok: boolean; error?: string }>;
    usageTotals(): Promise<MediaUsageTotals>;
  };
  notes: NotesApi;
  pipes: PipeApi;
  /** Fase 5 — Jarvis Vision: screen capture + AX tree + OCR */
  vision: VisionApi;
  platform: NodeJS.Platform;
}

// Portable project identity v2 -------------------------------------------------
export const PROJECT_IDENTITY_VERSION = 1 as const;
export const PROJECT_MANIFEST_VERSION = 2 as const;

const originHashSchema = z.string().regex(/^origin-sha256-[a-f0-9]{64}$/);
const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const gitRepositoryLineageSchema = z
  .object({
    vcs: z.literal('git'),
    originHashes: z.array(originHashSchema).max(16),
    rootCommits: z.array(gitObjectIdSchema).max(64),
    anchorCommits: z.array(gitObjectIdSchema).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.originHashes.length === 0 && value.anchorCommits.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'repository lineage requires an origin hash or anchor commit',
      });
    }
    for (const [field, values] of [
      ['originHashes', value.originHashes],
      ['rootCommits', value.rootCommits],
      ['anchorCommits', value.anchorCommits],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must not contain duplicates`,
        });
      }
    }
  });

export const projectManifestSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_MANIFEST_VERSION),
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(160).optional(),
    repository: gitRepositoryLineageSchema,
  })
  .strict();

export const legacyProjectManifestSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_IDENTITY_VERSION),
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const projectManifestFileSchema = z.union([
  projectManifestSchema,
  legacyProjectManifestSchema,
]);

export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export type LegacyProjectManifest = z.infer<typeof legacyProjectManifestSchema>;
export type GitRepositoryLineage = z.infer<typeof gitRepositoryLineageSchema>;
export type ProjectIdentitySource = 'manifest' | 'provisional';

export type ProjectIdentityQuarantineCode =
  | 'legacy-manifest-unverified'
  | 'repository-lineage-mismatch'
  | 'repository-lineage-unverifiable'
  | 'unsafe-git-administration'
  | 'checkout-registry-required'
  | 'checkout-token-mismatch'
  | 'duplicate-checkout-token';

export class ProjectIdentityQuarantineError extends Error {
  readonly code: ProjectIdentityQuarantineCode;
  readonly remediation: string;

  constructor(
    code: ProjectIdentityQuarantineCode,
    message: string,
    remediation: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProjectIdentityQuarantineError';
    this.code = code;
    this.remediation = remediation;
  }
}

export function quarantineProjectIdentity(
  code: ProjectIdentityQuarantineCode,
  message: string,
  remediation: string,
  cause?: unknown,
): never {
  throw new ProjectIdentityQuarantineError(code, message, remediation, {
    ...(cause === undefined ? {} : { cause }),
  });
}

export const projectExecutionScopeSchema = z.object({
  version: z.literal(PROJECT_IDENTITY_VERSION),
  installationId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  checkoutId: z.string().min(1).max(128),
  rootRealPath: z.string().min(1).max(4096),
  identitySource: z.enum(['manifest', 'provisional']),
}).strict();

/**
 * Immutable authority attached to a session when it is created. Paths are
 * always resolved from this scope; the workspace currently visible in the UI
 * is intentionally absent from the authorization decision.
 */
export type ProjectExecutionScope = Readonly<
  z.infer<typeof projectExecutionScopeSchema>
>;
