import { app, BrowserWindow } from 'electron';
import { resolveUserPath } from './path-resolver';
import { createMainWindow } from './window';
import { registerAuthProbeIpc } from './adapters/auth-probe';

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
  registerNotesIpc();
  registerBillingIpc();
  registerPipeIpc(); // also calls initPanePipes()
  // Orchestration boots async (MCP server binds a localhost port); the window
  // opens immediately and orchestration attaches when ready.
  void initOrchestration().catch((err) =>
    console.warn('[nexus] orchestration failed to start:', err),
  );
  createMainWindow();
}

app.whenReady().then(bootstrap);

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
  closeOrchestration();
  closeAdapterRegistry();
  closeVoiceIpc();
  closeDb();
});
