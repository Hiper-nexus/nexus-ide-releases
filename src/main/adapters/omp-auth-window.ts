import { BrowserWindow } from 'electron';

/**
 * Janela in-app de autorização OAuth do omp (`omp auth-broker login`).
 *
 * Por que existe: o fluxo abria a URL no navegador do sistema via
 * `openExternal`; a página de sucesso do oh-my-pi ("Authentication
 * Successful") tem um botão "Close Window" que chama `window.close()` — e
 * todo browser bloqueia `window.close()` em aba não aberta por script. A aba
 * ficava pendurada para sempre. Num BrowserWindow NOSSO, o main fecha a
 * janela sozinho quando o fluxo termina (`done`/`error` do OmpLoginFlow) e o
 * botão de fechar do OS sempre funciona.
 *
 * Endurecimento: sessão efêmera (cookies do OAuth não tocam a sessão do
 * app), sandbox sem preload/nodeIntegration, popups negados, navegação só
 * https (+ http exclusivamente em loopback, para callbacks locais de
 * device-flow) e permissões negadas.
 */

const AUTH_WINDOW_WIDTH = 540;
const AUTH_WINDOW_HEIGHT = 760;

/** Página de sucesso fica visível por um instante antes do auto-fechamento. */
export const OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS = 1_500;

type CreateWindow = (url: string) => BrowserWindow;

let authWindow: BrowserWindow | null = null;
let closeTimer: NodeJS.Timeout | null = null;

/**
 * https sempre; http só em loopback (callback local de device-flow).
 * javascript:/file:/data: nunca.
 */
export function isAllowedOmpAuthUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') {
      return (
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]'
      );
    }
    return false;
  } catch {
    return false;
  }
}

function defaultCreateWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: AUTH_WINDOW_WIDTH,
    height: AUTH_WINDOW_HEIGHT,
    autoHideMenuBar: true,
    title: 'Autorização oh-my-pi',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Sessão efêmera por janela: cookies/tokens do OAuth não vazam para a
      // sessão principal do app nem sobrevivem ao fechamento.
      partition: `omp-auth-${Date.now()}`,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (!isAllowedOmpAuthUrl(target)) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  void win.loadURL(url);
  return win;
}

/**
 * Abre (ou reutiliza) a janela de autorização apontando para `url`.
 * Instância única: um segundo fluxo reutiliza a janela viva.
 */
export function openOmpAuthWindow(
  url: string,
  createWindow: CreateWindow = defaultCreateWindow,
): { ok: boolean; error?: string } {
  if (!isAllowedOmpAuthUrl(url)) {
    return { ok: false, error: `URL de autorização recusada: ${url.slice(0, 200)}` };
  }
  clearScheduledClose();
  try {
    if (authWindow && !authWindow.isDestroyed()) {
      void authWindow.loadURL(url);
      authWindow.focus();
      return { ok: true };
    }
    authWindow = createWindow(url);
    authWindow.on('closed', () => {
      authWindow = null;
    });
    authWindow.focus();
    return { ok: true };
  } catch (err) {
    authWindow = null;
    return {
      ok: false,
      error: `falha ao abrir a janela de autorização: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Fecha a janela de autorização. `delayMs > 0` agenda o fechamento (usado no
 * `done`, para a página de sucesso ser perceptível); um novo `open` cancela
 * o fechamento agendado.
 */
export function closeOmpAuthWindow(delayMs = 0): void {
  clearScheduledClose();
  if (!authWindow || authWindow.isDestroyed()) {
    authWindow = null;
    return;
  }
  if (delayMs > 0) {
    closeTimer = setTimeout(() => {
      closeTimer = null;
      closeOmpAuthWindow();
    }, delayMs);
    closeTimer.unref?.();
    return;
  }
  const win = authWindow;
  authWindow = null;
  if (!win.isDestroyed()) win.close();
}

/** Encerramento do app: fecha imediatamente, sem timer pendurado. */
export function disposeOmpAuthWindow(): void {
  closeOmpAuthWindow();
}

function clearScheduledClose(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}
