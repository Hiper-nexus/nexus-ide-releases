import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerPtyIpc } from './pty/pty-ipc';
import { registerLayoutIpc } from './persistence/layout-ipc';
import { registerAdapterIpc } from './adapters/adapter-ipc';
import {
  initAdapterRegistry,
  registerAdapterListener,
  unregisterAdapterListener,
  closeAdapterRegistry,
} from './adapters/adapter-registry';
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
  createMainWindow();
}

app.whenReady().then(bootstrap);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('browser-window-created', (_event, win) => {
  registerAdapterListener(win.webContents);
  win.on('closed', () => unregisterAdapterListener(win.webContents));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killAllSessions();
  closeAdapterRegistry();
  closeDb();
});
