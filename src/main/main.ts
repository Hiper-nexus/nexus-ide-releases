// DEVE ser o primeiro import: `nexus-ide --redline-status` (barra do desktop) roda e sai aqui.
import './redline/redline-cli-boot';
import { stopOrientationForWorkspace } from './context/orientation/orientation-bootstrap';
import { stopQwenReadiness } from './adapters/qwen-readiness-cache';
import { stopPaneSessionOutputGc } from './orch/pane-session-output';
import { stopPetPeriodicWork } from './pet/pet-window';
import { stopPreGoneCrashSampling } from './crash-reporting/process-gone-diagnostics';
import { stopManagedAuthSpawnGateWatchers } from './adapters/managed-auth-spawn-gate';
import { initializeLicenseAuthority } from "./license-bootstrap";
import './macos-activation-policy';
import { registerArmsIpc } from './connectors/arms-ipc';
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  powerSaveBlocker,
  protocol,
  systemPreferences,
} from "electron";
import { resolveUserPath, retryLoginShellPathIfMissed } from "./path-resolver";
import {
  createMainWindow,
  startMainWindowRenderer,
} from "./window";
import {
  installRendererProtocol,
  registerRendererProtocolScheme,
} from "./renderer-protocol";
import { registerAuthProbeIpc } from "./adapters/auth-probe";
import {
  isCurrentProcessSmokeTest,
  shouldUseUserDataOverride,
} from "./smoke-core";
import {
  restoreMainWindowOnActivate,
  shouldCreateWindowOnActivate,
} from "./app-lifecycle";
import {
  startMacOSDockWatchdog,
  stopMacOSDockWatchdog,
} from './macos-activation-policy';
import { configureWindowsAppIdentity } from './windows-app-identity';
import { configureLinuxSecretStore } from './linux-secret-store';

// Squirrel supplies this same AUMID to the installed launcher. Make the
// Electron process explicit too, before a BrowserWindow is created, so Windows
// resolves a fresh NexusIDE icon instead of a generic pinned shortcut tile.
configureWindowsAppIdentity(process.platform, (id) => app.setAppUserModelId(id));

// Linux fora de GNOME/KDE (Hyprland/Omarchy, sway…): o Chromium cairia no
// backend `basic_text`, que o cofre recusa, e o login não teria onde salvar a
// sessão. Precisa valer antes do `ready`, quando o OSCrypt lê o switch.
configureLinuxSecretStore(app.commandLine, {
  platform: process.platform,
  env: process.env,
  automatedTest: isCurrentProcessSmokeTest(),
});

// Must run before Electron emits `ready`. The handler itself is installed in
// bootstrap (after ready), before the first BrowserWindow is created.
registerRendererProtocolScheme(protocol);

// O Nexus orquestra agentes de longa duração: o Chromium NUNCA pode throttlar
// os timers do processo (em background/oculto o message pump adia a fase de
// timers do main indefinidamente sob I/O contínuo de PTY — worker spawn/merge
// do scheduler congelavam com o app fora de foco).
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch(
  'disable-features',
  'IntensiveWakeUpThrottling,TimerThrottlingForBackgroundTabs',
);

// Sandbox de userData para dev/testes explícitos: redireciona SQLite, layout,
// sessões e o single-instance lock. Launches normais empacotados nunca
// obedecem o override.
const userDataOverride = process.env.NEXUS_USER_DATA_DIR;
if (
  userDataOverride &&
  shouldUseUserDataOverride(app.isPackaged, process.argv, userDataOverride)
) {
  app.setPath("userData", userDataOverride);
}

// GPU fallback must run before whenReady so disableHardwareAcceleration takes effect.
// Marker is written by handleChildProcessGone when Windows GPU crashes cluster after launch.
try {
  const userDataPath = app.getPath("userData");
  // main.trace.ndjson (campanha 0.50, A7): primeira linha de toda sessão —
  // o pós-mortem começa sabendo qual versão/boot está lendo.
  trace({
    kind: "main-boot",
    version: app.getVersion(),
    electron: process.versions.electron ?? "unknown",
    platform: process.platform,
  });
  const marker = readActiveGpuFallbackMarker(userDataPath, {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "unknown",
    platform: process.platform,
  });
  if (marker) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu");
    setGpuFallbackActiveThisLaunch(true);
    console.warn(
      "[main] GPU software fallback active for this launch (marker from prior GPU crash burst)",
    );
  }
} catch (err) {
  console.warn("[main] GPU fallback marker read failed:", err);
}

// Main thread vigiada (F-764). O handle fica no módulo: o monitor de
// event-loop alimenta a linha de travamento com o "como estava antes".
let hangWatchdog: HangWatchdogHandle | null = null;
configurePeriodicTaskSlowSink(diagnostic => {
  if (diagnostic.name !== 'event-loop-monitor') trace({ kind: 'periodic-task-slow', ...diagnostic });
});
try {
  const hangProbe = isSmokeHangProbeRequested({
    smokeTest: isCurrentProcessSmokeTest(),
    env: process.env,
  });
  const busyBannerProbe = isSmokeBusyBannerProbeRequested({
    smokeTest: isCurrentProcessSmokeTest(), env: process.env, userDataPath: app.getPath('userData'),
  });
  const smokeHangWatchdog = hangProbe || busyBannerProbe;
  // Hang watchdog (campanha 0.50, C7; F-764 A.1): main pendurada vira marker
  // em disco e `.cpuprofile` do que ela estava rodando. Só empacotado — dev
  // pausa em debugger por design (doutrina Orca) — ou no probe do smoke.
  if (app.isPackaged || smokeHangWatchdog) {
    hangWatchdog = startMainThreadHangWatchdog({
      logsDir: path.join(app.getPath("userData"), "logs"),
      version: app.getVersion(),
      runtimeContext: sampleHangRuntimeContext,
      ...(smokeHangWatchdog
        ? { tuning: SMOKE_HANG_PROBE_TUNING, heartbeatMs: SMOKE_HANG_PROBE_HEARTBEAT_MS }
        : {}),
      // A worker grava o histórico sozinha; quando a main volta, as mesmas
      // linhas entram no trace — o pós-mortem lê uma linha do tempo só.
      onRecord: (record) => {
        trace({ ...record });
        if (smokeHangWatchdog) console.log(describeHangRecordForSmoke(record));
      },
    });
  }
  // F-764 A.3: p50/p99/max do event-loop a cada 30 s. Trace só com agente
  // vivo ou atraso perceptível; todo resumo segue para o watchdog.
  startEventLoopMonitor({
    liveAgents: countLiveAgentSessions,
    onSummary: (summary) => hangWatchdog?.reportEventLoop(summary),
  });
  if (hangProbe) {
    // Probe do smoke empacotado: trava a main AQUI, antes de qualquer serviço
    // ou timer do boot existir; o harness confere o `.cpuprofile`.
    console.log(`[smoke] hang-probe: travando a main por ${SMOKE_HANG_PROBE_BLOCK_MS} ms`);
    induceSmokeMainHang();
    console.log("[smoke] hang-probe: main liberada");
  }
} catch (err) {
  console.warn("[main] main-thread watchdog/event-loop monitor failed to arm:", err);
}

