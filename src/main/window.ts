import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { WINDOW_CHANNELS } from '../shared/channels';
import { killSessionsFor, liveSessionSummary } from './pty/pty-manager';
import { closeNeedsConfirmation, isAppQuitAuthorized } from './close-authorization';
import { isCurrentProcessSmokeTest } from './smoke-core';
import { RENDERER_PROTOCOL_ENTRY_URL } from './renderer-protocol';
import {
  DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES,
  DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
  RendererRecoveryCircuitBreaker,
} from './reliability/renderer-recovery-circuit-breaker';
import {
  decideRendererLoadWatchdog,
  RENDERER_LOAD_STALL_MS,
} from './reliability/renderer-load-watchdog';
import { handleRenderProcessGone } from './agent-runtime/agent-runtime-bridge';
import {
  applyMacOSDockIcon,
  ensureRegularMacOSActivation,
  reassertMacOSDockPresence,
} from './macos-activation-policy';

/**
 * Last-resort recovery screen: if React never mounts after repeated reloads (or
 * the renderer keeps crashing), inject a readable message so the user sees
 * something actionable instead of a permanent black window. Injected via
 * executeJavaScript (privileged, CSP-exempt); the retry listener is attached
 * programmatically, never as an inline handler the CSP would block.
 */
function showRecoveryScreen(wc: WebContents): void {
  console.error('[window] app não montou após várias tentativas — tela de recuperação');
  const script = `(() => {
    document.documentElement.innerHTML =
      '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0e15;color:#d7dfec;font-family:system-ui,sans-serif">' +
      '<div style="max-width:520px;text-align:center;padding:24px">' +
      '<h1 style="font-size:18px;font-weight:600;margin:0 0 12px">NexusIDE não iniciou</h1>' +
      '<p style="font-size:13px;line-height:1.5;color:#9aa4b2;margin:0 0 20px">A interface não carregou após várias tentativas. Recarregue ou reinicie o app.</p>' +
      '<button id="nexus-retry" style="padding:8px 20px;font-size:13px;color:#e6e9ef;background:#2a3346;border:1px solid #3a4560;border-radius:8px;cursor:pointer">Recarregar</button>' +
      '</div></body>';
    var b = document.getElementById('nexus-retry');
    if (b) b.addEventListener('click', function () { location.reload(); });
  })();`;
  wc.executeJavaScript(script).catch(() => {
    // Renderer process itself is gone — nothing to inject into.
  });
}

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
      "frame-ancestors 'none'",
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
    "frame-ancestors 'none'",
  ].join('; ');
}

interface TrustedMainWindowRecord {
  window: BrowserWindow;
  rendererUrl: string;
}

const trustedMainWindows = new WeakMap<WebContents, TrustedMainWindowRecord>();

function isExpectedRendererLocation(currentRaw: string, expectedRaw: string): boolean {
  try {
    const current = new URL(currentRaw);
    const expected = new URL(expectedRaw);
    return (
      current.username === '' &&
      current.password === '' &&
      expected.username === '' &&
      expected.password === '' &&
      current.protocol === expected.protocol &&
      current.host === expected.host
    );
  } catch {
    return false;
  }
}

/**
 * Binds external-link authority to this exact main-window WebContents.
 * Auxiliary BrowserWindows (pet, OAuth and embedded browser surfaces) never
 * enter this registry, even if one of them can forge the renderer URL.
 */
export function bindTrustedMainWindow(
  window: BrowserWindow,
  rendererUrl: string,
): void {
  const contents = window.webContents;
  trustedMainWindows.set(contents, { window, rendererUrl });
  contents.once('destroyed', () => {
    const current = trustedMainWindows.get(contents);
    if (current?.window === window) trustedMainWindows.delete(contents);
  });
}

function isLiveTrustedMainWindowSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
): boolean {
  const sender = event.sender;
  const trusted = trustedMainWindows.get(sender);
  if (!trusted) return false;
  try {
    if (
      trusted.window.isDestroyed() ||
      sender.isDestroyed() ||
      sender.isCrashed() ||
      trusted.window.webContents !== sender ||
      event.senderFrame !== sender.mainFrame
    ) {
      return false;
    }
    return isExpectedRendererLocation(sender.getURL(), trusted.rendererUrl);
  } catch {
    // Electron getters can throw while a BrowserWindow/WebContents is dying.
    return false;
  }
}

