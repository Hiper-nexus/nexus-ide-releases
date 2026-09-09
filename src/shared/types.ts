/**
 * Shared, transport-safe types used across main / preload / renderer.
 * Everything here must be JSON-serializable (it crosses the IPC boundary).
 *
 * Domain payloads live in surface-payload-types.ts; project identity in
 * project-identity-types.ts; product IPC in product-api.ts — re-exported
 * here for a stable public import path.
 */

import type { AdapterInfo } from './adapter-types';
import type {
  MissionEngineCommand,
  MissionPrepareRequest,
  MissionReview,
  MissionSnapshot,
  MissionSummarySnapshot,
} from './mission-engine-contract';
import type {
  PetGalleryImportResult,
  PetGalleryListResult,
  PetInstalledApplyResult,
  PetInstalledDeleteResult,
  PetInstalledListResult,
  PetInstalledPreviewResult,
  PetLibraryApplyResult,
  PetLibraryListResult,
  PetLibraryPreviewResult,
  PetPickImageResult,
  PetPickSheetResult,
  PetPrefs,
} from './pet-types';
import type { OrientationSnapshot } from './orientation-types';
import type {
  ApproveContextDraftInput,
  ApproveContextDraftResult,
  PendingContextDraft,
} from './context-draft-types';
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
  PaneCloseRequest,
  McpRuntimeInfo,
  Mission,
  MissionOperatorCompleteResult,
  MissionRuntimeCloseResult,
  MissionOrchestratorBootstrapResult,
  MissionPaneSpec,
  MissionPatch,
  OperatorReviewFeedbackInput,
  OperatorReviewFeedbackResult,
  MissionPanePresentationRequest,
  MissionPaneRecoveryRequest,
  MissionPaneRecoveryResult,
  OrchPaneSpawnRequest,
  OrchPaneSpawnResult,
  PaneRegistryEntry,
  Squad,
  SquadSaveOptions,
  SquadSaveResult,
  TodoList,
  TodoStatus,
} from './orch-types';
import type {
  ClarifyAnswerInput,
  ClarifyAnswerResult,
} from './clarify';
import type {
  AudioSettings,
  AudioSettingsPatch,
  TerminalSettings,
  OrchSettings,
  TerminalSettingsPatch,
  UiSettings,
  UiSettingsPatch,
} from './settings-types';
import type {
  WorkspaceLivenessEvent,
  WorkspaceState,
} from './workspace-types';
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
  MediaArtifactInfo,
  MediaProviderId,
  MediaProviderInfo,
  MediaStudioRequest,
  MediaStudioResponse,
  MediaUsageTotals,
} from './media-types';
import type { NotesApi } from './note-types';
import type { MemoryBridge } from './memory-ui-types';
import type { RichModelMetadataView } from './model-metadata-types';
import type {
  CompanionRelayStartRequest,
  CompanionRelayTransportInfo,
} from './companion-relay-types';
import type { PipeApi } from './pipe-types';
import type { VisionApi } from './vision-ipc';
import type {
  CommandRefineryCommandRequest,
  CommandRefineryMutationResult,
  CommandRefinerySuggestRequest,
  CommandRefinerySuggestResult,
} from './command-refinery';
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
  RemoteSshConnectRequest,
  RemoteSshConnectResult,
  RemoteSshHostView,
  RemoteSshImportResult,
  RemoteTmuxSession,
} from './remote-types';
import type {
  McpConfirmResult,
  McpInvokeResult,
} from './mcp-types';
import type {
  AuditLogSnapshot,
  ReleaseReadinessSnapshot,
} from './ops-ipc';
import type {
  CheckoutRequest,
  InviteInfo,
  LicenseState,
  TeamInfo,
} from './billing-types';
import type { IntegrationsApi } from './integrations-api';
import type { ProductApi } from './product-api';
import type {
  AgentSpecWriteRequest,
  BrowserDesignAnnotatePayload,
  BrowserDesignAnnotationsResult,
  BrowserDesignAnnotationsSendPayload,
  BrowserDesignAnnotationsSendResult,
  BrowserDesignEventPayload,
  BrowserDesignSendPayload,
  BrowserDesignSendResult,
  BrowserPaneBounds,
  BrowserPaneState,
  CatalogIndexResult,
  CatalogInstallResult,
  CatalogOverlayPatch,
  CatalogOverlayState,
  DesignActionResultPayload,
  DesignMissionBindingPayload,
  DesignSystemImportRequest,
  DesignSystemImportResult,
  DesignWritebackActionPayload,
  DesignWritebackStatusPayload,
  DevServerDetectedPayload,
  EnrichedCatalogInfo,
  InstalledItemInfo,
  NativeToolInfo,
  PaneSessionState,
  PerfSnapshot,
  RecipeOverlayResult,
  RecipeSuggestion,
  SpawnRequest,
  SpawnResult,
  Unsubscribe,
  WorkspaceLayout,
} from './surface-payload-types';