// Remote debugging (Chrome DevTools Protocol) is a full local-RCE surface: any
// process that connects to the port can run JS in the renderer, and the preload
// exposes PTY/file APIs. It used to be ON for every dev run on a fixed 9223;
// now it is OPT-IN via NEXUS_REMOTE_DEBUG and never available in a packaged
// build (SEC#8). Set the env var to a port (1024–65535) to pin one, or to any
// other value to let Chromium pick a FREE port, written to
// <userData>/DevToolsActivePort. Enable only on a trusted machine.
const remoteDebug = process.env.NEXUS_REMOTE_DEBUG;
if (!app.isPackaged && remoteDebug) {
  const requested = Number(remoteDebug);
  const port =
    Number.isInteger(requested) && requested >= 1024 && requested <= 65535
      ? String(requested)
      : "0";
  app.commandLine.appendSwitch("remote-debugging-port", port);
  console.warn(
    "[main] AVISO: remote debugging (CDP) habilitado na porta " +
      (port === "0" ? "aleatória (ver DevToolsActivePort)" : port) +
      ". Qualquer processo local pode executar JS no renderer — use só em máquina confiável.",
  );
}
import {
  configurePtyProjectRuntimeManager,
  registerPtyIpc,
} from "./pty/pty-ipc";
import { nativeHeavyJobEnvironment } from "./orch/native-heavy-preload";
import {
  registerBrowserIpc,
  destroyBrowsersFor,
} from "./browser/browser-manager";
import { registerPerfIpc } from "./perf/perf-ipc";
import {
  closeAllDesignWritebacks,
  closeDesignWritebackFor,
  registerDesignWritebackIpc,
} from "./design/design-ipc";
import { registerLayoutIpc } from "./persistence/layout-ipc";
import { registerAdapterIpc } from "./adapters/adapter-ipc";
import { registerVoiceIpc, closeVoiceIpc } from "./voice/voice-ipc";
import { registerJevIpc } from "./jev/jev-ipc";
import { registerMissionPickIpc } from "./jev/jev-mission-pick-ipc";
import { registerDecisionModelIpc } from "./decision-models/decision-model-ipc";
import { registerVisionIpc } from "./vision/ipc-bridge";
import {
  initAdapterRegistry,
  listAdapterInfos,
  registerAdapterListener,
  unregisterAdapterListener,
  closeAdapterRegistry,
  rescanAdapterBinaries,
} from "./adapters/adapter-registry";
import {
  initOrchestration,
  registerOrchIpc,
  registerOrchListener,
  unregisterOrchListener,
  closeOrchestration,
  configureRendererMissionAuthority,
} from "./orch/orch-ipc";
import { quiesceOrchestrationCoordinator } from "./orch/orchestration-coordinator";
import { nativeHeavyCommands } from "./orch/native-heavy-command";
import { drainMissionShimDisposals } from "./orch/mcp-server";
import {
  initNonWorkerAutoClose,
  shutdownNonWorkerAutoClose,
} from "./orch/pane-non-worker-auto-close";
import { refreshSystemMemorySample } from "./orch/pane-admission";
import {
  startPaneFootprintBroadcast,
  stopPaneFootprintBroadcast,
} from "./perf/pane-footprint-broadcast";
import { ProjectRuntimeManager } from "./runtime/project-runtime-manager";
import {
  buildMultiPcBackendStatus,
  configureNexusDoctorRuntime,
  disposeNexusDoctorRuntime,
} from "./runtime/nexus-doctor-bootstrap";
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
} from "./context/context-workflow-registry";
import {
  configureWorktreeRuntimeRegistry,
  disposeWorktreeRuntimeRegistry,
} from "./runtime/worktree-runtime-registry";
import {
  configureAgentHookEndpointPath,
  APP_SHUTDOWN_PTY_TERMINATION,
  countLiveAgentSessions,
  stopSessionMortalityReconciler,
  getAgentSessionInfo,
  listLiveSessionLocations,
  orchTerminateSession,
  sessionAdapterId,
  tapSessionExit,
  terminateAllSessions,
} from "./pty/pty-manager";
import { setPaneTerminalIdentity } from "./pty/pane-terminal-identity";
import {
  rememberExitedSessionAttribution,
  routeAttributionFromSession,
  setHandoffRouteAttributionResolver,
} from "./orch/handoff-store";
import { configureWorktreePtySweep } from "./runtime/worktree-pty-sweep";
import {
  liveRuntimeProcessSummary,
  sealRuntimeProcessAdmissionForShutdown,
} from "./runtime-process-inventory";
import { shutdownPtyHost } from "./pty/pty-host-client";
import {
  hasExactPhysicalInventoryProof,
  shutdownOrchestrationRuntimesRecordingStragglers,
} from "./app-shutdown";
import {
  createQuitIncidentFileRecorder,
  createUnclearableQuitCeiling,
  QUIT_CEILING_MS,
  sweepOrphanPtySupervisors,
} from "./app-quit-guarantee";
import { shutdownAllAcpDriverSessions } from "./acp/acp-harness-driver";
import { createShutdownNoticeController } from "./app-shutdown-ui";
import {
  ensureCommandBlockTracking,
  setCommandBlockPersistHook,
} from "./terminal/command-block-tracker";
import { ensureSessionExitMemoryDistiller } from "./memory/session-exit-memory";
import { createCommandBlockPersister } from "./terminal/command-block-persist";
import { configureMissionEventEmit } from "./orch/mission-event-emit";
import { installObserverMissionEventProjector } from "./orch/observer-mission-event-projector";
import { installOperatorCliMentionTap } from "./orch/operator-cli-mentions";
import {
  installMissionDiskProjection,
  uninstallMissionDiskProjection,
} from "./orch/mission-disk-projection";
import { registerTerminalBlockActionsIpc } from "./terminal/terminal-block-actions-ipc";
import { registerSearchMixerIpc } from "./search/search-mixer-ipc";
import { getSearchMixer } from "./search/search-mixer-bootstrap";
import { registerProductWaveIpc } from "./product-wave-ipc";
import { registerDiscoveryIpc } from "./discovery/discovery-ipc";
import { registerMemoryIpc } from "./memory/memory-ipc";
import { flushWorkspaceMemoryProjections } from "./memory/workspace-memory";
import { registerModelMetadataIpc } from "./adapters/model-metadata-ipc";
import { registerMissionEventIpc } from "./orch/mission-event-ipc";
import { startAgentLifecycleService, stopAgentLifecycleService } from "./agents/agent-lifecycle-service";
import {
  configureFeatureFlagRegistry,
  enableAllProductFlagsForTesting,
} from "./feature-flags/feature-flag-registry";
import {
  initUsageTelemetry,
  shutdownUsageTelemetry,
} from "./usage/usage-service";
import {
  initQuotaService,
  requireQuotaService,
  shutdownQuotaService,
} from "./quota/quota-service";
import { probeClaudeCliUsage } from "./quota/claude-oauth-usage";
import { fetchClaudeAccountUsageWindows } from "./quota/claude-account-usage";
import { detectProviderPlan } from "./quota/account-plan";
import { createRedlineSink } from "./quota/redline-sink";
import {
  initRedlineIpc,
  maybeOfferRedlineInstall,
  shutdownRedlineIpc,
  startRedlineLinuxIfEnabled,
  syncInstalledRedline,
} from "./redline/redline-install";
import {
  initializeProviderConfigStore,
  listProviderSettings,
  maybeOfferFirstRunProvisioning,
  resolveQuotaApiKey,
} from "./persistence/provider-config-store";
import {
  clearCooldown,
  clearRefutedAuthCooldown,
  isAuthCooldownReason,
  listAccountInfos,
  listAccounts,
  setCooldown,
  startClaudeSubscriptionFreshness,
  stopClaudeSubscriptionFreshness,
} from "./persistence/account-store";
import {
  resolveClaudeToken,
  resolveCodexAuthCandidates,
  resolveGeminiAccessToken,
  resolveGeminiOauthCreds,
  resolveGrokAccessTokenCandidates,
  resolveKimiAccessTokenCandidates,
  resolveKimiOauthCreds,
  resolveProviderApiKeyCandidates,
} from "./quota/provider-usage-auth";
import {
  minimaxCodeHasCredential,
  minimaxCodeLoginAccessToken,
} from "./adapters/minimax-code-auth";
import { closeDb } from "./persistence/db";
import {
  getOrchSettings,
  migrateRetiredOrchestratorSettings,
  registerSettingsIpc,
  registerSettingsListener,
  unregisterSettingsListener,
} from "./persistence/settings-store";
import {
  getWorkspaceState,
  probeCurrentWorkspaceLiveness,
  registerWorkspaceIpc,
  registerWorkspaceListener,
  unregisterWorkspaceListener,
} from "./persistence/workspace-store";
import { configureProjectOrientationService } from "./context/orientation/orientation-service";
import { registerOrientationIpc } from "./context/orientation/orientation-ipc";
import { registerContextDraftIpc } from "./context/context-draft-ipc";
import { resolveProjectExecutionScopeCached } from "./persistence/project-identity";
import {
  registerProviderIpc,
  registerProviderListener,
  startCliAutoUpdate,
  unregisterProviderListener,
} from "./persistence/provider-config-store";
import { registerFilesIpc } from "./persistence/files-ipc";
import {
  registerAccountIpc,
  registerAccountListener,
  unregisterAccountListener,
} from "./persistence/account-ipc";
import {
  registerCostIpc,
  registerCostListener,
  unregisterCostListener,
} from "./orch/cost-ipc";
import {
  registerTokenSpeedIpc,
  registerTokenSpeedListener,
  unregisterTokenSpeedListener,
} from "./orch/token-speed-ipc";
import { registerBillingIpc } from "./persistence/billing-ipc";
import { registerAccountChoiceIpc } from "./persistence/account-choice-ipc";
import { syncLicenseOnBoot, stopLicenseSync } from "./license-sync";
import { registerTeamIpc } from "./team-ipc";
import { installAppMenu } from "./app-menu";
import { findTrustedMainWindow } from "./security/trusted-ipc";
import {
  registerBugReportIpc,
  requestOpenBugReportDialog,
} from "./bug-report/bug-report-ipc";
import { initDesktopPet, ingestPetGamification, isPetWindow } from "./pet/pet-window";
import {
  registerPipeIpc,
  registerPipeListener,
  unregisterPipeListener,
} from "./orch/pane-pipe-ipc";
import { registerRemoteIpc } from "./remote/remote-ipc";
import { registerIntegrationsIpc } from "./integrations/integrations-ipc";
import { registerMediaIpc } from "./media/media-ipc";
import {
  broadcastGamificationToProject,
  registerGamificationIpc,
  registerGamificationListener,
  unregisterGamificationListener,
} from "./gamification/gamification-ipc";
import { registerMcpIpc } from "./jarvis/mcp-ipc";
import { registerOpsIpc } from "./ops/ops-ipc";
import { registerEvalRankingIpc } from "./eval/eval-ipc";
import {
  configureAuditLogRuntime,
  disposeAuditLogRuntime,
} from "./jarvis/audit-log";
import {
  configureGamificationService,
  shutdownGamificationService,
} from "./gamification/gamification-service";
import { GAMIFICATION_CHANNELS } from "../shared/gamification-types";
import { requireProjectDomainStoreRegistry } from "./orch/project-domain-store-registry";
import { closeMissionRuntimePreservingHistory } from "./orch/mission-runtime-termination";
import {
  configureCronRuntime,
  disposeCronRuntime,
  startCronLoop,
  stopCronLoop,
} from "./orch/cron-runtime";
import { createHttpCronBackendFromEnvironment } from "./orch/http-cron-backend";
import {
  configureSyncRuntime,
  disposeSyncRuntime,
} from "./context/sync-runtime";
import { wireDeepLinks, consumeLaunchDeepLink } from "./deep-link";
import { initAutoUpdater, stopAutoUpdater } from "./updater";
import { stopRemoteBridge } from "./remote/remote-bridge";
import { initSmokeTest } from "./smoke-test";
import {
  disposeAgentAwakeService,
  getAgentAwakeService,
  handleChildProcessGone,
  setGpuFallbackActiveThisLaunch,
  configureAgentRuntimeUserDataPath,
} from './agent-runtime/agent-runtime-bridge';
import { registerAgentHookIpc } from './agent-hooks/hook-ipc';
import { bootstrapManagedAgentHooks } from './agent-hooks/register-default-installers';
import {
  installManagedAgentHooks,
  removeManagedAgentHooks,
} from './agent-hooks/managed-agent-hook-controls';
import { resolveManagedHookConsent } from './agent-hooks/hook-consent';
import {
  startAgentHookHttpServer,
  stopAgentHookHttpServer,
} from './agent-hooks/hook-http-server';
import { AgentHookDropBoxWatcher } from './agent-hooks/hook-drop-box';
import {
  startShotBridgeServer,
  stopShotBridgeServer,
} from './shot-bridge/shot-bridge-server';
import { SHOT_BRIDGE_CHANNELS } from '../shared/shot-bridge';
import {
  readActiveGpuFallbackMarker,
} from './crash-reporting/gpu-fallback-marker';
import { readCrashReportPending } from './crash-reporting/crash-report-pending';
import { SessionAliveSentinel } from './crash-reporting/session-alive-sentinel';
import {
  authorizeAppQuit,
  closeNeedsConfirmation,
  QUIT_DIALOG_BUTTONS,
  quitChoiceFromResponse,
  isAppQuitAuthorized,
  revokeAppQuitAuthorization,
} from "./close-authorization";
import { trace, flushMainTrace } from "./observability/main-trace";
import { configurePeriodicTaskSlowSink } from './observability/periodic-task';
import { sampleHangRuntimeContext } from './hang-watchdog/runtime-context';
import {
  startMainThreadHangWatchdog,
  type HangWatchdogHandle,
} from "./hang-watchdog/main-thread-hang-watchdog";
import {
  SMOKE_HANG_PROBE_BLOCK_MS,
  SMOKE_HANG_PROBE_HEARTBEAT_MS,
  SMOKE_HANG_PROBE_TUNING,
  describeHangRecordForSmoke,
  induceSmokeMainHang,
  isSmokeHangProbeRequested,
} from "./hang-watchdog/smoke-hang-probe";
import { isSmokeBusyBannerProbeRequested } from './hang-watchdog/smoke-busy-banner';
import {
  startEventLoopMonitor,
  stopEventLoopMonitor,
} from "./observability/event-loop-monitor";
import { registerMainHeartbeatIpc } from "./observability/main-heartbeat-ipc";

