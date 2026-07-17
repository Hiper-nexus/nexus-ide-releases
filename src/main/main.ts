import './macos-activation-policy';
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  protocol,
  systemPreferences,
} from "electron";
import { resolveUserPath } from "./path-resolver";
import { createMainWindow } from "./window";
import {
  installRendererProtocol,
  registerRendererProtocolScheme,
} from "./renderer-protocol";
import { registerAuthProbeIpc } from "./adapters/auth-probe";
import {
  isCurrentProcessSmokeTest,
  shouldUseUserDataOverride,
} from "./smoke-core";
import { shouldCreateWindowOnActivate } from "./app-lifecycle";
import {
  startMacOSDockWatchdog,
  stopMacOSDockWatchdog,
} from './macos-activation-policy';

// Must run before Electron emits `ready`. The handler itself is installed in
// bootstrap (after ready), before the first BrowserWindow is created.
registerRendererProtocolScheme(protocol);

// Sandbox de userData para dev/smoke: redireciona SQLite, layout, sessões e o
// single-instance lock para um diretório isolado. Em app empacotado só vale
// para `--smoke-test`; launches normais nunca obedecem env override.
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
import { configureVoiceLogWorkspaceResolver } from "./voice/voice-log";
import { registerVisionIpc } from "./vision/ipc-bridge";
import {
  initAdapterRegistry,
  registerAdapterListener,
  unregisterAdapterListener,
  closeAdapterRegistry,
} from "./adapters/adapter-registry";
import {
  registerOmpRpcIpc,
  disposeAllOmpRpcSessions,
} from "./adapters/omp-rpc-ipc";
import {
  initOrchestration,
  registerOrchIpc,
  registerOrchListener,
  unregisterOrchListener,
  closeOrchestration,
  configureRendererMissionAuthority,
} from "./orch/orch-ipc";
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
  killAllSessions,
  liveSessionSummary,
} from "./pty/pty-manager";
import { shutdownPtyHost } from "./pty/pty-host-client";
import {
  ensureCommandBlockTracking,
  setCommandBlockPersistHook,
} from "./terminal/command-block-tracker";
import { createCommandBlockPersister } from "./terminal/command-block-persist";
import { configureMissionEventEmit } from "./orch/mission-event-emit";
import { registerTerminalBlockActionsIpc } from "./terminal/terminal-block-actions-ipc";
import { registerSearchMixerIpc } from "./search/search-mixer-ipc";
import { getSearchMixer } from "./search/search-mixer-bootstrap";
import { registerProductWaveIpc } from "./product-wave-ipc";
import { registerDiscoveryIpc } from "./discovery/discovery-ipc";
import { registerMemoryIpc } from "./memory/memory-ipc";
import { registerModelMetadataIpc } from "./adapters/model-metadata-ipc";
import { registerMissionEventIpc } from "./orch/mission-event-ipc";
import { startAgentLifecycleService } from "./agents/agent-lifecycle-service";
import {
  configureFeatureFlagRegistry,
  enableAllProductFlagsForTesting,
} from "./feature-flags/feature-flag-registry";
import {
  configureMissionScheduler,
  disposeMissionScheduler,
  startMissionSchedulerLoop,
  stopMissionSchedulerLoop,
} from './orch/mission-scheduler-production';
import {
  initUsageTelemetry,
  shutdownUsageTelemetry,
} from "./usage/usage-service";
import {
  initQuotaService,
  shutdownQuotaService,
} from "./quota/quota-service";
import { listProviderSettings } from "./persistence/provider-config-store";
import { clearCooldown, listAccountInfos } from "./persistence/account-store";
import {
  resolveClaudeToken,
  resolveCodexAuthCandidates,
  resolveGeminiOauthCreds,
  resolveGrokAccessTokenCandidates,
  resolveKimiAccessTokenCandidates,
  resolveKimiOauthCreds,
  resolveProviderApiKeyCandidates,
} from "./quota/provider-usage-auth";
import { closeDb } from "./persistence/db";
import {
  getOrchSettings,
  registerSettingsIpc,
  registerSettingsListener,
  unregisterSettingsListener,
} from "./persistence/settings-store";
import {
  getWorkspaceState,
  registerWorkspaceIpc,
  registerWorkspaceListener,
  unregisterWorkspaceListener,
} from "./persistence/workspace-store";
import { configureProjectOrientationService } from "./context/orientation/orientation-service";
import { registerOrientationIpc } from "./context/orientation/orientation-ipc";
import { resolveProjectExecutionScope } from "./persistence/project-identity";
import {
  registerProviderIpc,
  registerProviderListener,
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
import { registerBillingIpc } from "./persistence/billing-ipc";
import { syncLicenseOnBoot } from "./license-sync";
import { registerTeamIpc } from "./team-ipc";
import { initDesktopPet, isPetWindow } from "./pet/pet-window";
import { registerOnboardingIpc } from "./persistence/onboarding-store";
import {
  registerNotesIpc,
  registerNotesListener,
  unregisterNotesListener,
} from "./persistence/notes-ipc";
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
import { requireProjectDomainStoreRegistry } from "./orch/project-domain-store-registry";
import {
  configureCronRuntime,
  disposeCronRuntime,
  startCronLoop,
  stopCronLoop,
} from "./orch/cron-runtime";
import {
  configureMissionDriver,
  defaultDriveConfig,
  disposeMissionDriverIo,
  startMissionDriverLoop,
  stopMissionDriverLoop,
} from "./orch/mission-driver-io";
import { createHttpCronBackendFromEnvironment } from "./orch/http-cron-backend";
import {
  configureSyncRuntime,
  disposeSyncRuntime,
} from "./context/sync-runtime";
import { wireDeepLinks, consumeLaunchDeepLink } from "./deep-link";
import { initAutoUpdater } from "./updater";
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
import {
  readActiveGpuFallbackMarker,
} from './crash-reporting/gpu-fallback-marker';
import { readCrashReportPending } from './crash-reporting/crash-report-pending';
import {
  authorizeAppQuit,
  closeNeedsConfirmation,
  isAppQuitAuthorized,
} from "./close-authorization";

let projectRuntimeManager: ProjectRuntimeManager | null = null;

function knownCronScopes() {
  const state = getWorkspaceState();
  const paths = [state.current?.path, ...state.recents.map((item) => item.path)];
  const scopes: ReturnType<typeof resolveProjectExecutionScope>[] = [];
  const seen = new Set<string>();
  for (const workspacePath of paths) {
    if (!workspacePath || seen.has(workspacePath)) continue;
    seen.add(workspacePath);
    try {
      scopes.push(resolveProjectExecutionScope(workspacePath));
    } catch (error) {
      console.warn("[cron] ignoring invalid known workspace:", error);
    }
  }
  return scopes;
}

// Windows installer housekeeping (no-op elsewhere).
if (process.platform === "win32") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require("electron-squirrel-startup")) {
      app.quit();
    }
  } catch {
    // Package not present outside Windows packaging — ignore.
  }
}