export function handleOpenExternalRequest(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  raw: unknown,
): { ok: boolean; error?: string } {
  if (!isLiveTrustedMainWindowSender(event)) {
    return { ok: false, error: 'renderer não autorizado' };
  }
  if (typeof raw !== 'string' || raw.length > 2_048) {
    return { ok: false, error: 'URL inválida' };
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') {
      return { ok: false, error: 'protocolo não permitido' };
    }
    void shell.openExternal(url.toString());
    return { ok: true };
  } catch {
    return { ok: false, error: 'URL inválida' };
  }
}

let externalLinkIpcRegistered = false;

export function registerExternalLinkIpc(): void {
  if (externalLinkIpcRegistered) return;
  externalLinkIpcRegistered = true;
  ipcMain.handle(WINDOW_CHANNELS.openExternal, handleOpenExternalRequest);
  ipcMain.handle(WINDOW_CHANNELS.authLogin, (event, provider: unknown) => {
    if (!isLiveTrustedMainWindowSender(event)) {
      return { ok: false, error: 'renderer não autorizado' };
    }
    if (provider !== 'github' && provider !== 'google') {
      return { ok: false, error: 'provider inválido' };
    }
    // O main gera o nonce do binding e abre o browser — o renderer nunca
    // monta a URL de auth (ver auth-client.beginLogin).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { beginLogin } = require('./auth-client') as typeof import('./auth-client');
    return beginLogin(provider);
  });
  ipcMain.handle(WINDOW_CHANNELS.openLegalNotices, async (event) => {
    if (!isLiveTrustedMainWindowSender(event)) {
      return { ok: false, error: 'renderer não autorizado' };
    }
    // Packaged: files live at the app.asar root (forge shouldPackageFile).
    // Dev: walk up from app path / cwd.
    const { app } = await import('electron');
    const { resolveThirdPartyNoticesPath, materializeOpenableNoticesPath } =
      await import('./legal-notices-path');
    const found = resolveThirdPartyNoticesPath({
      appPath: app.getAppPath(),
      cwd: process.cwd(),
    });
    if (!found) {
      return { ok: false, error: 'THIRD_PARTY_NOTICES.md não encontrado no pacote' };
    }
    let openable: string;
    try {
      openable = materializeOpenableNoticesPath(found, app.getPath('temp'));
    } catch (extractErr) {
      return {
        ok: false,
        error: `falha ao extrair o aviso legal do pacote: ${
          extractErr instanceof Error ? extractErr.message : String(extractErr)
        }`,
      };
    }
    const err = await shell.openPath(openable);
    if (err) return { ok: false, error: err };
    return { ok: true, path: openable };
  });
}

let cspRegistered = false;

/**
 * Apply the CSP via response headers on the default session so it also covers
 * the dev server (a static <meta> tag can't allow the HMR socket). Guarded:
 * `createMainWindow` roda de novo no `activate` do macOS e registrar outro
 * handler substituiria/duplicaria o anterior.
 */
export function registerCsp(devServerUrl: string | undefined): void {
  if (cspRegistered) return;
  // Build before installing so an invalid dev-server URL cannot defer the
  // failure until the first response, after renderer loading has begun.
  const policy = buildCsp(devServerUrl);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
  // Set only after Electron accepted the hook. A failed registration must be
  // retryable and must never make a later window believe CSP is installed.
  cspRegistered = true;
}

export function ensureMacDockPresence(): void {
  // Single path for policy + icon + show-if-hidden. Avoids repeated dock.show()
  // which can leave a zero-height ghost tile after UIElement thrashing.
  reassertMacOSDockPresence();
}

