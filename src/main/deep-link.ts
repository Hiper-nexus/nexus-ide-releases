import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

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
  | { kind: 'open'; path: string };

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

  return null;
}

/** Extrai um deep link do argv (Windows/Linux entregam por linha de comando). */
export function deepLinkFromArgv(argv: string[]): DeepLink | null {
  const arg = argv.find((a) => a.startsWith(`${SCHEME}://`));
  return arg ? parseDeepLink(arg) : null;
}

// ── Borda (electron) ─────────────────────────────────────────────────────────

type DeepLinkHandler = (link: DeepLink) => void;
let handler: DeepLinkHandler = defaultHandler;

/** Roteamento padrão: licença → billing; open → foca a janela e abre no app. */
function defaultHandler(link: DeepLink): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
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
    try {
      const isDir = fs.statSync(link.path).isDirectory();
      win?.webContents.send('app:deepOpenPath', { path: link.path, isDir });
    } catch {
      console.warn('[deep-link] caminho inexistente:', link.path);
    }
  }
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
    if (link) handler(link);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // macOS: deep link e abertura de documento chegam por evento (app já vivo).
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link) handler(link);
  });
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (path.isAbsolute(filePath)) handler({ kind: 'open', path: filePath });
  });

  return true;
}

/** Deep link que veio no argv do LANÇAMENTO a frio (processa após o boot). */
export function consumeLaunchDeepLink(): void {
  const link = deepLinkFromArgv(process.argv);
  if (link) handler(link);
}
