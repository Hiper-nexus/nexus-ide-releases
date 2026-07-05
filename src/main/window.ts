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
  // Electron novo entrega os dados no objeto do evento (args posicionais
  // deprecados); aceita os dois formatos. Erros passam SEMPRE (sem filtro
  // de tag): um crash de boot do React era invisível e a janela só "ficava
  // preta".
  if (devServerUrl) {
    type ConsoleEvt = { message?: string; level?: string | number };
    wc.on(
      'console-message',
      (evt: ConsoleEvt, legacyLevel?: number, legacyMessage?: string) => {
        const message = evt?.message ?? legacyMessage ?? '';
        const level = evt?.level ?? legacyLevel;
        const isError = level === 'error' || level === 3;
        if (isError || /^\[(wake|voice|orch|diag)\]/.test(message)) {
          console.log(isError ? '[renderer:ERRO]' : '[renderer]', message);
        }
      },
    );
    wc.on('render-process-gone', (_e, details) => {
      console.warn('[window] renderer morreu:', details.reason);
    });
  }

  // O load pode disparar ANTES do dev server do Vite aceitar conexões (a
  // janela abria preta e exigia fechar/reabrir). Auto-retry até carregar; o
  // backoff curto cobre o boot do Vite sem atrasar o caso saudável.
  let loadRetries = 0;
  const load = () => {
    // Rejeições são esperadas durante o boot do Vite (ERR_ABORTED em reload
    // concorrente) — o watchdog cuida do retry; nunca deixar virar unhandled.
    if (devServerUrl) {
      win.loadURL(devServerUrl).catch(() => {});
    } else {
      win
        .loadFile(
          path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
        )
        .catch(() => {});
    }
  };
  wc.on('did-fail-load', (_e, code, desc) => {
    if (win.isDestroyed()) return;
    loadRetries += 1;
    console.warn(`[window] load falhou (${code} ${desc}) — retry ${loadRetries}`);
    setTimeout(() => {
      if (!win.isDestroyed()) load();
    }, 400);
  });
  // Watchdog em DUAS fases. Fase 1 (load): cobre falha sem did-fail-load
  // (conexão pendurada, Vite frio, localhost→IPv4 com servidor só em ::1).
  // Fase 2 (mount): did-finish-load NÃO garante React montado — no primeiro
  // load com Vite frio o grafo de módulos às vezes pendura e a janela fica
  // preta para sempre; o renderer emite '[diag] app montado' no render() e,
  // se o sinal não chegar em 4s, recarregamos. Só em dev (packaged carrega
  // arquivo local, sem corrida).
  let finished = false;
  let mounted = false;
  let mountReloads = 0;
  const watchdog = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(watchdog);
      return;
    }
    if (!finished) {
      console.warn('[window] renderer ainda não carregou — recarregando');
      load();
    }
  }, 3_000);
  if (devServerUrl) {
    wc.on('console-message', (evt: { message?: string }, _l?: number, legacy?: string) => {
      if ((evt?.message ?? legacy ?? '').startsWith('[diag] app montado')) {
        mounted = true;
      }
    });
  }
  wc.on('did-finish-load', () => {
    finished = true;
    loadRetries = 0;
    clearInterval(watchdog);
    console.log('[window] renderer carregado');
    if (!devServerUrl) return;
    setTimeout(function checkMount() {
      if (win.isDestroyed() || mounted || mountReloads >= 30) return;
      mountReloads += 1;
      console.warn(`[window] página carregou mas o app não montou — reload ${mountReloads}`);
      wc.reload();
    }, 4_000);
  });
  wc.on('did-start-loading', () => {
    mounted = false;
  });
  load();

  return win;
}