export function createMainWindow(): BrowserWindow | null {
  const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const rendererUrl = devServerUrl ?? RENDERER_PROTOCOL_ENTRY_URL;

  // Establish the user-facing application policy before the first native
  // window exists. This keeps launches from helpers/deep links visible in the
  // Dock instead of inheriting an accessory/background-only policy.
  ensureMacDockPresence();

  // CSP is a renderer precondition, not an optional integration. Register it
  // before constructing the BrowserWindow so a damaged Electron session can
  // never load or expose an unprotected renderer.
  try {
    registerCsp(devServerUrl);
  } catch (error) {
    console.error('[window] CSP registration failed — renderer blocked:', error);
    try {
      dialog.showErrorBox(
        'NexusIDE bloqueou a inicialização',
        'A política de segurança da interface (CSP) não pôde ser instalada. ' +
          'O Nexus não carregará o renderer sem essa proteção. Reinicie o app.',
      );
    } catch {
      // The renderer remains blocked even if the native error surface failed.
    }
    return null;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    // Precisa casar com --bg (base.css) — cor de pré-paint da janela.
    backgroundColor: '#0a0e15',
    title: 'NexusIDE',
    // Do not expose the native surface while the custom protocol is still
    // retrying. A first ERR_FAILED is recoverable, but showing each retry makes
    // the entire Nexus window visibly blink during startup.
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Pin the safe defaults explicitly (L3) so a future Electron default change
      // or an accidental edit can't silently weaken the renderer.
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Policy already set before construction; only re-apply the icon now that
  // Electron has a live Dock controller. Avoid a second dock.show() here —
  // show() thrash is what left a 12×0 ghost tile on some launches.
  applyMacOSDockIcon();
  // Final presence check once the renderer has actually loaded.
  win.webContents.once('did-finish-load', ensureMacDockPresence);

  bindTrustedMainWindow(win, rendererUrl);

  // External-link/auth/legal IPC remains an optional native integration. It is
  // deliberately separate from the fail-closed CSP precondition above.
  try {
    registerExternalLinkIpc();
  } catch (error) {
    console.error('[window] optional external-link IPC failed:', error);
  }

  // Block in-app navigation and new windows — the renderer only ever loads our
  // own bundle. Defense in depth against a compromised renderer.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // Capture the reference up front: inside the 'destroyed' handler the
  // `win.webContents` getter can already throw "Object has been destroyed".
  const wc = win.webContents;

  let windowCloseAuthorized = false;
  let windowClosePromptOpen = false;
  win.on('close', (event) => {
    const summary = liveSessionSummary(wc);
    if (
      !closeNeedsConfirmation({
        sessionCount: summary.total,
        authorized: windowCloseAuthorized || isAppQuitAuthorized(),
        smokeTest: isCurrentProcessSmokeTest(),
      })
    ) {
      return;
    }
    event.preventDefault();
    if (windowClosePromptOpen) return;
    windowClosePromptOpen = true;
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'Fechar o NexusIDE?',
        message: `${summary.total} terminal${summary.total === 1 ? '' : 'is'} ainda em execução`,
        detail:
          summary.busy > 0
            ? `${summary.busy} ainda estão trabalhando. Fechar a janela encerra esses processos e tarefas.`
            : 'Fechar a janela encerra os processos desses panes.',
        buttons: ['Cancelar', 'Fechar e encerrar processos'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) => {
        windowClosePromptOpen = false;
        if (response !== 1 || win.isDestroyed()) return;
        windowCloseAuthorized = true;
        win.close();
      })
      .catch(() => {
        windowClosePromptOpen = false;
      });
  });

  // Boot watchdog state, shared by the load + mount phases below.
  let finished = false;
  let mounted = false;
  let nativeWindowShown = false;
  const showNativeWindow = (): void => {
    if (nativeWindowShown || win.isDestroyed()) return;
    nativeWindowShown = true;
    win.show();
    // Materialize Dock once the native window is actually shown. Focus only
    // after show resolves so we don't leave a ghost accessory tile.
    ensureRegularMacOSActivation();
    applyMacOSDockIcon();
    const dockReady =
      process.platform === 'darwin' && app.dock && !app.dock.isVisible?.()
        ? app.dock.show()
        : undefined;
    void Promise.resolve(dockReady)
      .then(() => {
        ensureRegularMacOSActivation();
        applyMacOSDockIcon();
        app.focus?.({ steal: true });
        if (!win.isDestroyed()) win.focus();
      })
      .catch((error) => {
        console.warn('[window] macOS Dock activation failed:', error);
        if (!win.isDestroyed()) win.focus();
      });
  };
  let mountReloads = 0;
  const MAX_MOUNT_RELOADS = 5;
  // Sliding-window circuit breaker (ORCA harvest): caps auto-reloads so a
  // deterministic per-load crash cannot spin forever. Manual reload after the
  // recovery screen resets the breaker so the user can try again.
  const rendererRecoveryCircuitBreaker = new RendererRecoveryCircuitBreaker({
    windowMs: DEFAULT_RENDERER_RECOVERY_WINDOW_MS,
    maxRecoveries: DEFAULT_RENDERER_RECOVERY_MAX_RECOVERIES,
  });
  let recoveryScreenShown = false;

  // Renderer → main mount signal, fired from a post-commit effect and scoped to
  // THIS window's sender. This — not a console log — is how the mount watchdog
  // knows React actually painted, in dev AND in the packaged app.
  const onMounted = (event: IpcMainEvent) => {
    if (event.sender === wc) {
      mounted = true;
      showNativeWindow();
    }
  };
  ipcMain.on(WINDOW_CHANNELS.mounted, onMounted);
  // Capture wc up front: inside 'destroyed' the win.webContents getter can
  // already throw "Object has been destroyed".
  wc.once('destroyed', () => {
    ipcMain.removeListener(WINDOW_CHANNELS.mounted, onMounted);
    killSessionsFor(wc);
  });

  // Dev only: surface tagged renderer logs ([wake]/[voice]/[orch]) + errors in
  // the terminal — otherwise voice/wake/boot issues are invisible without
  // DevTools. Electron novo entrega os dados no objeto do evento (args
  // posicionais deprecados); aceita os dois formatos.
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
  }

  // A renderer crash used to only log (dev), leaving a black window in
  // production. Reload a crashed renderer — capped by a sliding-window circuit
  // breaker (dev AND prod); after the breaker opens, show the recovery screen
  // instead of looping forever.
  wc.on('render-process-gone', (_e, details) => {
    console.warn('[window] renderer morreu:', details.reason);
    const decision = handleRenderProcessGone({
      details: {
        reason: details.reason,
        exitCode: typeof details.exitCode === 'number' ? details.exitCode : undefined,
      },
      circuitBreaker: rendererRecoveryCircuitBreaker,
      windowDestroyed: win.isDestroyed(),
      msSinceLaunch: typeof process.uptime === 'function' ? process.uptime() * 1000 : 0,
    });
    if (win.isDestroyed()) return;
    if (decision.showRecoveryScreen) {
      showNativeWindow();
      recoveryScreenShown = true;
      showRecoveryScreen(wc);
      return;
    }
    if (decision.reload) {
      win.reload();
    }
  });
  win.on('unresponsive', () => {
    console.warn('[window] renderer travado (unresponsive)');
  });

  // O load pode disparar ANTES do dev server do Vite aceitar conexões (a
  // janela abria preta e exigia fechar/reabrir). Auto-retry até carregar; o
  // backoff curto cobre o boot do Vite sem atrasar o caso saudável.
  let loadRetries = 0;
  let loadStartedAt = Date.now();
  let suppressAbortedLoadUntil = 0;
  const MAX_LOAD_RETRIES = 20;
  const WATCHDOG_ABORT_GRACE_MS = 1_000;
  const WATCHDOG_RESTART_DELAY_MS = 100;
  const load = () => {
    // Rejeições são esperadas durante o boot do Vite (ERR_ABORTED em reload
    // concorrente) — o watchdog cuida do retry; nunca deixar virar unhandled.
    loadStartedAt = Date.now();
    win.loadURL(rendererUrl).catch((err) => {
      console.warn('[window] load failed:', err);
    });
  };
  wc.on('did-fail-load', (_e, code, desc) => {
    if (win.isDestroyed()) return;
    if (code === -3 && Date.now() < suppressAbortedLoadUntil) return;
    loadRetries += 1;
    if (loadRetries > MAX_LOAD_RETRIES) {
      console.error(
        `[window] load falhou ${MAX_LOAD_RETRIES}x (${code} ${desc}) — desistindo do retry automático`,
      );
      return;
    }
    console.warn(`[window] load falhou (${code} ${desc}) — retry ${loadRetries}`);
    // Backoff simples: 400ms crescendo com o número de tentativas, teto 5s.
    setTimeout(() => {
      if (!win.isDestroyed()) load();
    }, Math.min(400 * loadRetries, 5_000));
  });
  // Watchdog em DUAS fases. Fase 1 (load): cobre falha sem did-fail-load
  // (conexão pendurada, Vite frio, localhost→IPv4 com servidor só em ::1).
  // Fase 2 (mount): did-finish-load NÃO garante React montado — o grafo de
  // módulos pode pendurar, ou um crash de boot deixa a janela preta. O antigo
  // prazo único de 4s recarregava a janela enquanto o React ainda estava
  // CARREGANDO (Vite frio transformando o grafo, máquina ocupada): a tela
  // pintava e era recarregada em seguida, em loop — o bug das "várias
  // piscadas" na tela inicial/onboarding. Agora a fase 2 faz polling: #root
  // com conteúdo conta como montado mesmo que o sinal IPC se perca, e o
  // reload só acontece se o root continuar VAZIO por ~20s (janela morta de
  // verdade). Após MAX, tela de recuperação.
  const watchdog = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(watchdog);
      return;
    }
    const action = decideRendererLoadWatchdog({
      isFinished: finished,
      isLoading: wc.isLoading(),
      loadAgeMs: Date.now() - loadStartedAt,
    });
    if (action === 'wait') return;
    if (action === 'restart-stalled-load') {
      console.warn(
        `[window] renderer travado por ${RENDERER_LOAD_STALL_MS / 1000}s — reiniciando carga`,
      );
      suppressAbortedLoadUntil = Date.now() + WATCHDOG_ABORT_GRACE_MS;
      wc.stop();
      setTimeout(() => {
        if (!win.isDestroyed() && !finished) load();
      }, WATCHDOG_RESTART_DELAY_MS);
      return;
    }
    console.warn('[window] renderer sem navegação ativa — tentando novamente');
    load();
  }, 3_000);
  const MOUNT_POLL_MS = 2_000;
  const MOUNT_EMPTY_CHECKS = 10; // ~20s de root vazio antes de recarregar
  let mountPoll: NodeJS.Timeout | null = null;
  wc.on('did-finish-load', () => {
    finished = true;
    loadRetries = 0;
    clearInterval(watchdog);
    // User clicked "Recarregar" on the recovery screen (or otherwise reloaded
    // after the breaker opened). Clear history so a new recovery budget applies.
    if (recoveryScreenShown) {
      rendererRecoveryCircuitBreaker.reset();
      recoveryScreenShown = false;
    }
    console.log('[window] renderer carregado');
    if (mountPoll) clearInterval(mountPoll);
    let emptyChecks = 0;
    const poll = setInterval(() => {
      if (win.isDestroyed() || mounted) {
        clearInterval(poll);
        return;
      }
      wc.executeJavaScript(
        '!!document.getElementById("root")?.childElementCount',
      )
        .then((hasContent) => {
          // Resposta atrasada de um load anterior não decide pelo atual.
          if (win.isDestroyed() || mounted || mountPoll !== poll) return;
          if (hasContent) {
            mounted = true;
            showNativeWindow();
            clearInterval(poll);
            return;
          }
          emptyChecks += 1;
          if (emptyChecks < MOUNT_EMPTY_CHECKS) return;
          clearInterval(poll);
          if (mountReloads >= MAX_MOUNT_RELOADS) {
            // Same recovery surface as crash-loop exhaustion; mark so the next
            // did-finish-load (user "Recarregar") resets the crash breaker too.
            showNativeWindow();
            recoveryScreenShown = true;
            showRecoveryScreen(wc);
            return;
          }
          mountReloads += 1;
          console.warn(
            `[window] root vazio após ${(MOUNT_POLL_MS * MOUNT_EMPTY_CHECKS) / 1000}s — reload ${mountReloads}`,
          );
          wc.reload();
        })
        .catch(() => {
          // Página em transição (navegação/reload em curso) — a próxima
          // checagem decide.
        });
    }, MOUNT_POLL_MS);
    mountPoll = poll;
  });
  wc.on('did-start-loading', () => {
    mounted = false;
    if (mountPoll) {
      clearInterval(mountPoll);
      mountPoll = null;
    }
  });
  load();

  return win;
}
