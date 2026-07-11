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
import { registerVisionIpc } from "./vision/ipc-bridge";
import {
  initAdapterRegistry,
  registerAdapterListener,
  unregisterAdapterListener,
  closeAdapterRegistry,
} from "./adapters/adapter-registry";
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
  initUsageTelemetry,
  shutdownUsageTelemetry,
} from "./usage/usage-service";
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
import { registerMediaIpc } from "./media/media-ipc";
import {
  broadcastGamificationToProject,
  registerGamificationIpc,
  registerGamificationListener,
  unregisterGamificationListener,
} from "./gamification/gamification-ipc";
import { registerMcpIpc } from "./jarvis/mcp-ipc";
import { registerOpsIpc } from "./ops/ops-ipc";
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
  initAdapterRegistry();
  projectRuntimeManager = new ProjectRuntimeManager({
    baseDir: path.join(app.getPath("userData"), "project-runtime"),
    appVersion: app.getVersion(),
  });
  configureAuditLogRuntime(projectRuntimeManager);
  configurePtyProjectRuntimeManager(projectRuntimeManager);
  configureRendererMissionAuthority(projectRuntimeManager);
  const worktreeRuntime = configureWorktreeRuntimeRegistry(projectRuntimeManager);
  configureContextWorkflowRegistry(projectRuntimeManager, {
    appVersion: app.getVersion(),
    resolveIntegratedMission: (scope, missionId, baseSha) =>
      worktreeRuntime.resolveIntegratedMission(scope, missionId, baseSha),
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
  configureNexusDoctorRuntime({
    runtimeManager: projectRuntimeManager,
    multiPc: {
      leaseBackendConfigured: cronBackend !== null,
      syncBackendConfigured: syncCapability.backendConfigured,
      requireSharedExecution: true,
    },
  });
  registerPtyIpc();
  registerBrowserIpc(projectRuntimeManager);
  registerDesignWritebackIpc({ allowSourceMutation: !app.isPackaged });
  registerPerfIpc();
  registerLayoutIpc(projectRuntimeManager);
  registerAdapterIpc();
  registerVoiceIpc(projectRuntimeManager);
  registerVisionIpc();
  registerOrchIpc();
  registerSettingsIpc();
  registerAuthProbeIpc();
  registerWorkspaceIpc();
  registerProviderIpc();
  registerFilesIpc();
  registerAccountIpc();
  registerCostIpc();
  registerMediaIpc(projectRuntimeManager);
  registerGamificationIpc(gamificationService);
  registerMcpIpc();
  registerOpsIpc();
  // Telemetria REAL de tokens (transcript watchers → SQLite). Convive com o
  // cost-tracker heurístico: a UI prefere o real quando ele existe.
  initUsageTelemetry(projectRuntimeManager);
  registerNotesIpc(projectRuntimeManager);
  registerBillingIpc();
  registerTeamIpc();
  // Packaged smoke must prove the app can boot without touching the user's
  // real Keychain. License sync is useful in normal launches, but it can block
  // inside SecItemCopyMatching before the smoke window has a chance to load.
  if (!isCurrentProcessSmokeTest()) {
    syncLicenseOnBoot();
  }
  registerOnboardingIpc();
  registerPipeIpc(); // also calls initPanePipes()
  registerRemoteIpc();
  // Orchestration boots async (MCP server binds a localhost port); the window
  // opens immediately and orchestration attaches when ready.
  // Gamificação SÓ depois: o retro replay precisa dos stores orch hidratados
  // (senão a estreia gravaria replayDone com zero eventos).
  void initOrchestration()
    .then(() => gamificationService.start())
    .catch((err) => {
      console.warn("[nexus] orchestration failed to start:", err);
      gamificationService.start();
    });
  // Cron: squads/agentes agendados (tick 60s, skip-if-stale).
  startCronLoop();
  createMainWindow();
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
    // Agent awake: prevent sleep while provider hooks report working.
    getAgentAwakeService();
    registerAgentHookIpc();

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
    // CoreAudio to return all-zero PCM even with a getUserMedia grant. Explicitly
    // requesting mic access here forces a real TCC entry before the renderer opens.
    if (process.platform === "darwin" && !isCurrentProcessSmokeTest()) {
      await systemPreferences.askForMediaAccess("microphone").catch(() => {});
    }
    bootstrap();
  });
}

let quitPromptOpen = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

app.on("activate", () => {
  if (
    shouldCreateWindowOnActivate({
      isShutdownInProgress: shutdownPromise !== null,
      isShutdownComplete: shutdownComplete,
      windowCount: BrowserWindow.getAllWindows().length,
    })
  ) {
    createMainWindow();
  }
});

app.on("browser-window-created", (_event, win) => {
  // Capture the webContents reference NOW, while the window is alive. By the time
  // the 'closed' event fires the native BrowserWindow is already destroyed, and
  // the `win.webContents` getter throws "Object has been destroyed" — which, as an
  // uncaught exception inside the event emit, crashes the whole main process.
  const wc = win.webContents;
  registerAdapterListener(wc);
  registerOrchListener(wc);
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
    unregisterOrchListener(wc);
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
    killAllSessions();
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
    shutdownGamificationService();
    stopCronLoop();
    disposeCronRuntime();
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