let projectRuntimeManager: ProjectRuntimeManager | null = null;
let hookDropBoxWatcher: AgentHookDropBoxWatcher | null = null;
let sessionAliveSentinel: SessionAliveSentinel | null = null;
/** Nexus Redline (menu bar): sink de snapshots + vigia do pedido de refresh. */
let redlineSink: ReturnType<typeof createRedlineSink> | null = null;
let stopRedlineRefreshWatch: (() => Promise<void>) | null = null;
let stopCliAutoUpdate: (() => void | Promise<void>) | null = null;

function traceBootstrap(phase: string): void {
  if (process.env.NEXUS_BOOT_TRACE === '1') {
    console.info(`[bootstrap] ${phase}`);
  }
}

function knownCronScopes() {
  const state = getWorkspaceState();
  const paths = [state.current?.path, ...state.recents.map((item) => item.path)];
  const scopes: ReturnType<typeof resolveProjectExecutionScopeCached>[] = [];
  const seen = new Set<string>();
  for (const workspacePath of paths) {
    if (!workspacePath || seen.has(workspacePath)) continue;
    seen.add(workspacePath);
    try {
      scopes.push(resolveProjectExecutionScopeCached(workspacePath));
    } catch (error) {
      console.warn("[cron] ignoring invalid known workspace:", error);
    }
  }
  return scopes;
}

// Windows installer housekeeping (no-op elsewhere).
// Evento do Squirrel (--squirrel-install/-updated/-uninstall): o app só
// responde e sai. Rodar o boot aqui relançava o Redline, que herdava o pipe
// de saída do hook, e o instalador/atualizador esperava por ele para sempre
// (0.76.89 travado em "Squirrel Enabled Apps" até o Redline fechar).
let squirrelStartupEvent = false;
if (process.platform === "win32") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require("electron-squirrel-startup")) {
      squirrelStartupEvent = true;
      app.quit();
    }
  } catch {
    // Package not present outside Windows packaging — ignore.
  }
}