function bootstrap(): void {
  installRendererProtocol(
    protocol,
    path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
  );
  // MUST run before the adapter registry probes for installed CLIs: a
  // Finder/dmg launch has a minimal PATH that hides claude/codex/kimi/grok.
  resolveUserPath();
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
  // The previous order configured Ralph in shadow on every restart regardless
  // of the persisted missionDriverActiveMode value.
  registerSettingsIpc();
  initAdapterRegistry();
  projectRuntimeManager = new ProjectRuntimeManager({
    baseDir: path.join(app.getPath("userData"), "project-runtime"),
    appVersion: app.getVersion(),
  });
  configureAuditLogRuntime(projectRuntimeManager);
  configurePtyProjectRuntimeManager(projectRuntimeManager);
  configureRendererMissionAuthority(projectRuntimeManager);
  const worktreeRuntime = configureWorktreeRuntimeRegistry(projectRuntimeManager);
  configureMissionScheduler({ listScopes: knownCronScopes });
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
    broadcast: broadcastGamificationToProject,
    soberMode: () => getOrchSettings().soberMode === true,
  });
  const cronBackend = createHttpCronBackendFromEnvironment();
  const syncCapability = configureSyncRuntime();
  configureCronRuntime({
    runtimeManager: projectRuntimeManager,
    leaseBackend: cronBackend ?? undefined,
    scheduleBackend: cronBackend ?? undefined,
    listScopes: knownCronScopes,
  });
  // Mission driver: ACTIVE por padrão para missões autopilot, com opt-out
  // explícito para shadow via missionDriverActiveMode. Efeitos continuam
  // budgetados e subordinados a PREVC/evidência. Spec 2026-07-13.
  configureMissionDriver({
    listScopes: knownCronScopes,
    config: {
      ...defaultDriveConfig,
      mode:
        getOrchSettings().missionDriverActiveMode === true
          ? 'active'
          : 'shadow',
    },
  });
  configureNexusDoctorRuntime({
    runtimeManager: projectRuntimeManager,
    multiPc: buildMultiPcBackendStatus(
      cronBackend !== null,
      syncCapability.backendConfigured,
    ),
  });
  registerPtyIpc();
  // Semantic CommandBlock layer (OSC 133). Fail-closed behind feature flag;
  // never mutates the PTY byte stream — lateral tap only.
  // Persist finished blocks into project runtime SQLite when flag + scope ok.
  setCommandBlockPersistHook(
    createCommandBlockPersister({
      runtimeManager: projectRuntimeManager,
    }),
  );
  ensureCommandBlockTracking();
  configureMissionEventEmit(projectRuntimeManager);
  registerMissionEventIpc();
  // Product paths: CommandBlock actions, SearchMixer, full product-wave IPC.
  registerTerminalBlockActionsIpc();
  getSearchMixer(); // ensure ripgrep + multi-source providers on the live mixer
  registerSearchMixerIpc();
  registerProductWaveIpc();
  // Descoberta universal de configs de ecossistemas de agente (read-only, B4).
  registerDiscoveryIpc();
  // Memória agentic por workspace (C2): stats/recall read-only + forget.
  registerMemoryIpc();
  // Metadado rico de modelo (A2): preço/janela/capacidades, read-only.
  registerModelMetadataIpc();
  // Agent lifecycle: record finished/needs-input; reap finished only (never running).
  startAgentLifecycleService();
  registerBrowserIpc(projectRuntimeManager);
  registerDesignWritebackIpc({ allowSourceMutation: !app.isPackaged });
  registerPerfIpc();
  registerLayoutIpc(projectRuntimeManager);
  registerAdapterIpc();
  registerVoiceIpc(projectRuntimeManager);
  // The window is created by the app-ready handler before bootstrap starts.
  // Keep the rest of registration below it so account/secrets/billing cannot
  // delay the first visible UI.
  registerVisionIpc();
  registerOrchIpc();
  registerAuthProbeIpc();
  registerWorkspaceIpc();
  configureVoiceLogWorkspaceResolver(
    () => getWorkspaceState().current?.path ?? null,
  );
  registerOrientationIpc();
  registerProviderIpc();
  registerFilesIpc();
  registerAccountIpc();
  registerCostIpc();
  registerMediaIpc(projectRuntimeManager);
  registerGamificationIpc(gamificationService);
  registerMcpIpc();
  registerOpsIpc();
  registerEvalRankingIpc();
  // Telemetria REAL de tokens (transcript watchers → SQLite). Convive com o
  // cost-tracker heurístico: a UI prefere o real quando ele existe.
  initUsageTelemetry(projectRuntimeManager);
  initQuotaService({
    listProviders: () => listProviderSettings(),
    listAccounts: () => listAccountInfos(),
    // Leitura provider-api fresca e saudável refuta cooldown persistido
    // (resíduo da cascata de limite fantasma) — a conta volta ao pool.
    clearRefutedCooldown: (accountId) =>
      clearCooldown(accountId, 'cooldown refutado por leitura provider-api saudável'),
    // Multi-candidate probes (vault → launcher → env → system CLI).
    // Never invents ratios; tries every credential until one yields %.
    resolveClaudeAccessToken: (accountId) => resolveClaudeToken(accountId),
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
  });
  registerNotesIpc(projectRuntimeManager);
  registerBillingIpc();
  registerTeamIpc();
  // Packaged smoke must prove the app can boot without touching the user's
  // real Keychain. License sync is useful in normal launches, but it can block
  // inside SecItemCopyMatching — window already open above.
  if (!isCurrentProcessSmokeTest()) {
    syncLicenseOnBoot();
  }
  registerOnboardingIpc();
  registerPipeIpc(); // also calls initPanePipes()
  // Sessões omp --mode rpc-ui como agentes de primeira classe (sem PTY).
  registerOmpRpcIpc();
  registerRemoteIpc();
  registerIntegrationsIpc();
  // Desktop pet (opt-in): companion flutuante que reage à frota. Depois da
  // janela principal — o pet só existe enquanto houver uma janela de app.
  initDesktopPet();
  // Orchestration boots async (MCP server binds a localhost port); the window
  // is already open and orchestration attaches when ready.
  // Gamificação SÓ depois: o retro replay precisa dos stores orch hidratados
  // (senão a estreia gravaria replayDone com zero eventos).
  void initOrchestration()
    .then(() => {
      startMissionSchedulerLoop();
    })
    .then(() => gamificationService.start())
    .catch((err) => {
      console.warn("[nexus] orchestration failed to start:", err);
      gamificationService.start();
    });
  // Cron: squads/agentes agendados (tick 60s, skip-if-stale).
  startCronLoop();
  // Mission driver active loop (tick 30s, budgeted apply). Spec 2026-07-13-mission-driver.
  startMissionDriverLoop();
  // Deep link nexus:// vindo no lançamento a frio (após a janela existir) +
  // auto-updater (opt-in por ambiente; no-op sem servidor configurado).
  consumeLaunchDeepLink();
  initAutoUpdater({
    networkEnabled: !isCurrentProcessSmokeTest(),
  });
}

