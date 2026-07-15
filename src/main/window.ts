import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import type { IpcMainEvent, WebContents } from 'electron';
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
import { handleRenderProcessGone } from './agent-runtime/agent-runtime-bridge';

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

let externalLinkIpcRegistered = false;

function registerExternalLinkIpc(): void {
  if (externalLinkIpcRegistered) return;
  externalLinkIpcRegistered = true;
  ipcMain.handle(WINDOW_CHANNELS.openExternal, (_event, raw: unknown) => {
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
  });
  ipcMain.handle(WINDOW_CHANNELS.authLogin, (_event, provider: unknown) => {
    if (provider !== 'github' && provider !== 'google') {
      return { ok: false, error: 'provider inválido' };
    }
    // O main gera o nonce do binding e abre o browser — o renderer nunca
    // monta a URL de auth (ver auth-client.beginLogin).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { beginLogin } = require('./auth-client') as typeof import('./auth-client');
    return beginLogin(provider);
  });
  ipcMain.handle(WINDOW_CHANNELS.openLegalNotices, async () => {
    // Packaged: files live at the app.asar root (forge shouldPackageFile).
    // Dev: walk up from app path / cwd.
    const { app } = await import('electron');
    const { resolveThirdPartyNoticesPath } = await import('./legal-notices-path');
    const found = resolveThirdPartyNoticesPath({
      appPath: app.getAppPath(),
      cwd: process.cwd(),
    });
    if (!found) {
      return { ok: false, error: 'THIRD_PARTY_NOTICES.md não encontrado no pacote' };
    }
    const err = await shell.openPath(found);
    if (err) return { ok: false, error: err };
    return { ok: true, path: found };
  });
}

let cspRegistered = false;

/**
 * Apply the CSP via response headers on the default session so it also covers
 * the dev server (a static <meta> tag can't allow the HMR socket). Guarded:
 * `createMainWindow` roda de novo no `activate` do macOS e registrar outro
 * handler substituiria/duplicaria o anterior.
 */
function registerCsp(devServerUrl: string | undefined): void {
  if (cspRegistered) return;
  cspRegistered = true;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildCsp(devServerUrl)],
      },
    });
  });
}

function ensureMacDockPresence(): void {
  if (process.platform !== 'darwin') return;

  try {
    // Set the policy before AppKit creates any window. If the first window is
    // born while Electron is accessory/background-only, macOS can keep the
    // process out of the Dock for the rest of that launch.
    app.setActivationPolicy?.('regular');
    const dockShow = app.dock?.show();
    // A packaged launch can otherwise remain an inactive UIElement even after
    // the policy changes. Activating the user-facing window materializes the
    // regular app entry in the Dock (same behavior as opening from Finder).
    app.focus?.({ steal: true });
    void dockShow
      ?.then(() => app.focus?.({ steal: true }))
      .catch((error) => {
        console.warn('[window] macOS Dock item unavailable:', error);
      });
  } catch (error) {
    console.warn('[window] macOS activation policy unavailable:', error);
  }
}

export function createMainWindow(): BrowserWindow {
  const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const rendererUrl = devServerUrl ?? RENDERER_PROTOCOL_ENTRY_URL;

  // Establish the user-facing application policy before the first native
  // window exists. This keeps launches from helpers/deep links visible in the
  // Dock instead of inheriting an accessory/background-only policy.
  ensureMacDockPresence();

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    // Precisa casar com --bg (base.css) — cor de pré-paint da janela.
    backgroundColor: '#0a0e15',
    title: 'NexusIDE',
    show: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  win.show();
  // Re-assert after the native window exists and ask AppKit to materialize the
  // Dock item. The early call in main.ts handles launch classification; this
  // call covers launches that inherited an accessory policy from the shell.
  ensureMacDockPresence();
  // Some packaged launches let AppKit restore the accessory policy while the
  // renderer is booting. Re-apply the user-facing policy at the native UI
  // readiness boundary, after all startup modules have run.
  win.webContents.once('did-finish-load', ensureMacDockPresence);

  // The native window is the availability boundary: integrations must not be
  // able to prevent the Dock item from existing. Register optional IPC/CSP
  // surfaces after BrowserWindow construction and degrade visibly if one is
  // unavailable during a damaged or partially migrated launch.
  try {
    registerExternalLinkIpc();
    registerCsp(devServerUrl);
  } catch (error) {
    console.error('[window] optional window integrations failed:', error);
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
    if (event.sender === wc) mounted = true;
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
  const MAX_LOAD_RETRIES = 20;
  const load = () => {
    // Rejeições são esperadas durante o boot do Vite (ERR_ABORTED em reload
    // concorrente) — o watchdog cuida do retry; nunca deixar virar unhandled.
    win.loadURL(rendererUrl).catch((err) => {
      console.warn('[window] load failed:', err);
    });
  };
  wc.on('did-fail-load', (_e, code, desc) => {
    if (win.isDestroyed()) return;
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
    if (!finished) {
      console.warn('[window] renderer ainda não carregou — recarregando');
      load();
    }
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
            clearInterval(poll);
            return;
          }
          emptyChecks += 1;
          if (emptyChecks < MOUNT_EMPTY_CHECKS) return;
          clearInterval(poll);
          if (mountReloads >= MAX_MOUNT_RELOADS) {
            // Same recovery surface as crash-loop exhaustion; mark so the next
            // did-finish-load (user "Recarregar") resets the crash breaker too.
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