async function bootstrap(): Promise<void> {
  // Persisted overrides live under userData; must be configured before the
  // first getFeatureFlagRegistry() call anywhere in bootstrap.
  configureFeatureFlagRegistry({
    overridesPath: path.join(app.getPath("userData"), "feature-flags.json"),
  });
  // Explicit test-only opt-in. Normal dev and packaged launches retain the
  // fail-closed built-in defaults; kill switches remain authoritative.
  if (process.env.NEXUS_FORCE_ALL_FLAGS === '1') {
    enableAllProductFlagsForTesting();
    console.info(
      '[main] product feature flags: forced ON by explicit test override',
    );
  }
  // Loads ~/.nexus/settings.json before any runtime reads orchestration flags.
  registerSettingsIpc();
  initAdapterRegistry();
  initializeProviderConfigStore();
  try {
    migrateRetiredOrchestratorSettings({
      adapters: listAdapterInfos(),
      enabledAdapterIds: new Set(
        listProviderSettings({ nonBlockingAuth: true })
          .filter((provider) => provider.enabled)
          .map((provider) => provider.adapterId),
      ),
    });
  } catch (error) {
    // A read-only/broken ~/.nexus must not turn an optional upgrade migration
    // into another app-start failure. persist() is atomic and updates memory
    // only after rename, so continuing retains one coherent old snapshot; the
    // provider picker remains available for an explicit repair.
    console.warn(
      "[settings] retired provider migration deferred; Nexus will continue. " +
        "Escolha um provider atual em Configurações › Contas de IA.",
      error,
    );
  }
  projectRuntimeManager = new ProjectRuntimeManager({
    baseDir: path.join(app.getPath("userData"), "project-runtime"),
    appVersion: app.getVersion(),
  });
  configureAuditLogRuntime(projectRuntimeManager);
  configurePtyProjectRuntimeManager(projectRuntimeManager);
  configureRendererMissionAuthority(projectRuntimeManager);
  // F-773: cada handoff grava a CLI e o modelo da sessão física que o
  // entregou — base da taxa de sucesso da rota. Injetado pelo mesmo motivo do
  // sweep abaixo: o store não pode importar o pty-manager.
  setHandoffRouteAttributionResolver((sessionId) =>
    routeAttributionFromSession(getAgentSessionInfo(sessionId)),
  );
  // O enforcement grava "terminou sem entregar" depois do exit, quando a
  // sessão já saiu do registro: o tap de saída guarda quem ela era.
  tapSessionExit((sessionId, agent) =>
    rememberExitedSessionAttribution(sessionId, routeAttributionFromSession(agent)),
  );
  // Liga a varredura de PTY do teardown de worktree. Injetado aqui, e não
  // importado dentro do registry, porque pty-manager já importa de runtime/ —
  // o import de volta fecharia um ciclo ESM.
  configureWorktreePtySweep({
    listSessions: listLiveSessionLocations,
    terminate: (sessionId) =>
      orchTerminateSession(sessionId, { origin: "worktree-teardown-sweep" }),
  });
  const worktreeRuntime = configureWorktreeRuntimeRegistry(projectRuntimeManager);
  configureContextWorkflowRegistry(projectRuntimeManager, {
    appVersion: app.getVersion(),
    resolveIntegratedMission: (scope, missionId, baseSha) =>
      worktreeRuntime.resolveIntegratedMission(scope, missionId, baseSha),
  });
  configureProjectOrientationService({
    cacheRoot: path.join(app.getPath("userData"), "orientation-maps"),
  });
  const gamificationService = configureGamificationService({
    runtimeManager: projectRuntimeManager,
    domainStores: requireProjectDomainStoreRegistry(),
    broadcast: (scope, channel, payload) => {
      broadcastGamificationToProject(scope, channel, payload);
      // Além do renderer, o snapshot changed alimenta os contadores globais
      // do companion — o Perfil de Operador mostra entregas de vida inteira.
      if (channel === GAMIFICATION_CHANNELS.changed && payload && typeof payload === 'object') {
        ingestPetGamification(scope, payload as { counters?: Record<string, number> });
      }
    },
    soberMode: () => getOrchSettings().soberMode === true,
  });
  // Product authority is fail-closed before any scheduler/orchestration starts.
  // This cached-only evaluation never unlocks the cold Keychain before paint.
  initializeLicenseAuthority();
  const cronBackend = createHttpCronBackendFromEnvironment();
  const syncCapability = configureSyncRuntime();
  configureCronRuntime({
    runtimeManager: projectRuntimeManager,
    leaseBackend: cronBackend ?? undefined,
    scheduleBackend: cronBackend ?? undefined,
    listScopes: knownCronScopes,
  });
  configureNexusDoctorRuntime({
    runtimeManager: projectRuntimeManager,
    multiPc: buildMultiPcBackendStatus(
      cronBackend !== null,
      syncCapability.backendConfigured,
    ),
  });
  setPaneTerminalIdentity({ name: "NexusIDE", version: app.getVersion() });
  registerPtyIpc();
  // Authenticate the native job base in the utility host before any agent
  // receives its synchronous spawn environment.
  await nativeHeavyJobEnvironment();
  // Semantic CommandBlock layer (OSC 133). Fail-closed behind feature flag;
  // never mutates the PTY byte stream — lateral tap only.
  // Persist finished blocks into project runtime SQLite when flag + scope ok.
  setCommandBlockPersistHook(
    createCommandBlockPersister({
      runtimeManager: projectRuntimeManager,
    }),
  );
  ensureCommandBlockTracking();
  // Fim de sessão de pane: digere os handoffs da sessão em memória trusted
  // (best-effort; sem teto diário — dedupe FTS5 e em voo dentro do módulo).
  ensureSessionExitMemoryDistiller();
  configureMissionEventEmit(projectRuntimeManager);
  installObserverMissionEventProjector();
  // Uso geral: input humano do PTY em RAM (nunca persistido) — prova de que o
  // operador digitou o nome de uma CLI antes de um adapterId explícito ser
  // honrado literalmente (pin do agente → preferência de roteamento).
  installOperatorCliMentionTap();
  installMissionDiskProjection();
  registerMissionEventIpc();
  // Product paths: CommandBlock actions, SearchMixer, full product-wave IPC.
  registerTerminalBlockActionsIpc(projectRuntimeManager);
  getSearchMixer(); // ensure ripgrep + multi-source providers on the live mixer
  registerSearchMixerIpc();
  registerProductWaveIpc();
  // Descoberta universal de configs de ecossistemas de agente (read-only, B4).
  registerDiscoveryIpc();
  // Memória agentic por workspace (C2): stats/recall read-only + forget.
  // Mem12: stats leva os handoffs entregues desde a última memória (Main).
  registerMemoryIpc({
    countHandoffDeliveries: (scope, sinceMs, untilMs) =>
      requireProjectDomainStoreRegistry()
        .forScope(scope)
        .handoffs.countSuccessfulDeliveriesBetween(sinceMs, untilMs),
  });
  // Metadado rico de modelo (A2): preço/janela/capacidades, read-only.
  registerModelMetadataIpc();
  // Agent lifecycle: record finished/needs-input; reap finished only (never running).
  startAgentLifecycleService();
  registerBrowserIpc(projectRuntimeManager);
  registerDesignWritebackIpc({ allowSourceMutation: !app.isPackaged });
  registerPerfIpc();
  // F-764 C.7: eco trivial que o renderer pinga para acusar main ocupado.
  registerMainHeartbeatIpc();
  registerLayoutIpc(projectRuntimeManager);
  registerAdapterIpc();
  traceBootstrap('before voice IPC');
  registerVoiceIpc(projectRuntimeManager);
  traceBootstrap('after voice IPC');
  registerJevIpc();
  registerMissionPickIpc();
  registerDecisionModelIpc();
  // The window is created by the app-ready handler before bootstrap starts.
  // Keep the rest of registration below it so account/secrets/billing cannot
  // delay the first visible UI.
  registerVisionIpc();
  registerOrchIpc();
  registerAuthProbeIpc();
  registerWorkspaceIpc();
  // Worktree removido por fora com o app aberto: o foco da janela é quando a
  // pessoa volta e precisa saber que a pasta sumiu — antes do pane falhar.
  app.on("browser-window-focus", () => {
    probeCurrentWorkspaceLiveness();
  });
  registerOrientationIpc();
  registerContextDraftIpc();
  registerProviderIpc();
  if (!isAutomatedReleaseTest()) {
    stopCliAutoUpdate = startCliAutoUpdate(app.getPath('userData'), (adapterId) =>
      listLiveSessionLocations().some(({ sessionId }) =>
        getAgentSessionInfo(sessionId)?.adapterId === adapterId,
      ),
    );
  }
  registerArmsIpc();
  registerFilesIpc();
  registerAccountIpc();
  // Recibo da escolha de conta (somente leitura, já mascarado) para o chip do
  // cabeçalho do pane.
  registerAccountChoiceIpc();
  registerCostIpc();
  registerTokenSpeedIpc();
  registerMediaIpc(projectRuntimeManager);
  registerGamificationIpc(gamificationService);
  registerMcpIpc();
  registerOpsIpc();
  registerEvalRankingIpc();
  traceBootstrap('after secondary IPC registration');
  // Telemetria REAL de tokens (transcript watchers → SQLite). Convive com o
  // cost-tracker heurístico: a UI prefere o real quando ele existe.
  await initUsageTelemetry(projectRuntimeManager);
  traceBootstrap('after usage telemetry');
  // Tokens das contas Claude secundárias renovados em background — spawn e
  // failover sempre encontram credencial viva no vault (mata o "401 OAuth
  // access token has expired" em respawn horas depois).
  if (!isAutomatedReleaseTest()) {
    traceBootstrap('before Claude subscription freshness');
    startClaudeSubscriptionFreshness();
    traceBootstrap('after Claude subscription freshness');
  }
  // Piloto automático de máquina nova: oferta única, diálogo nativo com os
  // comandos exatos, instalação em sequência. Atrasado para não competir com
  // o primeiro paint.
  if (!isAutomatedReleaseTest()) {
    setTimeout(() => {
      void maybeOfferFirstRunProvisioning(app.getPath("userData")).catch((err) =>
        console.warn("[provisioning] oferta de primeiro boot falhou:", err),
      );
      // Nexus Redline: oferta única de instalação do companheiro na barra
      // ("instalou um, instala outro") — depois do provisioning de CLIs.
      setTimeout(() => {
        void maybeOfferRedlineInstall(app.getPath("userData")).catch((err) =>
          console.warn("[redline] oferta de instalação falhou:", err),
        );
      }, 4_000);
    }, 6_000);
  }
  // Nexus Redline (app de menu bar): publica snapshots em
  // ~/.nexus/redline-last-good.json e consome o arquivo-sinal de refresh
  // escrito pelo companheiro.
  redlineSink = createRedlineSink();
  stopRedlineRefreshWatch = redlineSink.watchRefreshRequests(() => {
    return requireQuotaService().refresh();
  });
  initRedlineIpc();
  if (process.platform === "win32" && !isAutomatedReleaseTest()) {
    void syncInstalledRedline(process.resourcesPath).catch((err) =>
      console.warn("[redline] sync da instalação falhou:", err),
    );
  }
  if (process.platform === "darwin" && !isAutomatedReleaseTest()) {
    void syncInstalledRedline(process.resourcesPath).catch((err) =>
      console.warn("[redline] sync da instalação falhou:", err),
    );
  }
  // Linux: o Redline é uma bandeja dentro do app; sobe só se o operador ligou.
  if (process.platform === "linux" && !isAutomatedReleaseTest()) {
    startRedlineLinuxIfEnabled();
  }
  initQuotaService({
    listProviders: () => listProviderSettings({ nonBlockingAuth: true }),
    listAccounts: () => listAccountInfos(),
    resolveApiQuotaKey: resolveQuotaApiKey,
    // Nexus Redline (app de menu bar): publica cada snapshot que vira
    // lastSnapshot em ~/.nexus/redline-last-good.json. Best-effort — falha
    // de disco nunca afeta o serviço.
    persistSnapshot: (snap, accounts) => redlineSink?.persist(snap, accounts),
    // Leitura provider-api fresca e saudável refuta cooldown persistido
    // (resíduo da cascata de limite fantasma) — a conta volta ao pool.
    clearRefutedCooldown: (accountId) =>
      clearCooldown(accountId, 'cooldown refutado por leitura provider-api saudável'),
    clearRefutedAuthCooldown,
    // Multi-candidate probes (vault → launcher → env → system CLI).
    // Never invents ratios; tries every credential until one yields %.
    resolveClaudeAccessToken: (accountId) => resolveClaudeToken(accountId),
    // Probe estruturado: auth-expired/cli-missing viram readHint acionável
    // («Entrar novamente») em vez do «—» genérico.
    claudeCliUsage: () => probeClaudeCliUsage(),
    // Cascata por conta (Codenotch): managed-auth scoped, perfil de disco
    // com o mesmo e-mail, materialização do vault — nunca empresta a
    // leitura de outra conta.
    claudeAccountUsage: (accountId) => fetchClaudeAccountUsageWindows(accountId),
    // Rejected account credentials need reauthentication. Native identity
    // metadata is not evidence that a rejected credential is still valid.
    markAccountAuthExpired: (accountId, adapterId, reason) => {
      // Só adapters cuja sonda distingue grant morto de falha transitória.
      // Conta vault marcada tem blob próprio — um 401 nele é da conta, não
      // da sessão nativa, então marcar não cria churn com o CLI.
      if (!["claude", "codex", "grok", "kimi"].includes(adapterId)) return;
      const account = listAccounts(adapterId).find((a) => a.id === accountId);
      if (!account) return;
      if (
        isAuthCooldownReason(account.lastError) &&
        account.cooldownUntil !== undefined &&
        account.cooldownUntil > Date.now() &&
        (reason !== 'identity-mismatch' ||
          /oauth identity mismatch/i.test(account.lastError ?? ''))
      ) {
        return;
      }
      setCooldown(
        accountId,
        Date.now() + 12 * 60 * 60 * 1000,
        reason === 'identity-mismatch'
          ? 'oauth identity mismatch — sonda de quota'
          : 'oauth session expired — sonda de quota',
      );
    },
    resolveCodexAuthCandidates: (accountId) =>
      resolveCodexAuthCandidates(accountId),
    resolveGlmApiKeyCandidates: (accountId) =>
      resolveProviderApiKeyCandidates("glm", accountId),
    resolveGrokTokenCandidates: (accountId) =>
      resolveGrokAccessTokenCandidates(accountId),
    resolveKimiTokenCandidates: (accountId) => {
      // Coding Plan API key (vault/launcher) + bare OAuth access tokens.
      const keys = resolveProviderApiKeyCandidates("kimi", accountId);
      const oauth = resolveKimiAccessTokenCandidates(accountId);
      return [...keys, ...oauth.filter((t) => !keys.includes(t))];
    },
    // Full OAuth blob — refresh via auth.kimi.com (same as `kimi login`).
    resolveKimiOauthCreds: (accountId) => resolveKimiOauthCreds(accountId),
    resolveGeminiOauthCreds: (accountId) =>
      resolveGeminiOauthCreds(accountId),
    resolveLongcatApiKeyCandidates: (accountId) =>
      resolveProviderApiKeyCandidates("longcat", accountId),
    // OpenCode / Aider / any future CLI: vault + launcher + env keys.
    resolveGenericApiKeyCandidates: (adapterId, accountId) =>
      resolveProviderApiKeyCandidates(adapterId, accountId),
    // `mcode login`: estado público prova a conta; o access token vigente
    // (decisão do operador) lê a cota sem Subscription Key, só leitura.
    minimaxCodeSignedIn: () => minimaxCodeHasCredential(),
    resolveMinimaxCodeLogin: () => minimaxCodeLoginAccessToken(),
    // Plano de assinatura por linha (tier Claude/Codex/AGY → USD/mês de
    // lista). Reusa os mesmos resolvers de credencial do probe de uso.
    detectProviderPlan: (adapterId, accountId) =>
      detectProviderPlan(adapterId, accountId, {
        resolveCodexAuthCandidates,
        resolveGeminiOauthCreds,
        resolveGeminiToken: resolveGeminiAccessToken,
      }),
  });
  traceBootstrap('after quota service');
  registerBillingIpc();
  registerTeamIpc();
  // Reporte de problema: IPC (prévia/envio com a sessão do Main) + a entrada
  // "Ajuda → Reportar um problema…" no menu da aplicação.
  registerBugReportIpc();
  installAppMenu({
    platform: process.platform,
    onReportProblem: () => {
      requestOpenBugReportDialog(
        findTrustedMainWindow(BrowserWindow.getAllWindows()),
      );
    },
  });
  // Packaged smoke must prove the app can boot without touching the user's
  // real Keychain. License sync is useful in normal launches, but it can block
  // inside SecItemCopyMatching — window already open above.
  if (!isAutomatedReleaseTest()) {
    traceBootstrap('before license sync');
    syncLicenseOnBoot();
    traceBootstrap('after license sync');
  }
  registerPipeIpc(); // also calls initPanePipes()
  registerRemoteIpc();
  registerIntegrationsIpc();
  traceBootstrap('after remaining IPC registration');
  // Desktop pet (opt-in): companion flutuante que reage à frota. Depois da
  // janela principal — o pet só existe enquanto houver uma janela de app.
  initDesktopPet();
  // Orchestration boots async (MCP server binds a localhost port); the window
  // is already open and orchestration attaches when ready.
  // Gamificação SÓ depois: o retro replay precisa dos stores orch hidratados
  // (senão a estreia gravaria replayDone com zero eventos).
  void initOrchestration()
    .then(() => gamificationService.start())
    .catch((err) => {
      console.warn("[nexus] orchestration failed to start:", err);
      gamificationService.start();
    });
  // Cron: squads/agentes agendados (tick 60s, skip-if-stale) — time-driven.
  startCronLoop();
  // Deep link nexus:// vindo no lançamento a frio (após a janela existir) +
  // auto-updater (opt-in por ambiente; no-op sem servidor configurado).
  consumeLaunchDeepLink();
  initAutoUpdater({
    networkEnabled: !isAutomatedReleaseTest(),
  });
  traceBootstrap('complete');
}

