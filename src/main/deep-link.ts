import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';

/**
 * Deep link `nexus://` + document open. O parser é PURO e valida com rigor
 * (deep link é vetor clássico de RCE em Electron — auditoria §6): esquema fixo,
 * host allowlisted, token no conjunto seguro e com teto, path SEMPRE absoluto.
 * A borda (registrar protocolo, eventos, roteamento) fica em wireDeepLinks().
 */

const SCHEME = 'nexus';
const TOKEN_MAX = 4_096;
const SAFE_TOKEN = /^[A-Za-z0-9._~-]+$/;

export type DeepLink =
  | { kind: 'license'; token: string }
  | { kind: 'open'; path: string }
  | { kind: 'auth'; code: string; state: string | null };

export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:`) return null;
  const host = url.hostname;

  if (host === 'license') {
    const token =
      url.searchParams.get('token') ??
      decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!token || token.length > TOKEN_MAX || !SAFE_TOKEN.test(token)) {
      return null;
    }
    return { kind: 'license', token };
  }

  if (host === 'open') {
    const p = url.searchParams.get('path');
    // Só caminho absoluto — nunca relativo (evita surpresa/traversal).
    if (!p || !path.isAbsolute(p) || p.includes('\0')) return null;
    return { kind: 'open', path: p };
  }

  if (host === 'auth') {
    // Code de uso único do login (nexus://auth/<code>?state=<nonce>) —
    // trocado por tokens no backend. O state é o nonce que o PRÓPRIO app
    // gerou ao iniciar o login; a validação contra o pendente acontece no
    // auth-client. Mesmo rigor dos demais: conjunto seguro + teto.
    const code = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!code || code.length > TOKEN_MAX || !SAFE_TOKEN.test(code)) return null;
    const state = url.searchParams.get('state');
    if (state !== null && (state.length > TOKEN_MAX || !SAFE_TOKEN.test(state))) {
      return null; // state presente mas fora do conjunto seguro → link inteiro cai
    }
    return { kind: 'auth', code, state };
  }

  return null;
}

/** Extrai um deep link do argv (Windows/Linux entregam por linha de comando). */
export function deepLinkFromArgv(argv: string[]): DeepLink | null {
  const arg = argv.find((a) => a.startsWith(`${SCHEME}://`));
  return arg ? parseDeepLink(arg) : null;
}

// ── Borda (electron) ─────────────────────────────────────────────────────────

/** `trusted` = veio de um gesto do usuário (abrir-com do Finder), não da web. */
type DeepLinkHandler = (link: DeepLink, trusted: boolean) => void;
let handler: DeepLinkHandler = defaultHandler;

function focusMainWindow(): BrowserWindow | undefined {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  return win;
}

/** Roteamento padrão: licença → billing; open → foca a janela e abre no app. */
function defaultHandler(link: DeepLink, trusted: boolean): void {
  const win = focusMainWindow();
  if (link.kind === 'license') {
    // Lazy require: billing-ipc importa electron; mantém deep-link testável.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const billing = require('./persistence/billing-ipc') as typeof import('./persistence/billing-ipc');
    const res = billing.applyLicenseToken(link.token);
    if (!res.ok) console.warn('[deep-link] licença inválida:', res.error);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BILLING_CHANNELS } = require('../shared/billing-types') as typeof import('../shared/billing-types');
    win?.webContents.send(BILLING_CHANNELS.changed);
  } else if (link.kind === 'open') {
    // SEGURANÇA: um deep link nexus://open pode ser disparado por QUALQUER site.
    // Abrir um diretório arbitrário como workspace expõe arquivos pelo file
    // explorer. Sem gesto confiável (abrir-com), exigimos confirmação nativa
    // (que o navegador não consegue forjar) mostrando o caminho exato.
    if (!trusted && !confirmOpenPath(link.path, win)) {
      console.warn('[deep-link] abertura recusada pelo usuário:', link.path);
      return;
    }
    try {
      const isDir = fs.statSync(link.path).isDirectory();
      win?.webContents.send('app:deepOpenPath', { path: link.path, isDir });
    } catch {
      console.warn('[deep-link] caminho inexistente:', link.path);
    }
  } else if (link.kind === 'auth') {
    // Login: valida o state contra o login pendente e troca o code de uso
    // único por tokens (Keychain) + licença.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { exchangeAuthCode } = require('./auth-client') as typeof import('./auth-client');
    void exchangeAuthCode(link.code, link.state).then((r) => {
      if (!r.ok) console.warn('[auth] exchange falhou:', r.error);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { BILLING_CHANNELS } = require('../shared/billing-types') as typeof import('../shared/billing-types');
      win?.webContents.send(BILLING_CHANNELS.changed);
    });
  }
}

/** Diálogo nativo (não-forjável) confirmando abertura de um caminho externo. */
function confirmOpenPath(target: string, win?: BrowserWindow): boolean {
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancelar', 'Abrir'],
    defaultId: 0,
    cancelId: 0,
    title: 'Abrir pasta externa?',
    message: 'Um link pediu para o NexusIDE abrir este caminho:',
    detail: `${target}\n\nAbra apenas se você reconhece e confia na origem.`,
    noLink: true,
  };
  const res = win
    ? dialog.showMessageBoxSync(win, opts)
    : dialog.showMessageBoxSync(opts);
  return res === 1;
}

/**
 * Registra o protocolo + eventos. Chame UMA vez no boot ANTES de app.whenReady
 * (o single-instance lock precisa ser adquirido cedo). Retorna false quando
 * outra instância já detém o lock (o chamador deve sair).
 */
export function wireDeepLinks(customHandler?: DeepLinkHandler): boolean {
  if (customHandler) handler = customHandler;

  if (process.defaultApp && process.argv.length >= 2) {
    // Dev: registra apontando para o script atual (`electron . nexus://…`).
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(SCHEME);
  }

  // Segunda instância (Windows/Linux): o deep link chega no argv dela; o lock
  // redireciona para a instância viva.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) return false;
  app.on('second-instance', (_e, argv) => {
    const link = deepLinkFromArgv(argv);
    if (link) handler(link, false); // veio de URL → não confiável
    focusMainWindow();
  });

  // macOS: deep link e abertura de documento chegam por evento (app já vivo).
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link) handler(link, false); // protocolo → pode vir da web
  });
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    // "Abrir com" no Finder é gesto do usuário → confiável.
    if (path.isAbsolute(filePath)) handler({ kind: 'open', path: filePath }, true);
  });

  return true;
}

/** Deep link que veio no argv do LANÇAMENTO a frio (processa após o boot). */
export function consumeLaunchDeepLink(): void {
  const link = deepLinkFromArgv(process.argv);
  if (link) handler(link, false); // argv de lançamento pode vir de URL
}