initSmokeTest();

// Single-instance + protocolo nexus:// precisam ser registrados ANTES do
// whenReady. Se outra instância já detém o lock, saímos (ela recebe o link).
if (!wireDeepLinks()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    // No service initialization belongs before this call. Some macOS APIs
    // (notably Keychain-backed providers) can block the Electron main thread;
    // the native window/Dock item must already exist before touching them.
    createMainWindow();
    startMacOSDockWatchdog();

    // Agent awake: prevent sleep while provider hooks report working.
    getAgentAwakeService();
    registerAgentHookIpc();

    // The desktop shell must be visible before any optional integration starts.
    // In particular, starting the local agent-hook server may wait on a port or
    // a stale child process. Awaiting it here used to leave Electron alive as a
    // background/UIElement process with no BrowserWindow, so macOS hid Nexus
    // from the Dock and the user saw no actionable error. Bootstrap the window
    // first; integrations below are deliberately best-effort and may continue
    // asynchronously after the UI is available.
    // This must remain the first potentially visible operation after Electron
    // is ready. Do not move it into bootstrap(): synchronous adapter, settings,
    // database, or keychain setup can otherwise classify the process as a
    // background UIElement before macOS has a window/Dock item to display.
    bootstrap();

    // Bootstrap can create auxiliary native windows after the main window is
    // visible. Re-arm the short Dock check after that graph has settled; the
    // pre-bootstrap check alone can finish too early and be followed by a late
    // AppKit reclassification.
    stopMacOSDockWatchdog();
    startMacOSDockWatchdog();

    // Gap A: register Claude+Codex managed hook installers. Installing edits the
    // user's GLOBAL ~/.claude & ~/.codex config (affects those tools even outside
    // Nexus), so we NEVER install on launch without consent — register only, then
    // prompt once and install/remove per the persisted decision (option A).
    if (!isCurrentProcessSmokeTest()) {
      try {
        const userDataPath = app.getPath("userData");
        configureAgentRuntimeUserDataPath(userDataPath);
        bootstrapManagedAgentHooks({ enabled: false });
        const hookServer = await startAgentHookHttpServer({ userDataPath });
        configureAgentHookEndpointPath(hookServer.endpointFilePath);
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
    if (process.platform === "darwin" && !isCurrentProcessSmokeTest()) {
      void systemPreferences.askForMediaAccess("microphone").catch(() => {});
    }
  });
}