function isAutomatedReleaseTest(): boolean {
  return isCurrentProcessSmokeTest();
}

initSmokeTest();

// Single-instance + protocolo nexus:// precisam ser registrados ANTES do
// whenReady. Se outra instância já detém o lock, saímos (ela recebe o link).
if (squirrelStartupEvent || !wireDeepLinks()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    // Varredura de órfãos do PRÓPRIO install: supervisores rodam disclaimed
    // (ppid 1 mesmo saudáveis), então parentesco não distingue vivo de órfão —
    // mas no boot, com o lock de instância única, NENHUM supervisor deste
    // install pode ter dono. Zumbis acumulados (04/08) faziam toda tentativa
    // de sair falhar a prova física; aqui eles morrem antes de existir sessão.
    if (process.platform === "darwin") {
      try {
        const { execFileSync } = await import("node:child_process");
        sweepOrphanPtySupervisors({
          resourcesPath: process.resourcesPath,
          listProcesses: () =>
            execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
              encoding: "utf8",
              maxBuffer: 8 * 1024 * 1024,
            }),
          kill: (pid, signal) => process.kill(pid, signal),
          record: recordQuitIncident,
        });
      } catch (error) {
        console.warn("[main] varredura de supervisores órfãos falhou:", error);
      }
    }
    // `protocol.handle` requires app.ready, but must exist before the first
    // BrowserWindow starts navigating. Installing it later in bootstrap made
    // every packaged launch fail its first nexus-app:// request and recover
    // only through the window watchdog.
    try {
      installRendererProtocol(
        protocol,
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
      );
    } catch (error) {
      console.error('[main] renderer protocol installation failed:', error);
      try {
        dialog.showErrorBox(
          'NexusIDE bloqueou a inicialização',
          'A interface local não pôde ser registrada com segurança. Reinicie o app.',
        );
      } catch {
        // No renderer is created when its protocol precondition failed.
      }
      app.quit();
      return;
    }
    // No service initialization belongs before this call. Some macOS APIs
    // (notably Keychain-backed providers) can block the Electron main thread;
    // the native window/Dock item must already exist before touching them.
    const mainWindow = createMainWindow({ deferRendererLoad: true });
    if (!mainWindow) {
      // createMainWindow reports the native error. Do not continue bootstrap:
      // it can create auxiliary renderer windows, which must never load after
      // the main-session CSP precondition failed.
      app.quit();
      return;
    }
    startMacOSDockWatchdog();

    // macOS App Nap suspende TODOS os timers do main quando a janela perde o
    // foco — worker spawn/merge do scheduler morrem com o app em background
    // (release gate unattended: waitForIdle agendou setTimeout de 20s que
    // nunca disparou). O IDE orquestra agentes de longa duração; suspensão de
    // timers nunca é aceitável enquanto o app vive.
    powerSaveBlocker.start('prevent-app-suspension');

    // Agent awake: prevent sleep while provider hooks report working.
    getAgentAwakeService();
    registerAgentHookIpc();

    // The native BrowserWindow/Dock ownership exists before any optional
    // integration starts, but renderer navigation remains deferred. Loading
    // React before bootstrap registered preload IPC made the first launch race
    // through "No handler registered" responses and could strand stores on
    // their fallback state until a reload.
    // This must remain the first potentially visible operation after Electron
    // is ready. Do not move it into bootstrap(): synchronous adapter, settings,
    // database, or keychain setup can otherwise classify the process as a
    // background UIElement before macOS has a window/Dock item to display.
    // Finder/dmg launches inherit a minimal PATH. Resolve the login-shell PATH
    // asynchronously after the native window is visible, then initialize the
    // adapter registry with the completed value. Slow shell profiles no longer
    // freeze Electron's main event loop.
    try {
      await resolveUserPath();
      await bootstrap();
      // Shell de login lento (oh-my-zsh + nvm num login frio) estoura o prazo
      // curto do boot e CLIs via nvm/fnm pareciam "não instaladas" a sessão
      // toda. Uma segunda sondagem, longa e em background, corrige sozinha.
      void retryLoginShellPathIfMissed()
        .then((changed) => (changed ? rescanAdapterBinaries() : undefined))
        .catch((error: unknown) => {
          console.warn("[path] late login-shell PATH retry failed:", error);
        });
      // MCP boot race (print 2026-08-16): o renderer restaurava panes de
      // agente enquanto o servidor MCP embutido ainda não tinha feito bind —
      // os CLIs spawnados imprimiam "MCP startup interrupted …
      // nexus_<hex> not initialized". initOrchestration é idempotente: aqui
      // esperamos o voo já em curso (bootstrap dispara fire-and-forget),
      // com teto: bind travado não pode segurar a janela para sempre (o
      // supervisor segue retentando em background).
      await Promise.race([
        initOrchestration().catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 4_000);
        }),
      ]);
      if (!startMainWindowRenderer(mainWindow)) {
        throw new Error(
          "renderer start authority disappeared before bootstrap completed",
        );
      }
    } catch (error) {
      console.error("[main] bootstrap failed before renderer navigation:", error);
      try {
        dialog.showErrorBox(
          "NexusIDE não conseguiu inicializar",
          "O núcleo do aplicativo falhou antes de abrir a interface. " +
            "Reinicie o Nexus; nenhum renderer parcial foi carregado.",
        );
      } catch {
        // The process still exits instead of exposing a renderer with partial IPC.
      }
      app.quit();
      return;
    }

    // Bootstrap can create auxiliary native windows after the main window is
    // visible. Re-arm the short Dock check after that graph has settled; the
    // pre-bootstrap check alone can finish too early and be followed by a late
    // AppKit reclassification.
    stopMacOSDockWatchdog();
    startMacOSDockWatchdog();

    // F-572: pane guardian — fecha pane ocioso sem dono (helper do operador ou
    // worker sem missão) após o TTL, por evento de hook E por varredura do
    // PTY. Existia desde 05/08 e nunca tinha sido ligado; em 16/09, 22 panes
    // parados esgotaram a RAM do Mac.
    initNonWorkerAutoClose();
    // Primeira amostra de memória para o gate de admissão de panes (F-572);
    // o gate é síncrono e lê o cache — sem isso o primeiro spawn nasce cego.
    void refreshSystemMemorySample();
    // Badge de custo por pane no cabeçalho (0.76.45): push periódico do
    // footprint por sessão para todos os renderers.
    startPaneFootprintBroadcast();

    // Gap A: register Claude+Codex managed hook installers. Installing edits the
    // user's GLOBAL ~/.claude & ~/.codex config (affects those tools even outside
    // Nexus), so we NEVER install on launch without consent — register only, then
    // prompt once and install/remove per the persisted decision (option A).
    if (!isAutomatedReleaseTest()) {
      try {
        const userDataPath = app.getPath("userData");
        sessionAliveSentinel = new SessionAliveSentinel({
          userDataPath,
          getActivePanes: () => liveRuntimeProcessSummary().total,
          onPriorCrashDetected: (prior) => {
            console.warn(
              `[nexus] detected ungraceful exit from prior session (pid ${prior.pid}, rss ${prior.rssMb}MB, uptime ${Math.round((prior.lastPulse - prior.startTime) / 1000)}s)`,
            );
          },
        });
        sessionAliveSentinel.start();
        configureAgentRuntimeUserDataPath(userDataPath);
        bootstrapManagedAgentHooks({ enabled: false });
        const hookServer = await startAgentHookHttpServer({ userDataPath });
        configureAgentHookEndpointPath(hookServer.endpointFilePath);
        hookDropBoxWatcher = new AgentHookDropBoxWatcher();
        hookDropBoxWatcher.start();
        void resolveManagedHookConsent({
          userDataPath,
          prompt: async () => {
            const { response } = await dialog.showMessageBox({
              type: "question",
              buttons: ["Ativar", "Agora não"],
              defaultId: 0,
              cancelId: 1,
              title: "Hooks de status de agente",
              message: "Ativar os hooks de status do NexusIDE?",
              detail:
                "Para saber quando os agentes estão trabalhando, o Nexus pode adicionar hooks ao seu Claude e Codex (edita ~/.claude/settings.json e ~/.codex/hooks.json). Isso também afeta essas ferramentas fora do Nexus. Você pode mudar depois nas configurações.",
            });
            return response === 0 ? "granted" : "denied";
          },
        })
          .then((consent) => {
            // Enforce the decision idempotently every launch: install if granted,
            // otherwise remove any hooks a prior build may have auto-installed.
            if (consent === "granted") installManagedAgentHooks();
            else removeManagedAgentHooks();
          })
          .catch((err) => console.warn("[main] hook consent failed:", err));
      } catch (err) {
        console.warn("[main] managed agent hooks bootstrap failed:", err);
      }

      // shot-bridge: endpoint loopback que recebe capturas/frames do Nexus
      // Shot (app separado). Superfície mínima: valida caminhos sob as raízes
      // do Shot, foca a janela, notifica e emite "shot:files-received" ao
      // renderer. Falha aqui nunca impede o boot.
      try {
        await startShotBridgeServer({
          userDataPath: app.getPath("userData"),
          knownFolders: {
            pictures: app.getPath("pictures"),
            videos: app.getPath("videos"),
          },
          onFiles: (files) => {
            // Janela principal = qualquer janela que não seja o pet (mesmo
            // filtro do activate; getAllWindows()[0] poderia ser o pet).
            const win = BrowserWindow.getAllWindows().filter(
              (w) => !isPetWindow(w),
            )[0];
            if (win) {
              if (win.isMinimized()) win.restore();
              win.focus();
              win.webContents.send(SHOT_BRIDGE_CHANNELS.filesReceived, {
                files,
                source: 'nexus-shot',
                receivedAt: Date.now(),
              });
            }
            try {
              const count = files.length;
              new Notification({
                title: 'Nexus Shot',
                body:
                  count === 1
                    ? `Recebido: ${files[0].name}`
                    : `${count} arquivos recebidos do Nexus Shot`,
              }).show();
            } catch {
              // Notificação é conveniência — o evento ao renderer é o contrato.
            }
          },
        });
      } catch (err) {
        console.warn("[main] shot-bridge bootstrap failed:", err);
      }

      // Limpeza dos hooks de handoff da 0.32.x (port do Overclock que nunca
      // rodou no Nexus — ver docstring do handoff-hook-installer). O
      // fechamento mecânico real vive no Main: turn-end-handoff, acionado
      // pelo /hook/status quando o turno do worker encerra.
      //
      // Aqui saem o $HOME e o `process.cwd()` — que num app empacotado é "/" e
      // não é o repo do operador. Os workspaces REGISTRADOS (boot e cada
      // abertura) são limpos pelo workspace-store, que é quem sabe os
      // caminhos: `cleanRegisteredWorkspaceHooks`.
      try {
        const { cleanupLegacyHandoffHooks } = await import(
          './agent-hooks/handoff-hook-installer'
        );
        const { unregistered, deleted, cleaned } = cleanupLegacyHandoffHooks();
        if (unregistered || deleted.length > 0 || cleaned.length > 0) {
          console.info(
            '[main] hooks de handoff legados removidos:',
            unregistered ? 'settings.json' : '',
            deleted.join(', '),
            cleaned.join(', '),
          );
        }
      } catch (err) {
        console.warn('[main] handoff hook cleanup failed:', err);
      }
    }

    // Gap B: child-process-gone → bridge (classification + GPU fallback marker).
    app.on("child-process-gone", (_event, details) => {
      try {
        handleChildProcessGone({
          details: {
            type: details.type,
            reason: details.reason,
            exitCode: details.exitCode ?? null,
            name: details.name,
            serviceName: details.serviceName,
          },
          msSinceLaunch:
            typeof process.uptime === "function" ? process.uptime() * 1000 : 0,
        });
      } catch (err) {
        console.warn("[main] child-process-gone handler failed:", err);
      }
    });

    // Minimal crash-report-pending surface: log only — no telemetry without consent.
    try {
      const pending = readCrashReportPending(app.getPath("userData"));
      if (pending) {
        console.warn(
          "[main] crash report pending (local only, no telemetry):",
          pending.reason,
          pending.source,
        );
      }
    } catch {
      // ignore
    }

    // On macOS, Chromium's localhost exemption bypasses the TCC dialog, causing
    // CoreAudio to return all-zero PCM even with a getUserMedia grant. Request
    // mic access for a real TCC entry — but NEVER block window open on the
    // dialog (agent/background launches hung forever waiting for a hidden
    // prompt; bootstrap() must run so the user sees the app).
    if (process.platform === "darwin" && !isAutomatedReleaseTest()) {
      void systemPreferences.askForMediaAccess("microphone").catch(() => {});
    }
  });
}

