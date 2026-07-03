import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
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
import { closeDb } from './persistence/db';

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
  initAdapterRegistry();
  registerPtyIpc();
  registerLayoutIpc();
  registerAdapterIpc();
  registerVoiceIpc();
  registerOrchIpc();
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
  win.once('closed', () => {
    unregisterAdapterListener(wc);
    unregisterOrchListener(wc);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killAllSessions();
  closeOrchestration();
  closeAdapterRegistry();
  closeVoiceIpc();
  closeDb();
});
