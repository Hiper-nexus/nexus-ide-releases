import type { LicenseErrorCode, LicenseDenialReason } from './license-errors';
import type { LoginResultEvent } from './auth-login';
import type {
  BugReportPreviewResult,
  BugReportRequest,
  BugReportSubmitResult,
} from './bug-report';
import type { AccountChoiceReceipt } from './account-choice';
import type { ApprovalDecision, ApprovalRequestView } from './approval-decision';
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
import type { DecisionModelStatus, SetDecisionKeyRequest, TestDecisionModelRequest } from './decision-models';
import type { DecisionCalibrationCancelResult, DecisionCalibrationPlan, DecisionCalibrationResult, DecisionMissionPanelResult } from './decision-engine-ui';
import type {
  JevDecisionRow,
  JevDecisionStatsResult,
  JevPaneHintEvent,
  JevStatus,
  JevTestResult,
  SetJevKeyRequest,
} from './jev-ipc';
import type { MissionPickRequest, MissionPickResult } from './mission-pick';
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
  PaneParkRequest,
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
  OrchSettingsPatch,
  SpendSettings,
  SpendSettingsPatch,
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
  HeicConvertResult,
  ReadFileResult,
  SearchFilesResult,
} from './files-types';
import type {
  AccountActivatedEvent,
  AccountInfo,
  AccountQuotaInfo,
  AddAccountRequest,
  FailoverEvent,
} from './account-types';
import type { CostSnapshot } from './cost-types';
import type { TokenSpeedSnapshot } from './token-speed-types';
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
  CliHistoryImportRequest,
  CliHistoryImportResult,
  CommandHistorySearchRequest,
  CommandHistorySearchResult,
} from './cli-history';
import type {
  AdapterAuthStatus,
  CliAutoUpdateStatus,
  ProviderConfigPatch,
  ProviderSettingsInfo,
  SetKeyRequest,
  TestConnectionResult,
} from './provider-settings-types';
import type {
  RemoteBridgeInfo,
  RemoteBridgeSetDeviceScopesRequest,
  RemoteBridgeStartRequest,
  RemoteCliDetection,
  RemoteDeviceScope,
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
  CatalogRecommendationsResult,
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
  PaneFootprintBroadcast,
  PaneSessionState,
  PerfSnapshot,
  PtyDataMeta,
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
/** Content-free, Main-owned proof for a bounded prompt submission. */
export interface PtyPromptState {
  readonly turnStartSequence: number;
  readonly state: PaneSessionState;
  readonly awaitingInput: boolean;
  /** F-1393: o adapter da sessão enfileira texto + Enter durante o turno. */
  readonly queuesInputWhileBusy?: boolean;
}

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
 * Payload pushed by main on `orch:worker.spawnFailed` (project scope stripped).
 *
 * Two situations share this channel, and both end the same way for the
 * operator: the CLI that was asked for did NOT seat — it either died on boot
 * (`successorCli` retried) or its seat had no usable credential and the
 * succession chain seated another CLI before the process existed. The pane may
 * well be open on the successor, which is exactly why the notice matters: sem
 * ela a troca fica invisível e o pane parece só ter ignorado o pedido
 * (campo 10/09: "pedi kimi, abriu sonnet que eu nem tinha pedido").
 */
export interface PaneWorkerSpawnFailedEvent {
  readonly missionId: string;
  /** CLI that did not seat. */
  readonly deadAdapterId: string;
  readonly message: string;
  readonly title?: string;
  /** CLI that took the pane instead, when one did. */
  readonly successorCli?: string;
  readonly successorName?: string;
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
    /** O pet pediu para navegar para a tela de terminais / grid. */
    onOpenTerminal(cb: () => void): Unsubscribe;
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
    /**
     * Gate de montagem do boot: resolve quando o bootstrap do main registrou
     * todo o IPC; rejeita se o bootstrap falhar. O documento carrega em
     * paralelo — o React monta só depois disto.
     */
    ready(): Promise<void>;
    /**
     * Pinga o main (F-764 C.7). Resolve quando ele atende; a demora é o sinal
     * de main ocupado que a faixa "Nexus ocupado" mostra.
     */
    heartbeat(): Promise<{ at: number }>;
    /** Open an external http(s) URL in the OS browser. */
    openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
    /** Inicia o login OAuth (nonce local + browser) no processo main. */
    authLogin(provider: 'github' | 'google'): Promise<{ ok: boolean; error?: string }>;
    /** Resultado do login quando o navegador devolve o deep link nexus://auth. */
    onAuthLoginResult(cb: (result: LoginResultEvent) => void): Unsubscribe;
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
    /** Deep link nexus://quota (Redline → seção Uso e cotas). */
    onDeepOpenQuota(cb: () => void): Unsubscribe;
    /**
     * Deep link nexus://new?prompt=… (estilo t3code): abre o formulário de
     * nova missão com o prompt pronto — nunca inicia o trabalho sozinho.
     */
    onDeepOpenNew(cb: (payload: { prompt: string | null }) => void): Unsubscribe;
    /**
     * Arquivos entregues pelo Nexus Shot via shot-bridge (main → renderer).
     * Metadados já validados no main: realpath sob ~/Pictures|Movies/Nexus Shot.
     */
    onShotFilesReceived(
      cb: (payload: import('./shot-bridge').ShotFilesReceivedPayload) => void,
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
    logout(): Promise<{ ok: boolean; error?: string }>;
    onChanged(callback: () => void): () => void;
    get(): Promise<LicenseState>;
    openCheckout(request: CheckoutRequest['plan'] | CheckoutRequest): Promise<{ ok: boolean; error?: string }>;
    openPortal(): Promise<{ ok: boolean }>;
    /** Resgata um código de licença ("tenho um código") na conta logada. */
    redeemCode(code: string): Promise<{ ok: boolean; error?: string }>;
  };
  team: {
    get(): Promise<{ ok: boolean; data?: TeamInfo; error?: string; code?: LicenseErrorCode; blockedReason?: LicenseDenialReason }>;
    join(code: string): Promise<{ ok: boolean; error?: string; code?: LicenseErrorCode; blockedReason?: LicenseDenialReason }>;
    invite(): Promise<{ ok: boolean; data?: { code: string; url: string } & Partial<InviteInfo>; error?: string; code?: LicenseErrorCode; blockedReason?: LicenseDenialReason }>;
    removeMember(accountId: string): Promise<{ ok: boolean; error?: string; code?: LicenseErrorCode; blockedReason?: LicenseDenialReason }>;
    leave(): Promise<{ ok: boolean; error?: string; code?: LicenseErrorCode; blockedReason?: LicenseDenialReason }>;
  };
  /**
   * Reporte de problema. O renderer só entrega o que a pessoa digitou e
   * escolheu; diagnóstico, redação e envio (com a sessão) são do Main.
   */
  bugReport: {
    /** Corpo exato (já redigido) que o envio mandaria. Não envia nada. */
    preview(request: BugReportRequest): Promise<BugReportPreviewResult>;
    submit(request: BugReportRequest): Promise<BugReportSubmitResult>;
    /** Menu "Ajuda → Reportar um problema…" pediu o diálogo. */
    onOpenRequest(cb: () => void): Unsubscribe;
  };
  /**
   * Recibo da escolha de conta de uma sessão PTY, somente leitura: qual conta o
   * pane usa e por quê. O Main já devolve o recibo mascarado e saneado (nunca
   * id, fingerprint, e-mail cru nem token); `null` = sessão sem recibo.
   */
  accountChoice: {
    get(sessionId: string): Promise<AccountChoiceReceipt | null>;
  };
  /**
   * Aprovação estruturada (PRV-02): pedidos do hook PermissionRequest que
   * esperam no Main. A resposta é uma DECISÃO entregue ao hook, nunca tecla no
   * PTY. `setVisibleSurfaces` diz ao Main quais sessões têm o card visível —
   * só elas fazem o hook esperar pelo desktop.
   */
  approvals: {
    list(): Promise<ApprovalRequestView[]>;
    respond(request: {
      requestId: string;
      expectedRevision: number;
      optionId: ApprovalDecision;
    }): Promise<{ status: 'accepted' | 'rejected'; reason?: string }>;
    setVisibleSurfaces(sessionIds: string[]): Promise<boolean>;
    onChanged(cb: (requests: ApprovalRequestView[]) => void): Unsubscribe;
  };
  pty: {
    spawn(req: SpawnRequest): Promise<SpawnResult>;
    /** Pull retained output immediately (used after adopting a headless PTY). */
    replay(sessionId: string): Promise<void>;
    write(sessionId: string, data: string): void;
    writeConfirmed(sessionId: string, data: string): Promise<boolean>;
    promptState(sessionId: string): Promise<PtyPromptState | null>;
    submitPromptEnter(sessionId: string, turnStartSequence: number, retry: boolean): Promise<boolean>;
    resize(
      sessionId: string,
      cols: number,
      rows: number,
      options?: {
        assert?: boolean;
        reported?: { cols: number; rows: number };
      },
    ): void;
    kill(sessionId: string): void;
    onData(
      sessionId: string,
      cb: (data: string, meta?: PtyDataMeta) => void,
    ): Unsubscribe;
    onExit(
      sessionId: string,
      cb: (event: { exitCode: number; signal?: number; terminationOrigin?: string }) => void,
    ): Unsubscribe;
    onStateChange(
      sessionId: string,
      cb: (state: PaneSessionState) => void,
    ): Unsubscribe;
  };
  browser: {
    profileStatus(paneId: string): Promise<import('./browser-profile').BrowserProfileStatus>;
    profileChange(paneId: string, change: import('./browser-profile').BrowserProfileChange): Promise<import('./browser-profile').BrowserProfileStatus>;
    importProfiles(paneId: string): Promise<import('./browser-profile').BrowserImportProfile[]>;
    importSites(paneId: string, profileId: string): Promise<import('./browser-profile').BrowserImportSite[]>;
    importCookies(paneId: string, profileId: string, domains: string[]): Promise<import('./browser-profile').BrowserImportResult>;
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
    /** Diagnostic-only Jarvis probe; never reads project state or executes actions. */
    jarvisSmokeTest(req: import('./voice-ipc').JarvisSmokeTestRequest): Promise<JarvisReply>;
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
  decisionModels: {
    status(): Promise<DecisionModelStatus>;
    setKey(req: SetDecisionKeyRequest): Promise<{ ok: boolean; error?: string }>;
    test(req?: TestDecisionModelRequest): Promise<JevTestResult>;
    /** F-1167: custo estimado da calibração, sem chamar provedor. */
    calibrationPlan(): Promise<DecisionCalibrationPlan>;
    /** F-1167: calibra os modelos com credencial (só por clique do operador). */
    calibrate(): Promise<DecisionCalibrationResult>;
    /** F-1167: cancela a calibração em curso (as medições anteriores continuam). */
    cancelCalibration(): Promise<DecisionCalibrationCancelResult>;
    /** F-1167: gasto e dicas do motor numa missão do workspace atual (só leitura). */
    missionPanel(missionId: string): Promise<DecisionMissionPanelResult>;
  };
  jev: {
    /** Status sem segredo (presença da chave, autopilot, stats de uso). */
    status(): Promise<JevStatus>;
    setKey(req: SetJevKeyRequest): Promise<{ ok: boolean; error?: string }>;
    test(): Promise<JevTestResult>;
    /** Últimas decisões do diário Jev (learning loop, sem texto do state). */
    decisionsList(req?: {
      limit?: number;
      surface?: string;
      /** Inclui consultas sem resposta (kind 'no-answer'). */
      includeNoAnswer?: boolean;
    }): Promise<JevDecisionRow[]>;
    decisionsFeedback(req: {
      id: string;
      verdict: 'right' | 'wrong';
    }): Promise<{ ok: boolean; error?: string }>;
    decisionsStats(): Promise<JevDecisionStatsResult>;
    /**
     * Desempate de "abre a missão X" entre títulos parecidos (surface
     * missionPick). Devolve a posição escolhida ou "sem decisão"; nunca lança.
     */
    missionPick(req: MissionPickRequest): Promise<MissionPickResult>;
    /** Push do classificador Jev de estado do pane (surface paneState). */
    onPaneHint(cb: (event: JevPaneHintEvent) => void): Unsubscribe;
  };
  mission: {
    prepare(request: MissionPrepareRequest): Promise<MissionReview>;
    routeIntent(objective: string): Promise<unknown>;
    answerDirect(question: string): Promise<string | null>;
    start(input: {
      missionId: string;
      reviewSha256: string;
      /**
       * Painel vivo que deve LIDERAR esta missão em vez de o motor subir um
       * Maestro próprio (adoção). Usado quando a missão nasceu de um "Tornar
       * orquestrador" num terminal que o operador já estava usando.
       */
      adoptOrchestratorPaneId?: string;
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
    /** Main → renderer (0.76.45): o guardian estacionou este pane — a sessão
     * PTY já foi encerrada; o renderer marca `parked` e oferece "Acordar". */
    onPaneParkRequest(cb: (request: PaneParkRequest) => void): Unsubscribe;
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
    }): Promise<import('./orch-types').MissionPaneRestoreAuthority>;
    /**
     * F-1173: checkpoints ocultos dos writers da missão. O renderer manda
     * missionId (+ ref); a árvore sai sempre da autoridade do Main.
     */
    listMissionCheckpoints(input: {
      missionId: string;
    }): Promise<import('./mission-checkpoints').MissionCheckpointListResult>;
    previewMissionCheckpoint(
      input: import('./mission-checkpoints').MissionCheckpointRefInput,
    ): Promise<import('./mission-checkpoints').MissionCheckpointPreviewResult>;
    restoreMissionCheckpoint(
      input: import('./mission-checkpoints').MissionCheckpointRestoreInput,
    ): Promise<import('./mission-checkpoints').MissionCheckpointRestoreResult>;
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
      code?: LicenseErrorCode;
      blockedReason?: LicenseDenialReason;
    }>;
    /**
     * "Tornar orquestrador" num pane solto: cria a missão leve da aba
     * (Autopilot, livre, sem squad) liderada por ele. `error: 'hardened'`
     * quando a política exige despacho explícito. `tabKey` só desempata
     * criação/reuso da missão da aba no main; não concede nada.
     */
    createPaneMission(input: {
      paneId: string;
      title: string;
      tabKey?: string;
      /** Missão do GRUPO do pane: nunca reusa nem toma a missão viva da aba. */
      ownGroup?: boolean;
    }): Promise<{
      ok: boolean;
      mission?: Mission;
      warning?: string;
      error?: string;
    }>;
    /**
     * F-231 — "+ Pane" numa aba de missão com destino "Nesta missão": abre um
     * worker `operatorOpened` pelo caminho Main-owned. Escopo, status da
     * missão, adapter instalado/cli-pty e roster selado são conferidos no
     * Main — o payload nunca vira autoridade. `error` legível na recusa
     * (`roster_rejected`, `mission_not_running`, `adapter_not_installed`,
     * `adapter_not_spawnable`, `hardened`).
     */
    spawnOperatorPane(input: {
      missionId: string;
      adapterId: string;
      model?: string;
      /** Id do cofre, inclusive conta sem e-mail; nunca fingerprint. */
      accountId?: string;
      prompt?: string;
      tabKey?: string;
    }): Promise<
      | { ok: true; paneId: string; sessionId: string }
      | { ok: false; error: string }
    >;
    /**
     * Retry the orchestrator bootstrap of a mission the bootstrap itself
     * blocked (blocked_technical + marker). Main re-arms and re-validates.
     */
    resumeMissionBootstrap(input: {
      missionId: string;
    }): Promise<MissionOrchestratorBootstrapResult>;
    /**
     * Mission event journal — recent projection (flag feature.mission.eventJournal).
     * F-1005: `beforeSequence` pede a página anterior; `total` é o tamanho do
     * journal da missão e `hasMore` diz se há eventos antes desta página.
     */
    missionEventsRecent(input: {
      missionId: string;
      limit?: number;
      beforeSequence?: number;
    }): Promise<{
      events: unknown[];
      enabled?: boolean;
      error?: string;
      total?: number;
      hasMore?: boolean;
    }>;
    /**
     * ORC-10: acima de 128 eventos ou 1 MiB depois do cursor (ou cursor além
     * da maior sequência) vem `snapshot`: `events` são os mais recentes e o
     * próximo replay parte de `snapshot.cursor`.
     */
    missionEventsReplay(input: {
      missionId: string;
      afterSequence?: number;
      limit?: number;
      runId?: string;
    }): Promise<{
      events: unknown[];
      enabled?: boolean;
      error?: string;
      snapshot?: { cursor: number; hasMoreHistory: boolean };
    }>;
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
    importSquads(): Promise<{
      ok: boolean;
      count?: number;
      /** Ids do próprio Nexus no arquivo (internos/cópias de missão), ignorados. */
      skipped?: string[];
      error?: string;
    }>;
    getMcpInfo(): Promise<McpRuntimeInfo>;
    getCatalogIndex(refresh?: boolean): Promise<CatalogIndexResult>;
    installCatalogItem(req: {
      kind: 'agent' | 'skill';
      slug: string;
    }): Promise<CatalogInstallResult>;
    /**
     * F-757: agentes e instruções do catálogo que o modelo de decisão escolheu
     * para a stack do workspace. Nunca instala; `refresh` ignora o cache de 24 h.
     */
    recommendCatalog(refresh?: boolean): Promise<CatalogRecommendationsResult>;
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
    /** O CLI pedido não sentou (morreu no boot, ou o assento foi remapeado). */
    onWorkerSpawnFailed(
      cb: (event: PaneWorkerSpawnFailedEvent) => void,
    ): Unsubscribe;
  };
  remote: {
    bridgeStatus(): Promise<RemoteBridgeInfo>;
    bridgeStart(req?: RemoteBridgeStartRequest): Promise<RemoteBridgeInfo>;
    bridgeStop(): Promise<RemoteBridgeInfo>;
    /** MOB-12: `scopes` ausente = o novo código concede todos os escopos. */
    bridgeRotatePairing(req?: { scopes?: RemoteDeviceScope[] }): Promise<RemoteBridgeInfo>;
    bridgeRevokeTokens(): Promise<RemoteBridgeInfo>;
    bridgeSetDeviceScopes(
      req: RemoteBridgeSetDeviceScopesRequest,
    ): Promise<RemoteBridgeInfo & { error?: string }>;
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
    /** `jevSurfaces` parcial é MESCLADO no Main (F-1167): só as chaves enviadas mudam. */
    orchSet(patch: OrchSettingsPatch): Promise<OrchSettings>;
    audioGet(): Promise<AudioSettings>;
    audioSet(patch: AudioSettingsPatch): Promise<AudioSettings>;
    onAudioChanged(cb: (audio: AudioSettings) => void): Unsubscribe;
    listShells(): Promise<string[]>;
    uiGet(): Promise<UiSettings>;
    uiSet(patch: UiSettingsPatch): Promise<UiSettings>;
    onUiChanged(cb: (ui: UiSettings) => void): Unsubscribe;
    /** Gasto mensal real (USD) editado em Uso e custos. */
    spendGet(): Promise<SpendSettings>;
    /** A lista `entries` substitui a salva por inteiro. */
    spendSet(patch: SpendSettingsPatch): Promise<SpendSettings>;
    onSpendChanged(cb: (spend: SpendSettings) => void): Unsubscribe;
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
    authStatus(options?: {
      freshClaudeCredential?: boolean;
    }): Promise<AdapterAuthStatus[]>;
    /** Instala a CLI pela receita oficial (confirmação nativa no main). */
    installCli(
      adapterId: string,
      mode?: 'install' | 'update',
    ): Promise<{ ok: boolean; error?: string; changed?: boolean; version?: string }>;
    getCliAutoUpdates(): Promise<CliAutoUpdateStatus>;
    setCliAutoUpdates(enabled: boolean): Promise<CliAutoUpdateStatus>;
    addModel(adapterId: string, model: string): Promise<ProviderSettingsInfo[]>;
    removeModel(adapterId: string, model: string): Promise<ProviderSettingsInfo[]>;
    /**
     * Saúde do cofre multi-PC. `foreign-or-locked` = o `secrets.enc` veio de
     * outra máquina (safeStorage é amarrado ao keychain local) — use
     * export/import, não redefina a key.
     */
    vaultState(): Promise<'empty' | 'readable' | 'foreign-or-locked' | 'partial'>;
    /** Exporta as keys legíveis para um arquivo cifrado por passphrase. */
    exportSecrets(passphrase: string): Promise<{
      ok: boolean;
      error?: string;
      exportedKeys?: number;
      skippedKeys?: string[];
      path?: string;
    }>;
    /** Importa um bundle exportado e regrava com o safeStorage desta máquina. */
    importSecrets(bundle: string, passphrase: string): Promise<{
      ok: boolean;
      error?: string;
      importedKeys?: number;
      failedKeys?: string[];
    }>;
    onChanged(cb: (list: ProviderSettingsInfo[]) => void): Unsubscribe;
  };
  files: {
    list(relPath: string): Promise<FileTreeResult>;
    read(relPath: string): Promise<ReadFileResult>;
    /** Arquivos do workspace por nome (paleta, Mod+P); main fixa a raiz. */
    search(query: string): Promise<SearchFilesResult>;
    write(relPath: string, content: string): Promise<{ ok: boolean; error?: string }>;
    saveDropped(name: string, base64: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    /**
     * Copy an external audio/image/text blob into
     * `.nexus/attachments/mission-context/` and return the root-relative path.
     */
    importMissionAttachment(
      name: string,
      base64: string,
    ): Promise<{ ok: boolean; path?: string; absolutePath?: string; error?: string }>;
    /**
     * Drop that carried no `File`, only a `file://` path or an http(s) link:
     * main reads/downloads it and stages it in mission-context like above.
     */
    importDroppedUri(
      uri: string,
    ): Promise<{ ok: boolean; path?: string; absolutePath?: string; error?: string }>;
    /**
     * Files copied in Finder/Explorer live on the system pasteboard as file
     * URLs Chromium does not always expose to the paste event; Main reads
     * them. Only file:// URIs, never contents.
     */
    clipboardFileUris(): Promise<{ uris: string[] }>;
    /**
     * HEIC/HEIF bytes → JPEG bytes, decoded by the OS in Main (macOS `sips`).
     * Other systems answer `unsupported` with a readable message.
     */
    convertHeicToJpeg(bytes: Uint8Array): Promise<HeicConvertResult>;
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
    /** F-1171: transcripts das CLIs do checkout → histórico persistido. */
    importCliHistory(req: CliHistoryImportRequest): Promise<CliHistoryImportResult>;
    /** F-1171: busca paginada no histórico persistido (importado + gravado). */
    searchHistory(
      req: CommandHistorySearchRequest,
    ): Promise<CommandHistorySearchResult>;
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
      accountId?: string,
    ): Promise<{ ok: boolean; id?: string; email?: string; error?: string }>;
    supportsSnapshot(
      adapterId: string,
    ): Promise<{ ok: boolean; supported?: boolean }>;
    prepareAgyLogin(): Promise<{ ok: boolean; error?: string }>;
    restoreAgyLogin(): Promise<{ ok: boolean }>;
    /** Esvazia a vaga do `~/.codex/auth.json` antes do login (o `codex login` revoga o login que encontra). */
    prepareCodexLogin(): Promise<{ ok: boolean; error?: string }>;
    restoreCodexLogin(): Promise<{ ok: boolean }>;
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
  /**
   * Velocidade de geração por rodada: tok/s, TTFT, média/pico das últimas N.
   * Read-only — o renderer observa o cronômetro, nunca o comanda.
   */
  tokenSpeed: {
    snapshot(): Promise<TokenSpeedSnapshot>;
    onChanged(cb: (snapshot: TokenSpeedSnapshot) => void): Unsubscribe;
  };
  /** Telemetria REAL de tokens (transcript watchers → SQLite). */
  usage: {
    snapshot(): Promise<UsageSnapshot | null>;
    /**
     * Totais de vida útil (todos os escopos): tokens torrados, equivalente
     * USD de API pública, panes e turnos — alimenta o Perfil de Operador.
     */
    lifetime(): Promise<import('./pet-types').PetLifetimeStats>;
    /**
     * Rollup diário limitado (90 dias) dos mesmos totais — gráfico de uso.
     * Opcional: pontes antigas e embeds não o têm, e a tela some com o gráfico.
     */
    history?(): Promise<import('./usage-types').UsageHistory>;
    onChanged(cb: (snapshot: UsageSnapshot) => void): Unsubscribe;
  };
  /**
   * Fleet provider quota windows (session / hours / weekly). Distinct from
   * project token spend in `usage`. Unknown ratios are null, never fake 0%.
   */
  quota: {
    connectMimo(accountId?: string): Promise<{ ok: boolean; message: string }>;
    snapshot(): Promise<import('./quota-types').QuotaFleetSnapshot>;
    refresh(): Promise<import('./quota-types').QuotaFleetSnapshot>;
    onChanged(
      cb: (snapshot: import('./quota-types').QuotaFleetSnapshot) => void,
    ): Unsubscribe;
  };
  /** Nexus Redline — app companheiro de menu bar (instalar/abrir/status). */
  redline: {
    status(): Promise<import('./redline-types').RedlineInstallStatus>;
    install(): Promise<{ ok: boolean; message: string }>;
    open(): Promise<{ ok: boolean; message: string }>;
    /** Linux: tira o Redline da bandeja do sistema. */
    hide(): Promise<{ ok: boolean; message: string }>;
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
    /** Push periódico (30s) do footprint por pane — ver PERF_CHANNELS.paneFootprints.
     * O primeiro ouvinte assina a coleta no main; o último a desliga (QLT-11). */
    onPaneFootprints(cb: (event: PaneFootprintBroadcast) => void): Unsubscribe;
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
  pipes: PipeApi;
  /** Fase 5 — Jarvis Vision: screen capture + AX tree + OCR */
  vision: VisionApi;
  platform: NodeJS.Platform;
  /**
   * F-673: build do Windows (ex.: 26200) para o xterm tratar o ConPTY como
   * ConPTY; null fora do Windows ou quando a versão não é legível.
   */
  windowsBuild: number | null;
}
