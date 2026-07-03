import path from 'node:path';
import { BrowserWindow, session } from 'electron';
import { killSessionsFor } from './pty/pty-manager';

/**
 * Builds the Content-Security-Policy. Production is strict (`'self'` only). Dev
 * loosens just enough for Vite's HMR websocket + dev-server origin, and allows
 * inline styles because both Vite and xterm inject <style>/style attributes.
 */
function buildCsp(devServerUrl: string | undefined): string {
  const styleSrc = "style-src 'self' 'unsafe-inline'";
  const fontSrc = "font-src 'self' data:";
  const imgSrc = "img-src 'self' data:";

  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin;
    const ws = origin.replace(/^http/, 'ws');
    // Dev only: Vite + @vitejs/plugin-react inject an inline module preamble for
    // Fast Refresh, so script-src needs 'unsafe-inline' here. Production (below)
    // stays strict with script-src 'self' only.
    return [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' ${origin}`,
      styleSrc,
      fontSrc,
      imgSrc,
      `connect-src 'self' ${origin} ${ws}`,
      "object-src 'none'",
      "base-uri 'self'",
      "frame-src 'none'",
    ].join('; ');
  }

  return [
    "default-src 'self'",
    "script-src 'self'",
    styleSrc,
    fontSrc,
    imgSrc,
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
  ].join('; ');
}

export function createMainWindow(): BrowserWindow {
  const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;

  // Apply the CSP via response headers on this window's session so it also
  // covers the dev server (a static <meta> tag can't allow the HMR socket).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildCsp(devServerUrl)],
      },
    });
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: '#0b0e14',
    title: 'NexusIDE',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  // Block in-app navigation and new windows — the renderer only ever loads our
  // own bundle. Defense in depth against a compromised renderer.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // Capture the reference up front: inside the 'destroyed' handler the
  // `win.webContents` getter can already throw "Object has been destroyed".
  const wc = win.webContents;
  wc.once('destroyed', () => killSessionsFor(wc));

  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  return win;
}
