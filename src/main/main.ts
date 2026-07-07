import { app, BrowserWindow } from 'electron';
import { resolveUserPath } from './path-resolver';
import { createMainWindow } from './window';
import { registerAuthProbeIpc } from './adapters/auth-probe';
import { shouldUseUserDataOverride } from './smoke-core';

// Sandbox de userData para dev/smoke: redireciona SQLite, layout, sessões e o
// single-instance lock para um diretório isolado. Em app empacotado só vale
// para `--smoke-test`; launches normais nunca obedecem env override.
const userDataOverride = process.env.NEXUS_USER_DATA_DIR;
if (
  userDataOverride &&
  shouldUseUserDataOverride(app.isPackaged, process.argv, userDataOverride)
) {
  app.setPath('userData', userDataOverride);
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
      : '0';
  app.commandLine.appendSwitch('remote-debugging-port', port);
  console.warn(
    '[main] AVISO: remote debugging (CDP) habilitado na porta ' +
      (port === '0' ? 'aleatória (ver DevToolsActivePort)' : port) +
      '. Qualquer processo local pode executar JS no renderer — use só em máquina confiável.',
  );
}
import { registerPtyIpc } from './pty/pty-ipc';
import {
  registerBrowserIpc,
  destroyBrowsersFor,
} from './browser/browser-manager';
import { registerPerfIpc } from './perf/perf-ipc';
import { registerLayoutIpc } from './persistence/layout-ipc';
import { registerAdapterIpc } from './adapters/adapter-ipc';
import { registerVoiceIpc, closeVoiceIpc } from './voice/voice-ipc';
import {
  initAdapterRegistry,
  registerAdapterListener,
  unregisterAdapterListener,
  closeAdapterRegistry,
} from './adapters/adapter-registry';
import {
  initOrchestration,
  registerOrchIpc,
  registerOrchListener,
  unregisterOrchListener,
  closeOrchestration,
} from './orch/orch-ipc';
import { killAllSessions } from './pty/pty-manager';
import { shutdownPtyHost } from './pty/pty-host-client';
import { initUsageTelemetry, shutdownUsageTelemetry } from './usage/usage-service';
import { closeDb } from './persistence/db';
import {
  registerSettingsIpc,
  registerSettingsListener,
  unregisterSettingsListener,
} from './persistence/settings-store';
import {
  registerWorkspaceIpc,
  registerWorkspaceListener,
  unregisterWorkspaceListener,
} from './persistence/workspace-store';
import {
  registerProviderIpc,
  registerProviderListener,
  unregisterProviderListener,
} from './persistence/provider-config-store';
import { registerFilesIpc } from './persistence/files-ipc';
import {
  registerAccountIpc,
  registerAccountListener,
  unregisterAccountListener,
} from './persistence/account-ipc';
import {
  registerCostIpc,
  registerCostListener,
  unregisterCostListener,
} from './orch/cost-ipc';
import { registerBillingIpc } from './persistence/billing-ipc';
import { syncLicenseOnBoot } from './license-sync';
import { registerTeamIpc } from './team-ipc';
import { registerOnboardingIpc } from './persistence/onboarding-store';
import {
  registerNotesIpc,
  registerNotesListener,
  unregisterNotesListener,
} from './persistence/notes-ipc';
import {
  registerPipeIpc,
  registerPipeListener,
  unregisterPipeListener,
} from './orch/pane-pipe-ipc';
import { registerRemoteIpc } from './remote/remote-ipc';
import { registerMediaIpc } from './media/media-ipc';
import { registerGamificationIpc } from './gamification/gamification-ipc';
import {
  initGamificationService,
  shutdownGamificationService,
} from './gamification/gamification-service';
import { startCronLoop, stopCronLoop } from './orch/cron-runtime';
import { wireDeepLinks, consumeLaunchDeepLink } from './deep-link';
import { initAutoUpdater } from './updater';
import { stopRemoteBridge } from './remote/remote-bridge';
import { initSmokeTest } from './smoke-test';

// Windows installer housekeeping (no-op elsewhere).
if (process.platform === 'win32') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require('electron-squirrel-startup')) {
      app.quit();
    }
  } catch {
    // Package not present outside Windows packaging — ignore.
  }
}

function bootstrap(): void {
  // MUST run before the adapter registry probes for installed CLIs: a
  // Finder/dmg launch has a minimal PATH that hides claude/codex/kimi/grok.
  resolveUserPath();
  initAdapterRegistry();
  registerPtyIpc();
  registerBrowserIpc();
  registerPerfIpc();
  registerLayoutIpc();
  registerAdapterIpc();
  registerVoiceIpc();
  registerOrchIpc();
  registerSettingsIpc();
  registerAuthProbeIpc();
  registerWorkspaceIpc();
  registerProviderIpc();
  registerFilesIpc();
  registerAccountIpc();
  registerCostIpc();
  registerMediaIpc();
  registerGamificationIpc();
  // Telemetria REAL de tokens (transcript watchers → SQLite). Convive com o
  // cost-tracker heurístico: a UI prefere o real quando ele existe.
  initUsageTelemetry();
  registerNotesIpc();
  registerBillingIpc();
  registerTeamIpc();
  syncLicenseOnBoot();
  registerOnboardingIpc();
  registerPipeIpc(); // also calls initPanePipes()
  registerRemoteIpc();
  // Orchestration boots async (MCP server binds a localhost port); the window
  // opens immediately and orchestration attaches when ready.
  // Gamificação SÓ depois: o retro replay precisa dos stores orch hidratados
  // (senão a estreia gravaria replayDone com zero eventos).
  void initOrchestration()
    .then(() => initGamificationService())
    .catch((err) =>
      console.warn('[nexus] orchestration failed to start:', err),
    );
  // Cron: squads/agentes agendados (tick 60s, skip-if-stale).
  startCronLoop();
  createMainWindow();
  // Deep link nexus:// vindo no lançamento a frio (após a janela existir) +
  // auto-updater (opt-in por ambiente; no-op sem servidor configurado).
  consumeLaunchDeepLink();
  initAutoUpdater();
}

initSmokeTest();

// Single-instance + protocolo nexus:// precisam ser registrados ANTES do
// whenReady. Se outra instância já detém o lock, saímos (ela recebe o link).
if (!wireDeepLinks()) {
  app.quit();
} else {
  app.whenReady().then(bootstrap);
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('browser-window-created', (_event, win) => {
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
  win.once('closed', () => {
    unregisterAdapterListener(wc);
    unregisterOrchListener(wc);
    unregisterSettingsListener(wc);
    unregisterWorkspaceListener(wc);
    unregisterProviderListener(wc);
    unregisterAccountListener(wc);
    unregisterCostListener(wc);
    unregisterNotesListener(wc);
    unregisterPipeListener(wc);
    destroyBrowsersFor(wc);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killAllSessions();
  shutdownPtyHost();
  stopRemoteBridge();
  closeOrchestration();
  closeAdapterRegistry();
  closeVoiceIpc();
  shutdownUsageTelemetry();
  shutdownGamificationService();
  stopCronLoop();
  closeDb();
});