export type { AdapterInfo };
export type {
  RemoteBridgeInfo,
  RemoteBridgeStartRequest,
  RemoteCliDetection,
  RemoteSpawnRequest,
  RemoteSpawnResult,
  RemoteSshConnectRequest,
  RemoteSshConnectResult,
  RemoteSshHostView,
  RemoteSshImportResult,
  RemoteTmuxSession,
};

export type * from './surface-payload-types';

export {
  PROJECT_IDENTITY_VERSION,
  PROJECT_MANIFEST_VERSION,
  ProjectIdentityQuarantineError,
  gitRepositoryLineageSchema,
  legacyProjectManifestSchema,
  projectExecutionScopeSchema,
  projectManifestFileSchema,
  projectManifestSchema,
  quarantineProjectIdentity,
} from './project-identity-types';
export type * from './project-identity-types';

export type { ProductApi } from './product-api';
export type { McpHubSyncApplyInput, McpHubSyncExportToolId } from './mcp-hub-sync-api';

/**
 * Background MCP task lifecycle event pushed by main (`orch:bgTask.event`).
 * Shape mirrors `BgTaskEvent` in src/main/orch/bg-task-events.ts.
 */
export interface BgTaskEventPayload {
  readonly taskId: string;
  readonly command: string;
  readonly status: 'started' | 'exited' | 'killed';
  readonly exitCode: number | null;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly at: number;
}

/**
 * Hook waiting latch pushed by main (`orch:agent.waiting`).
 * `source` is one hook plane; the renderer keeps the pane listed while
 * either plane still needs a human.
 */
export interface AgentWaitingEvent {
  readonly source: 'orca' | 'semantic';
  readonly sessionId: string;
  readonly paneId: string;
  readonly agentLabel: string;
  readonly state: string;
  readonly at: number;
}

/**
 * Login-stuck watchdog event pushed by main (`orch:pane.loginStuck`). Shape
 * mirrors the event built in src/main/orch/login-stuck-watchdog.ts.
 * `stuck:false` is the recovery edge (login screen left / real progress) —
 * the watchdog NEVER kills or respawns the pane; it only reports state so the
 * UI can offer the adapter's login flow (`canOpenLogin`).
 */
export interface PaneLoginStuckEvent {
  readonly paneId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly stuck: boolean;
  /** Label of the curated heuristic pattern that matched ('' on recovery). */
  readonly pattern: string;
  /** True when the adapter has an interactive login flow the UI can offer. */
  readonly canOpenLogin: boolean;
  readonly at: number;
}