let quitPromptOpen = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

app.on("activate", () => {
  startMacOSDockWatchdog();
  if (
    shouldCreateWindowOnActivate({
      isShutdownInProgress: shutdownPromise !== null,
      isShutdownComplete: shutdownComplete,
      // O pet não conta como janela de app: com ele vivo, o clique no Dock
      // ainda precisa reabrir a janela principal.
      windowCount: BrowserWindow.getAllWindows().filter(
        (win) => !isPetWindow(win),
      ).length,
    })
  ) {
    createMainWindow();
  }
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
  registerNotesListener(wc);
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
    unregisterNotesListener(wc);
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

function shutdown(): Promise<void> {
  if (shutdownComplete) return Promise.resolve();
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stopMacOSDockWatchdog();
    killAllSessions();
    disposeAllOmpRpcSessions();
    shutdownPtyHost();
    await closeAllDesignWritebacks();
    stopRemoteBridge();
    configureAgentHookEndpointPath(null);
    await stopAgentHookHttpServer().catch(() => {});
    disposeAgentAwakeService();
    closeOrchestration();
    closeAdapterRegistry();
    closeVoiceIpc();
    shutdownUsageTelemetry();
    shutdownQuotaService();
    shutdownGamificationService();
    stopCronLoop();
    disposeCronRuntime();
    stopMissionDriverLoop();
    disposeMissionDriverIo();
    stopMissionSchedulerLoop();
    disposeMissionScheduler();
    disposeSyncRuntime();
    disposeNexusDoctorRuntime();
    disposeAuditLogRuntime();
    disposeContextWorkflowRegistry();
    disposeWorktreeRuntimeRegistry();
    closeDb();
    projectRuntimeManager?.closeAll();
    projectRuntimeManager = null;
    shutdownComplete = true;
  })();
  return shutdownPromise;
}