let quitPromptOpen = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
/**
 * Hard-ceiling backstop for the whole quit. The PTY layer already bounds its own
 * per-child SIGTERM→SIGKILL escalation (pty-host-core/entry), so graceful quit
 * settles well under this. This ceiling only fires if shutdown wedges ANYWHERE —
 * PTY or otherwise — and guarantees quit can NEVER hang indefinitely (v0.25.0
 * regression: packaged app hung forever on quit). F-240: the constant lives in
 * app-quit-guarantee.ts (QUIT_CEILING_MS) so the PTY budget in pty-manager.ts
 * cross-checks against the same number — term 5s + kill 8s + exit lag 8s =
 * 21s worst case per session, comfortably under the 45s ceiling.
 */
const QUIT_HARD_CEILING_MS = QUIT_CEILING_MS;
// Registro durável de todo quit que precisou da rede de segurança: teto,
// botão de forçar, sessão sem prova, órfão varrido. Se esta classe voltar,
// aparece em dados — não num relato do operador.
const recordQuitIncident = createQuitIncidentFileRecorder(
  app.getPath("userData"),
);
// Teto INARREDÁVEL: armado antes do shutdown começar e sem NENHUMA API de
// clear — nenhum catch/finally/branch consegue removê-lo (o defeito-raiz do
// relato de 06/08 era exatamente o .catch limpando o backstop). A única
// revogação é a decisão explícita do operador de manter o app aberto.
const quitCeiling = createUnclearableQuitCeiling({
  ceilingMs: QUIT_HARD_CEILING_MS,
  exitApp: () => app.exit(0),
  record: recordQuitIncident,
  describeProgress: describeShutdownProgress,
});

