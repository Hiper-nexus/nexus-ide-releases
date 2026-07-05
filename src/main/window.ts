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

  // Wake word (Porcupine) runs bundled WASM inside a blob: Web Worker /
  // AudioWorklet — hence 'wasm-unsafe-eval' + worker-src blob:. Both refer to
  // code WE bundle (no remote origins); everything else stays strict.
  const workerSrc = "worker-src 'self' blob:";

  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin;
    const ws = origin.replace(/^http/, 'ws');
    // Dev only: Vite + @vitejs/plugin-react inject an inline module preamble for
    // Fast Refresh, so script-src needs 'unsafe-inline' here. Production (below)
    // stays strict with script-src 'self' only.
    return [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: ${origin}`,
      workerSrc,
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
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    workerSrc,
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
  // Dev only: surface tagged renderer logs ([wake]/[voice]/[orch]) in the
  // terminal — voice/wake issues are invisible without DevTools otherwise.
  if (devServerUrl) {
    wc.on('console-message', (_e, _level, message) => {
      if (/^\[(wake|voice|orch|diag)\]/.test(message)) {
        console.log('[renderer]', message);
      }
    });
  }

  // O load pode disparar ANTES do dev server do Vite aceitar conexões (a
  // janela abria preta e exigia fechar/reabrir). Auto-retry até carregar; o
  // backoff curto cobre o boot do Vite sem atrasar o caso saudável.
  let loadRetries = 0;
  const load = () => {
    if (devServerUrl) {
      void win.loadURL(devServerUrl);
    } else {
      void win.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      );
    }
  };
  wc.on('did-fail-load', (_e, code, desc) => {
    if (win.isDestroyed() || loadRetries >= 40) return;
    loadRetries += 1;
    console.warn(`[window] load falhou (${code} ${desc}) — retry ${loadRetries}`);
    setTimeout(() => {
      if (!win.isDestroyed()) load();
    }, 400);
  });
  wc.on('did-finish-load', () => {
    loadRetries = 0;
  });
  load();

  return win;
}