/**
 * The typed surface exposed on `window.nexus` by the preload script.
 * The renderer NEVER sees raw ipcRenderer — only this contract.
 */
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
     * Main avisa intervenção (missão blocked / agent waiting) e conclusão.
     * Sempre chega mesmo com pet desligado — a UI mostra toast e pode abrir o
     * Ops Board.
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
    /** Pacotes locais criados pelo Pet Studio/Codex em ~/.codex/pets. */
    installedList(): Promise<PetInstalledListResult>;
    /** Seleciona um pacote local como pet atual. */
    installedApply(id: string): Promise<PetInstalledApplyResult>;
    /** Sheet local para preview na Settings (sem aplicar). */
    installedPreview(id: string): Promise<PetInstalledPreviewResult>;
    /** Apaga um pacote em ~/.codex/pets/<id> (só pets do utilizador). */
    installedDelete(id: string): Promise<PetInstalledDeleteResult>;
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
    /**
     * Abre um caminho impresso no output de um pane (link clicável). O main
     * valida: absoluto, existe, arquivo/diretório, dentro do home — texto de
     * terminal nunca é instrução confiável.
     */
    openTerminalPath(
      path: string,
    ): Promise<{ ok: boolean; error?: string }>;
    /** Deep link / document open (nexus://open ou abrir-com). */
    onDeepOpenPath(
      cb: (payload: { path: string; isDir: boolean }) => void,
    ): Unsubscribe;
  };
  arms: {
    /** Estado do token Arms (nunca devolve o valor). */
    status(): Promise<{
      configured: boolean;
      revoked: boolean;
      createdAt: number | null;
      rotatedAt: number | null;
      lastUsedAt: number | null;
    }>;
    /** Gera token novo — plaintext volta exatamente uma vez. */
    generate(): Promise<{ token: string; createdAt: number }>;
    /** Rotaciona (invalida o anterior); plaintext volta uma vez. */
    rotate(): Promise<{ token: string; createdAt: number }>;
    /** Revoga: o conector externo passa a recusar. */
    revoke(): Promise<{ ok: boolean }>;
  };
  billing: {
    get(): Promise<LicenseState>;
    openCheckout(request: CheckoutRequest['plan'] | CheckoutRequest): Promise<{ ok: boolean; error?: string }>;
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
    /** Pull retained output immediately (used after adopting a headless PTY). */
    replay(sessionId: string): Promise<void>;
    write(sessionId: string, data: string): void;
    writeConfirmed(sessionId: string, data: string): Promise<boolean>;
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
    /** width ≤480 liga emulação mobile (UA + métricas, com reload); null desliga. */
    setDeviceEmulation(
      paneId: string,
      width: number | null,
    ): Promise<{ paneId: string; emulating: boolean }>;
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
    designAnnotate(
      paneId: string,
      payload: BrowserDesignAnnotatePayload,
    ): Promise<BrowserDesignAnnotationsResult>;
    listDesignAnnotations(paneId: string): Promise<BrowserDesignAnnotationsResult>;
    deleteDesignAnnotation(
      paneId: string,
      annotationId: string,
    ): Promise<BrowserDesignAnnotationsResult>;
    clearDesignAnnotations(paneId: string): Promise<BrowserDesignAnnotationsResult>;
    sendDesignAnnotations(
      paneId: string,
      payload: BrowserDesignAnnotationsSendPayload,
    ): Promise<BrowserDesignAnnotationsSendResult>;
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
    /** Blocking quit-path flush; never use on normal render updates. */
    saveSync(workspacePath: string, layout: WorkspaceLayout): boolean;
    load(workspacePath: string): Promise<WorkspaceLayout | null>;
  };
  adapters: {
    list(): Promise<AdapterInfo[]>;
    /** Re-fold PATH and re-probe every CLI binary (e.g. after brew/npm install). */
    rescan(): Promise<AdapterInfo[]>;
    onChanged(cb: (adapters: AdapterInfo[]) => void): Unsubscribe;
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
    /** Desarma o detector main-owned e libera sua autoridade/lock. */
    stopWake(): void;
    /** Evento do pipeline (mic morreu, wake detectado, falha de STT/brain) →
     *  log persistente em ~/.nexus/logs/voice.log (via main). */
    logVoice(payload: VoiceLogPayload): void;
    /** Abre Ajustes do macOS → Privacidade → Microfone (deep-link). */
    openMicSettings(): void;
    /** Abre Ajustes do macOS → Som (deep-link). */
    openSoundSettings(): void;
    onWakeDetected(cb: () => void): Unsubscribe;
    jarvis(req: JarvisRequest): Promise<JarvisReply>;
    /** Main-owned risk gate; prompts only for destructive/deploy commands. */
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
  mission: {
    prepare(request: MissionPrepareRequest): Promise<MissionReview>;
    routeIntent(objective: string): Promise<unknown>;
    answerDirect(question: string): Promise<string | null>;
    start(input: {
      missionId: string;
      reviewSha256: string;
    }): Promise<MissionSnapshot>;
    command(command: MissionEngineCommand): Promise<MissionSnapshot>;
    snapshot(missionId: string): Promise<MissionSnapshot>;
    list(): Promise<MissionSummarySnapshot[]>;
    /**
     * Summaries de um OUTRO workspace conhecido (para o rail multi-workspace).
     * Main só aceita roots que ele conhece como corrente/recente e devolve
     * lista vazia para workspace desconhecido ou ilegível.
     */
    listForWorkspace(rootPath: string): Promise<MissionSummarySnapshot[]>;
    onChanged(
      listener: (items: MissionSummarySnapshot[]) => void,
    ): Unsubscribe;
  };
  orch: {
    /** Mirror the current pane set into the main-process registry. */
    syncPanes(entries: PaneRegistryEntry[]): void;
    sendPaneSpawnResult(result: OrchPaneSpawnResult): void;
    onPaneSpawnRequest(cb: (req: OrchPaneSpawnRequest) => void): Unsubscribe;
    onPanePresentationRequest?(
      cb: (req: MissionPanePresentationRequest) => void,
    ): Unsubscribe;
    sendPaneRecoveryResult(result: MissionPaneRecoveryResult): void;
    onPaneRecoveryRequest(
      cb: (req: MissionPaneRecoveryRequest) => void,
    ): Unsubscribe;
    sendBrowserOpenResult(result: BrowserPaneOpenResult): void;
    onBrowserOpenRequest(cb: (req: BrowserPaneOpenRequest) => void): Unsubscribe;
    onPaneCloseRequest(cb: (request: PaneCloseRequest) => void): Unsubscribe;
    /**
     * Teclado do operador num pane de missão. O renderer não escreve nesses
     * panes; pede ao main, que valida posse/missão/formato e escreve pelo
     * lane main-owned. Resolve false quando a autoridade não confere.
     */
    sendPaneOperatorInput(input: {
      sessionId: string;
      data: string;
    }): Promise<boolean>;
    listMissions(): Promise<Mission[]>;
    /** Recorded pane composition of a mission (for 1-click reopen). */
    listMissionPanes(missionId: string): Promise<MissionPaneSpec[]>;
    /** P1-0 slice 1: snapshot único do plano de controle da missão. */
    missionControlPlane(
      missionId: string,
    ): Promise<import('./mission-control-plane').MissionControlSnapshot | null>;
    /**
     * Fail-closed restore proof. A renderer layout role/missionId is metadata,
     * never authority; Main confirms the exact persisted pane against the
     * mission's currently approved revision before any CLI may resume.
     */
    canRestoreMissionPane(input: {
      missionId: string;
      paneId: string;
    }): Promise<boolean>;
    /** Point handoff delivery at the reopened orchestrator's new session. */
    rebindMissionOrchestrator(
      missionId: string,
      sessionId: string,
    ): Promise<{ ok: boolean }>;
    /** Human-owned free promotion of one live mission pane to current leader. */
    promoteMissionOrchestrator(input: {
      missionId: string;
      paneId?: string;
      sessionId?: string;
    }): Promise<{
      ok: boolean;
      mission?: Mission;
      warning?: string;
      error?: string;
    }>;
    /**
     * Retry the orchestrator bootstrap of a mission the bootstrap itself
     * blocked (blocked_technical + marker). Main re-arms and re-validates.
     */
    resumeMissionBootstrap(input: {
      missionId: string;
    }): Promise<MissionOrchestratorBootstrapResult>;
    /** Mission event journal — recent projection (flag feature.mission.eventJournal). */
    missionEventsRecent(input: {
      missionId: string;
      limit?: number;
    }): Promise<{ events: unknown[]; enabled?: boolean; error?: string }>;
    missionEventsReplay(input: {
      missionId: string;
      afterSequence?: number;
      limit?: number;
      runId?: string;
    }): Promise<{ events: unknown[]; enabled?: boolean; error?: string }>;
    missionEventsAck(input: {
      missionId: string;
      upToSequence: number;
      consumerId?: string;
    }): Promise<{ ok: boolean; cursor?: unknown; error?: string }>;
    missionEventsCursor(input: {
      missionId: string;
      consumerId?: string;
    }): Promise<{ cursor: unknown; enabled?: boolean; error?: string }>;
    updateMission(missionId: string, patch: MissionPatch): Promise<Mission>;
    closeMissionRuntime(missionId: string): Promise<MissionRuntimeCloseResult>;
    completeMissionByOperator(
      missionId: string,
    ): Promise<MissionOperatorCompleteResult>;
    removeMission(missionId: string): Promise<{ removed: boolean }>;
    listHandoffs(): Promise<Handoff[]>;
    /** Resolve one durable mission question through scoped main authority. */
    answerClarify(input: ClarifyAnswerInput): Promise<ClarifyAnswerResult>;
    /** Persist diff comments before main-owned idle delivery to the mission. */
    submitOperatorReview(
      input: OperatorReviewFeedbackInput,
    ): Promise<OperatorReviewFeedbackResult>;
    getTodos(): Promise<TodoList[]>;
    /** Set a single todo item's status. */
    setTodoStatus(
      listId: string,
      itemId: string,
      status: TodoStatus,
    ): Promise<TodoList>;
    /**
     * Limpar concluídas do Quadro — política do main: missão viva perde só
     * itens concluídos; lista de missão terminal ou órfã sai inteira.
     */
    clearTodoBoard(): Promise<{
      removedLists: number;
      removedItems: number;
      todoLists: TodoList[];
    }>;
    listSquads(): Promise<Squad[]>;
    designSquad(
      workspacePath: string,
      intent?: string,
    ): Promise<{
      ok: boolean;
      squad?: Squad;
      designDraftToken?: string;
      error?: string;
      warning?: string;
    }>;
    saveSquad(
      squad: Squad,
      options?: SquadSaveOptions,
    ): Promise<SquadSaveResult>;
    deleteSquad(id: string): Promise<{ ok: boolean }>;
    exportSquads(): Promise<{ ok: boolean; path?: string; error?: string }>;
    importSquads(): Promise<{ ok: boolean; count?: number; error?: string }>;
    getMcpInfo(): Promise<McpRuntimeInfo>;
    getCatalogIndex(refresh?: boolean): Promise<CatalogIndexResult>;
    installCatalogItem(req: {
      kind: 'agent' | 'skill';
      slug: string;
    }): Promise<CatalogInstallResult>;
    getRecipeOverlay(): Promise<RecipeOverlayResult>;
    saveCatalogOverlay(patch: CatalogOverlayPatch): Promise<CatalogOverlayState>;
    proposeRecipes(): Promise<RecipeSuggestion[]>;
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
    onBgTaskEvent(cb: (event: BgTaskEventPayload) => void): Unsubscribe;
    onPaneLoginStuck(cb: (event: PaneLoginStuckEvent) => void): Unsubscribe;
    onAgentWaiting(cb: (event: AgentWaitingEvent) => void): Unsubscribe;
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
    listSshHosts(): Promise<RemoteSshHostView[]>;
    connectSshHost(req: RemoteSshConnectRequest): Promise<RemoteSshConnectResult>;
    importSshConfig(): Promise<RemoteSshImportResult>;
    removeSshHost(alias: string): Promise<{ ok: boolean; alias?: string; error?: string }>;
    /**
     * Companion mobile E2E (entrega B2): relay cego + AES-256-GCM. Canais
     * remote:relay.*. Atrás da flag feature.remote.relayTransport.
     */
    relay: {
      status(): Promise<CompanionRelayTransportInfo>;
      start(req: CompanionRelayStartRequest): Promise<CompanionRelayTransportInfo>;
      stop(): Promise<CompanionRelayTransportInfo>;
    };
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
    /** A pasta do workspace corrente sumiu do disco (ou voltou). */
    onLiveness(cb: (event: WorkspaceLivenessEvent) => void): Unsubscribe;
  };
  /** L1 structural Project Orientation Map (not business authority). */
  orientation: {
    get(): Promise<OrientationSnapshot | null>;
    ensure(): Promise<OrientationSnapshot | null>;
    refresh(): Promise<OrientationSnapshot | null>;
  };
  /** Human-in-the-loop review of source-bound context drafts (the user is an
   *  independent reviewer when no second CLI provider exists). */
  contextDrafts: {
    listProposed(): Promise<PendingContextDraft[]>;
    approve(input: ApproveContextDraftInput): Promise<ApproveContextDraftResult>;
  };
  providers: {
    list(): Promise<ProviderSettingsInfo[]>;
    setConfig(patch: ProviderConfigPatch): Promise<ProviderSettingsInfo[]>;
    setKey(req: SetKeyRequest): Promise<{ ok: boolean; error?: string }>;
    testKey(adapterId: string): Promise<TestConnectionResult>;
    authStatus(): Promise<AdapterAuthStatus[]>;
    /** Instala a CLI pela receita oficial (confirmação nativa no main). */
    installCli(adapterId: string): Promise<{ ok: boolean; error?: string }>;
    addModel(adapterId: string, model: string): Promise<ProviderSettingsInfo[]>;
    removeModel(adapterId: string, model: string): Promise<ProviderSettingsInfo[]>;
    onChanged(cb: (list: ProviderSettingsInfo[]) => void): Unsubscribe;
  };
  files: {
    list(relPath: string): Promise<FileTreeResult>;
    read(relPath: string): Promise<ReadFileResult>;
    write(relPath: string, content: string): Promise<{ ok: boolean; error?: string }>;
    saveDropped(name: string, base64: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    /**
     * Copy an external audio/image/text blob into
     * `.nexus/attachments/mission-context/` and return the root-relative path.
     */
    importMissionAttachment(
      name: string,
      base64: string,
    ): Promise<{ ok: boolean; path?: string; error?: string }>;
    /**
     * Drop that carried no `File`, only a `file://` path or an http(s) link:
     * main reads/downloads it and stages it in mission-context like above.
     */
    importDroppedUri(
      uri: string,
    ): Promise<{ ok: boolean; path?: string; error?: string }>;
    /** Resolve a dragged File to its absolute filesystem path (webUtils). */
    pathForFile(file: File): string;
  };
  /**
   * CommandBlock contextual actions (re-run goes through writeSession policy).
   * Flag: feature.terminal.commandBlocks.
   */
  terminalBlock: {
    action(req: unknown): Promise<{
      ok: boolean;
      action: string;
      payload?: Record<string, unknown>;
      error?: string;
      clipboardText?: string;
    }>;
    list(req: {
      sessionId?: string;
      paneId?: string;
      limit?: number;
    }): Promise<{ blocks: unknown[]; error?: string }>;
    suggest(
      req: CommandRefinerySuggestRequest,
    ): Promise<CommandRefinerySuggestResult>;
    dismiss(
      req: CommandRefineryCommandRequest,
    ): Promise<CommandRefineryMutationResult>;
    runSuggestion(
      req: CommandRefineryCommandRequest,
    ): Promise<CommandRefineryMutationResult>;
  };
  /** Unified SearchMixer (flag: feature.search.mixer). */
  searchMixer: {
    search(query: unknown): Promise<{
      generation: number;
      query: string;
      hits: unknown[];
      partial: boolean;
      completedSources: string[];
      cancelled: boolean;
      elapsedMs: number;
      error?: string;
    }>;
  };
  /**
   * Product-wave surface (flags, memory, skills, MCP hub, autonomy, editor).
   * Default off; a persisted override may enable each surface and the kill
   * switch remains authoritative.
   */
  product: ProductApi;
  /**
   * Descoberta read-only de configs de ecossistemas de agente do workspace
   * (MCP servers, context/rule files, skills, slash commands). Segredos em
   * env/headers chegam mascarados. Canal: discovery:workspace-configs.
   */
  discovery: {
    workspaceConfigs(): Promise<unknown>;
  };
  /**
   * Memória agentic por workspace (entrega C2): stats do banco, recall FTS5 e
   * forget. Envelope { enabled }: com a flag feature.memory.workspaceMemory OFF
   * o main devolve { enabled: false } em vez de lançar. Canais: memory:*.
   */
  memory: MemoryBridge;
  /**
   * Metadado rico read-only de modelo (preço USD/MTok, janela de contexto,
   * capacidades). Canal: model:richMetadata. Fonte: getRichModelMetadata.
   */
  model: {
    richMetadata(
      adapterId: string,
      modelId: string,
    ): Promise<RichModelMetadataView | null>;
  };
  /** GitHub / Linear / git SCM / SSH (see integrations-api.ts). */
  integrations: IntegrationsApi;
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
    snapshot(): Promise<UsageSnapshot | null>;
    onChanged(cb: (snapshot: UsageSnapshot) => void): Unsubscribe;
  };
  /**
   * Fleet provider quota windows (session / hours / weekly). Distinct from
   * project token spend in `usage`. Unknown ratios are null, never fake 0%.
   */
  quota: {
    snapshot(): Promise<import('./quota-types').QuotaFleetSnapshot>;
    refresh(): Promise<import('./quota-types').QuotaFleetSnapshot>;
    onChanged(
      cb: (snapshot: import('./quota-types').QuotaFleetSnapshot) => void,
    ): Unsubscribe;
  };
  /** Gamificação power-scaling: XP por entrega, nunca por consumo. */
  gamification: {
    snapshot(options?: { rescan?: boolean }): Promise<GamificationSnapshot>;
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
    /** Estúdio de Mídia: gera imagem/vídeo a partir do prompt (longo). */
    generate(req: MediaStudioRequest): Promise<MediaStudioResponse>;
    cancelGenerate(clientJobId: string): Promise<{ ok: boolean }>;
    listArtifacts(): Promise<MediaArtifactInfo[]>;
    revealArtifact(
      storageKey: string,
    ): Promise<{ ok: boolean; error?: string }>;
    readArtifactDataUrl(
      storageKey: string,
    ): Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  };
  notes: NotesApi;
  pipes: PipeApi;
  /** Fase 5 — Jarvis Vision: screen capture + AX tree + OCR */
  vision: VisionApi;
  platform: NodeJS.Platform;
}