/**
 * F-240: telemetria de fases do shutdown. O teto não sabe ONDE o quit
 * travou — cada fase medida aparece no `detail` do `ceiling-fired` e, no
 * caminho feliz, no trace `app-shutdown-phases`. Só rótulos/ms/ids (F-212:
 * nunca argv/env/texto de processo).
 */
const shutdownProgress: {
  startedAt: number;
  phases: Array<{ name: string; ms: number }>;
  current: string | null;
  currentStartedAt: number;
} = { startedAt: 0, phases: [], current: null, currentStartedAt: 0 };

async function trackShutdownPhase<T>(
  name: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const at = Date.now();
  shutdownProgress.current = name;
  shutdownProgress.currentStartedAt = at;
  try {
    return await run();
  } finally {
    shutdownProgress.phases.push({ name, ms: Date.now() - at });
    shutdownProgress.current = null;
  }
}

/** Resumo curto do progresso para o detail do incidente (≤ ~440 chars). */
function describeShutdownProgress(): string {
  if (shutdownProgress.startedAt === 0) return "shutdown ainda não iniciou";
  const done = shutdownProgress.phases
    .map((phase) => `${phase.name}=${phase.ms}ms`)
    .join(", ");
  const current = shutdownProgress.current
    ? `fase atual=${shutdownProgress.current} (há ${
        Date.now() - shutdownProgress.currentStartedAt
      }ms); `
    : "";
  return `${current}concluídas: ${done || "nenhuma"}`.slice(0, 440);
}
const forceQuitNow = (origin: "slow-notice" | "failure-notice"): void => {
  recordQuitIncident({ kind: "force-button", detail: origin });
  app.exit(0);
};
const shutdownNotices = createShutdownNoticeController({
  isShutdownComplete: () => shutdownComplete,
  focusApp: () => app.focus({ steal: true }),
  showMessageBox: (options) => dialog.showMessageBox(options),
  revokeQuitAuthorization: revokeAppQuitAuthorization,
  authorizeQuit: authorizeAppQuit,
  requestQuit: () => app.quit(),
  restartDockWatchdog: startMacOSDockWatchdog,
  remainingMs: () => quitCeiling.remainingMs(),
  forceExit: forceQuitNow,
  abandonQuit: () => quitCeiling.abandonQuitByUser("manter-aberto"),
});

app.on("activate", () => {
  // macOS may activate during launch; whenReady owns the first window.
  if (!app.isReady()) return;
  startMacOSDockWatchdog();
  const mainWindows = BrowserWindow.getAllWindows().filter(
    (win) => !isPetWindow(win),
  );
  const lifecycleState = {
    isShutdownInProgress: shutdownPromise !== null,
    isShutdownComplete: shutdownComplete,
  };
  if (
    shouldCreateWindowOnActivate({
      ...lifecycleState,
      // O pet não conta como janela de app: com ele vivo, o clique no Dock
      // ainda precisa reabrir a janela principal.
      windowCount: mainWindows.length,
    })
  ) {
    createMainWindow();
    return;
  }
  restoreMainWindowOnActivate(lifecycleState, mainWindows[0], () => {
    app.focus?.({ steal: true });
  });
});