app.on("before-quit", (event) => {
  const summary = liveSessionSummary();
  if (
    closeNeedsConfirmation({
      sessionCount: summary.total,
      authorized: isAppQuitAuthorized(),
      smokeTest: isCurrentProcessSmokeTest(),
    })
  ) {
    event.preventDefault();
    if (quitPromptOpen) return;
    quitPromptOpen = true;
    const options = {
      type: "warning" as const,
      title: "Sair do NexusIDE?",
      message: `${summary.total} terminal${summary.total === 1 ? "" : "is"} ainda em execução`,
      detail:
        summary.busy > 0
          ? `${summary.busy} ainda estão trabalhando. Sair encerra esses processos e tarefas.`
          : "Sair encerra os processos de todos os panes.",
      buttons: ["Cancelar", "Sair e encerrar processos"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const focused = BrowserWindow.getFocusedWindow();
    const prompt = focused
      ? dialog.showMessageBox(focused, options)
      : dialog.showMessageBox(options);
    void prompt
      .then(({ response }) => {
        quitPromptOpen = false;
        if (response !== 1) return;
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
    void shutdown()
      .then(() => {
        authorizeAppQuit();
        app.quit();
      })
      .catch((error) => {
        console.error("[main] shutdown failed:", error);
        app.exit(1);
      });
  }
});