app.on("browser-window-created", (_event, win) => {
  startMacOSDockWatchdog();
  // Capture the webContents reference NOW, while the window is alive. By the time
  // the 'closed' event fires the native BrowserWindow is already destroyed, and
  // the `win.webContents` getter throws "Object has been destroyed" — which, as an
  // uncaught exception inside the event emit, crashes the whole main process.
  const wc = win.webContents;
  // The desktop-pet window has no pane grid/OrchBridge. Registering it as an
  // orchestration listener made it replace the main window as pane-spawn
  // target, so every delegated reviewer disappeared into a 90s timeout.
  const hostsOrchestration = !isPetWindow(win);
  registerAdapterListener(wc);
  if (hostsOrchestration) registerOrchListener(wc);
  registerSettingsListener(wc);
  registerWorkspaceListener(wc);
  registerProviderListener(wc);
  registerAccountListener(wc);
  registerCostListener(wc);
  registerTokenSpeedListener(wc);
  registerPipeListener(wc);
  registerGamificationListener(wc);
  win.once("closed", () => {
    void closeDesignWritebackFor(wc).catch((error) => {
      console.error("[design] window cleanup failed:", error);
    });
    unregisterAdapterListener(wc);
    if (hostsOrchestration) unregisterOrchListener(wc);
    unregisterSettingsListener(wc);
    unregisterWorkspaceListener(wc);
    unregisterProviderListener(wc);
    unregisterAccountListener(wc);
    unregisterCostListener(wc);
    unregisterTokenSpeedListener(wc);
    unregisterPipeListener(wc);
    unregisterGamificationListener(wc);
    destroyBrowsersFor(wc);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

/** Teto do selo no quit: o diálogo já confirmou sair; PTY preso não segura o app. */
const QUIT_MISSION_SEAL_BUDGET_MS = 4_000;

/**
 * Encerra todas as missões ativas quando o operador confirma "Sair e encerrar
 * processos". Persiste o selo runtime-closed antes do app.quit() para que o
 * reopen não restaure os workers automaticamente.
 */
async function closeAllActiveMissionsForShutdown(): Promise<void> {
  const seal = (async () => {
    try {
      const registry = requireProjectDomainStoreRegistry();
      const jobs: Promise<void>[] = [];
      for (const suite of registry.listSuites()) {
        let runningMissions: ReturnType<typeof suite.missions.list>;
        try {
          runningMissions = suite.missions.list('running');
        } catch (error) {
          console.error('[quit] Falha ao processar escopo no quit:', error);
          continue;
        }
        for (const mission of runningMissions) {
          jobs.push(
            closeMissionRuntimePreservingHistory({
              scope: suite.scope,
              suite,
              missionId: mission.id,
            }).then(
              () => undefined,
              (error: unknown) => {
                // Falha ao encerrar uma missão não deve travar o quit — o PTY
                // ainda cai no shutdown normal.
                console.error(
                  `[quit] Falha ao selar missão ${mission.id} no quit:`,
                  error,
                );
              },
            ),
          );
        }
      }
      await Promise.all(jobs);
    } catch (error) {
      // Registry não inicializado ou outro erro estrutural — registra mas não
      // trava o quit. O shutdown normal mata os PTYs mesmo sem o selo durável.
      console.error('[quit] Falha ao listar missões ativas no quit:', error);
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      seal,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUIT_MISSION_SEAL_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shutdown(): Promise<void> {
  if (shutdownComplete) return Promise.resolve();
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shutdownProgress.startedAt = Date.now();
    nativeHeavyCommands.stopAdmission();
    stopMacOSDockWatchdog();
    // F-572: nenhum fechamento automático de pane pode disparar no meio do
    // teardown físico — a varredura e os timers param antes do PTY.
    await shutdownNonWorkerAutoClose();
    await stopPaneFootprintBroadcast();
    await stopAgentLifecycleService();
    await stopSessionMortalityReconciler();
    await stopPaneSessionOutputGc();
    await stopManagedAuthSpawnGateWatchers();
    await stopClaudeSubscriptionFreshness();
    await stopQwenReadiness();
    await stopAutoUpdater();
    await stopLicenseSync();
    await stopOrientationForWorkspace();
    await stopEventLoopMonitor();
    await stopPreGoneCrashSampling();
    // Quiesce periodic orchestration before physical teardown, but retain its
    // exact exit observer and stores until PTY proof and reconciliation are
    // complete. A failed proof must leave the next retry operational.
    await trackShutdownPhase("stopCronLoop", () => stopCronLoop());
    // Cancela refreshes de projecao pendentes ANTES do teardown fisico: um
    // timer de debounce disparando apos closeAll reabriria o runtime SQLite.
    uninstallMissionDiskProjection();
    await trackShutdownPhase("closeAllDesignWritebacks", () =>
      closeAllDesignWritebacks(),
    );
    // ACP children are not part of the PTY host inventory. Close them before
    // proving the PTY half, otherwise quitting could leave a harness orphaned
    // even though the normal terminal shutdown gate passed.
    await trackShutdownPhase("shutdownAllAcpDriverSessions", () =>
      shutdownAllAcpDriverSessions(),
    );
    // Sem veto de sessão única: falha de prova vira incidente registrado e o
    // teardown segue até o fim — o processo resistente é abandonado ao teto,
    // nunca aguardado para sempre (diretiva 06/08).
    const ptyShutdown = await shutdownOrchestrationRuntimesRecordingStragglers(
      {
        quiesceOrchestration: () =>
          trackShutdownPhase(
            "quiesceOrchestration",
            quiesceOrchestrationCoordinator,
          ),
        // F-240: orçamento 5s/8s/8s — ver o comentário de
        // APP_SHUTDOWN_PTY_TERMINATION (pty-manager) e QUIT_CEILING_MS.
        terminateAllSessions: () =>
          trackShutdownPhase("terminateAllSessions", async () => {
            const result = await terminateAllSessions(APP_SHUTDOWN_PTY_TERMINATION);
            // Claims live in the PTY host; retain it until owned process exit
            // and private shim cleanup have physically settled.
            await nativeHeavyCommands.drain();
            await drainMissionShimDisposals();
            return result;
          }),
        shutdownPtyHost: () => trackShutdownPhase("shutdownPtyHost", shutdownPtyHost),
        // Via Rápida: o supervisor cerimonial de exit do orquestrador morreu;
        // não há reconciliação durável pendente a provar no shutdown.
        reconcileOrchestratorExits: () => true,
        closeOrchestration: () =>
          trackShutdownPhase("closeOrchestration", closeOrchestration),
      },
      recordQuitIncident,
    );
    // F-764: a projeção da memória (vault markdown) anda fora do caminho da
    // gravação; com os agentes já encerrados, ela tem um teto curto para
    // alcançar o SQLite antes de o processo sair.
    await trackShutdownPhase("flushMemoryProjections", () =>
      flushWorkspaceMemoryProjections(),
    );
    await trackShutdownPhase("rest", async () => {
      stopRemoteBridge();
    configureAgentHookEndpointPath(null);
    await stopAgentHookHttpServer().catch(() => {});
    await stopShotBridgeServer().catch(() => {});
    await hookDropBoxWatcher?.dispose();
    hookDropBoxWatcher = null;
    await sessionAliveSentinel?.markExpectedExit();
    await sessionAliveSentinel?.dispose();
    sessionAliveSentinel = null;
    disposeAgentAwakeService();
    await closeAdapterRegistry();
    await stopCliAutoUpdate?.();
    stopCliAutoUpdate = null;
    closeVoiceIpc();
    await shutdownUsageTelemetry();
    await stopPetPeriodicWork();
    await stopRedlineRefreshWatch?.();
    stopRedlineRefreshWatch = null;
    await redlineSink?.stop();
    redlineSink = null;
    await shutdownRedlineIpc();
    shutdownQuotaService();
    shutdownGamificationService();
    disposeCronRuntime();
    disposeSyncRuntime();
    disposeNexusDoctorRuntime();
    disposeAuditLogRuntime();
    disposeContextWorkflowRegistry();
    disposeWorktreeRuntimeRegistry();
      closeDb();
      projectRuntimeManager?.closeAll();
      projectRuntimeManager = null;
    });
    // F-240: medição de fases no trace — só rótulos/ms/ids de sessão e
    // adapter (F-212). `current` já é null aqui: toda fase concluiu.
    trace({
      kind: "app-shutdown-phases",
      totalMs: Date.now() - shutdownProgress.startedAt,
      phases: shutdownProgress.phases,
      sessions: ptyShutdown.attemptedSessionIds.length,
      failedSessions: ptyShutdown.failedSessionIds.map((sessionId) => ({
        id: sessionId,
        adapterId: sessionAdapterId(sessionId) ?? "unknown",
      })),
    });
    await flushMainTrace();
    shutdownComplete = true;
    if (isCurrentProcessSmokeTest()) {
      // Reader-visible release evidence: the app itself reached the end of the
      // fail-closed shutdown lane. The external harness still checks exit(0)
      // and the remaining Electron process group, but it never treats a root
      // process disappearing on its own as PTY teardown proof.
      if (
        ptyShutdown.ok &&
        ptyShutdown.failedSessionIds.length === 0 &&
        hasExactPhysicalInventoryProof(ptyShutdown)
      ) {
        console.log("[smoke] shutdown-complete: physical PTY inventory proven");
      } else {
        console.warn(
          "[smoke] shutdown-unproven: physical PTY inventory was not proven",
        );
      }
      // BridgeSpace pattern: once the intentional shutdown proof is written,
      // leave immediately. Waiting for Electron's nested quit/app.exit path
      // can keep the root alive past the packaged-smoke grace window.
      console.log("[smoke] expected-exit");
      process.exit(
        typeof process.exitCode === "number" ? process.exitCode : 0,
      );
    }
  })();
  return shutdownPromise;
}

app.on("before-quit", (event) => {
  const summary = liveRuntimeProcessSummary();
  if (
    closeNeedsConfirmation({
      sessionCount: summary.total,
      authorized: isAppQuitAuthorized(),
      smokeTest: isAutomatedReleaseTest(),
    })
  ) {
    event.preventDefault();
    // Quit pode chegar com o app em segundo plano (Dock → Encerrar) ou com a
    // janela fora do palco (Stage Manager/minimizada). Sem roubar o foco, o
    // prompt nasce ATRÁS dos outros apps — e como quitPromptOpen engole os
    // quits seguintes, o app parece se recusar a encerrar (caso de campo
    // 18/07). Sempre trazer o app (e o prompt pendente) à frente.
    app.focus({ steal: true });
    if (quitPromptOpen) return;
    quitPromptOpen = true;
    const options = {
      type: "warning" as const,
      title: "Sair do NexusIDE?",
      message: `${summary.total} processo${summary.total === 1 ? "" : "s"} ainda em execução`,
      detail:
        (summary.busy > 0
          ? `${summary.busy} ainda estão trabalhando. Sair encerra esses processos agora.`
          : "Sair encerra os processos de todos os panes.") +
        "\n\nSair e retomar ao abrir: as missões voltam sozinhas quando você abrir o Nexus." +
        "\nSair e encerrar missões: elas ficam paradas até você retomá-las no Quadro.",
      buttons: [...QUIT_DIALOG_BUTTONS],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    // App-modal sempre: um sheet ancorado numa janela minimizada ou fora do
    // palco fica invisível e o quit trava sem feedback.
    void dialog
      .showMessageBox(options)
      .then(async ({ response }) => {
        quitPromptOpen = false;
        const choice = quitChoiceFromResponse(response);
        if (choice === "cancel") return;
        sealRuntimeProcessAdmissionForShutdown();
        // F-726: só "Sair e encerrar missões" grava o selo runtime-closed (o
        // reopen não restaura os workers). "Sair e retomar ao abrir" encerra
        // os processos e deixa a missão em execução para o boot religar.
        if (choice === "quit-close-missions") {
          await closeAllActiveMissionsForShutdown();
        }
        authorizeAppQuit();
        app.quit();
      })
      .catch(() => {
        quitPromptOpen = false;
      });
    return;
  }
  if (!shutdownComplete) {
    event.preventDefault();
    // Close child admission before the first shutdown await. This makes the
    // zero-inventory snapshot stable against queued IPC/scheduler spawns.
    sealRuntimeProcessAdmissionForShutdown();
    if (shutdownPromise) return;
    // Teto inarredável: armado ANTES do primeiro await do shutdown e imune a
    // qualquer catch/finally — o defeito-raiz do relato de 06/08 era o .catch
    // limpando o backstop exatamente quando ele era necessário. app.exit não
    // re-executa before-quit, então nenhum wedge — PTY travado, runloop preso,
    // disposer pendurado, falha REPETIDA de prova — segura o quit para sempre.
    quitCeiling.arm();
    // A demora vira feedback nativo COM prazo e saída, nunca espera aberta.
    // Packaged smoke never opens native notices — they can wedge the runloop
    // behind a modal and block the only path that must leave exit(0).
    let slowNotice: ReturnType<typeof setTimeout> | undefined;
    if (!isCurrentProcessSmokeTest()) {
      slowNotice = setTimeout(() => {
        console.error("[main] shutdown is still waiting for safe completion");
        shutdownNotices.showSlowNotice();
      }, 10_000);
    }
    void shutdown()
      .then(() => {
        clearTimeout(slowNotice);
        authorizeAppQuit();
        if (isCurrentProcessSmokeTest()) {
          // BridgeSpace pattern: intentional expected exit after proof.
          // Electron can keep the root alive after app.quit/app.exit while
          // residual helpers drain; packaged smoke only needs the proven
          // shutdown log plus a hard root exit(0).
          const code =
            typeof process.exitCode === "number" ? process.exitCode : 0;
          console.log("[smoke] expected-exit");
          for (const win of BrowserWindow.getAllWindows()) {
            try {
              win.destroy();
            } catch {
              // Best-effort; exit path must continue.
            }
          }
          try {
            app.exit(code);
          } catch {
            // Fall through to process.exit / SIGKILL.
          }
          process.exit(code);
        }
        app.quit();
      })
      .catch((error) => {
        clearTimeout(slowNotice);
        // A rejected promise must not poison retries. PTY failures leave the
        // exact sessions registered/inert, so a second attempt can prove them.
        // O TETO PERMANECE ARMADO: falha não é licença para ficar aberto — o
        // diálogo oferece forçar/retentar/ficar, e só a escolha explícita de
        // ficar desarma o prazo.
        shutdownPromise = null;
        shutdownNotices.showFailure(error);
      });
  }
});
