/**
 * Nexus Redline — instalação do app companheiro (menu bar no macOS,
 * bandeja no Windows).
 *
 * macOS: o .app viaja dentro do Nexus (Contents/Resources/nexus-redline).
 * Windows: o NexusRedline.exe viaja em Resources/nexus-redline e instala em
 * %LocalAppData%\NexusRedline (sem admin). Quem recusar a oferta instala depois
 * em Uso e cotas.
 *
 * Doutrina de segurança: nenhum shell, argv fixo, caminhos resolvidos em
 * código; a única escrita fora do userData é a cópia para o diretório de
 * instalação (/Applications no macOS, %LocalAppData%\NexusRedline no Windows)
 * e a chave de autostart HKCU — sempre por ação explícita do usuário,
 * confirmada em diálogo nativo. No Windows os únicos binários tocados são
 * reg.exe/tasklist.exe/taskkill.exe do System32, com argv fixo.
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { handleTrusted } from '../security/trusted-ipc';
import {
  REDLINE_IPC,
  type RedlineInstallStatus,
} from '../../shared/redline-types';
import {
  installRedlineWin,
  isRedlineRunningWin,
  openRedlineWin,
  resolveBundledRedlineExe,
  resolveInstalledRedlineExe,
  syncInstalledRedlineWin,
} from './redline-windows';

export const REDLINE_APP_NAME = 'Nexus Redline.app';
export const REDLINE_EXEC_NAME = 'NexusRedline';
export const REDLINE_MARKER = 'redline-offer.json';

/** Onde o .app embutido mora (pacote ou checkout de dev). */
export function resolveBundledRedlineApp(
  resourcesPath?: string,
  isPackaged = true,
): string | null {
  const candidates = isPackaged
    ? [path.join(resourcesPath ?? '', 'nexus-redline', REDLINE_APP_NAME)]
    : [
        path.resolve(__dirname, '../../resources/native/darwin/nexus-redline', REDLINE_APP_NAME),
        path.resolve(
          process.cwd(),
          'resources/native/darwin/nexus-redline',
          REDLINE_APP_NAME,
        ),
      ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/** Cópia instalada em /Applications (o local onde o login item funciona). */
export function resolveInstalledRedlineApp(): string | null {
  const candidate = path.join('/Applications', REDLINE_APP_NAME);
  return existsSync(candidate) ? candidate : null;
}

function isRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', REDLINE_EXEC_NAME], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function redlineExecPath(appPath: string): string {
  return path.join(appPath, 'Contents', 'MacOS', REDLINE_EXEC_NAME);
}

/** True when /Applications is missing or is a different build than the bundle. */
export function redlineAppNeedsReplace(
  bundledApp: string,
  installedApp: string,
): boolean {
  const bundledExec = redlineExecPath(bundledApp);
  const installedExec = redlineExecPath(installedApp);
  try {
    if (!existsSync(bundledExec) || !existsSync(installedExec)) return true;
    const bundled = readFileSync(bundledExec);
    const installed = readFileSync(installedExec);
    return bundled.length !== installed.length || !bundled.equals(installed);
  } catch {
    return true;
  }
}

function launchRedline(target: string): void {
  spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
}

async function stopRunningRedline(): Promise<void> {
  if (!isRunning()) return;
  try {
    execFileSync('pkill', ['-x', REDLINE_EXEC_NAME], { stdio: 'pipe' });
  } catch {
    /* pkill sem match sai != 0 — ok */
  }
  await wait(400);
}

export function redlineStatus(resourcesPath?: string): RedlineInstallStatus {
  if (process.platform === 'win32') {
    const bundledPath = resolveBundledRedlineExe(
      resourcesPath,
      app.isPackaged,
    );
    const installedPath = resolveInstalledRedlineExe();
    return {
      platform: process.platform,
      bundled: bundledPath !== null,
      ...(bundledPath ? { bundledPath } : {}),
      ...(installedPath ? { installedPath } : {}),
      running: isRedlineRunningWin(),
    };
  }
  const bundledPath = resolveBundledRedlineApp(resourcesPath, app.isPackaged);
  const installedPath = resolveInstalledRedlineApp();
  return {
    platform: process.platform,
    bundled: bundledPath !== null,
    ...(bundledPath ? { bundledPath } : {}),
    ...(installedPath ? { installedPath } : {}),
    running: isRunning(),
  };
}

export interface RedlineInstallResult {
  ok: boolean;
  message: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Copia o .app para /Applications e abre. Substitui instalação anterior. */
export async function installRedline(
  resourcesPath?: string,
): Promise<RedlineInstallResult> {
  if (process.platform === 'win32') {
    return installRedlineWin(resourcesPath, app.isPackaged);
  }
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'O Redline é exclusivo do macOS e do Windows.' };
  }
  const source = resolveBundledRedlineApp(resourcesPath, app.isPackaged);
  if (!source) {
    return { ok: false, message: 'Companheiro não encontrado no pacote deste Nexus.' };
  }
  const destination = path.join('/Applications', REDLINE_APP_NAME);

  // Instância anterior morre antes da substituição (rm de app rodando falha).
  if (existsSync(destination)) {
    await stopRunningRedline();
    try {
      rmSync(destination, { recursive: true, force: true });
    } catch (error) {
      return {
        ok: false,
        message: `Falha ao remover a instalação anterior: ${(error as Error).message}`,
      };
    }
  }
  try {
    cpSync(source, destination, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      message: `Falha ao copiar para /Applications: ${(error as Error).message}`,
    };
  }
  try {
    launchRedline(destination);
  } catch {
    /* instalação vale mesmo se o abrir falhar */
  }
  return { ok: true, message: 'Nexus Redline instalado em /Applications e aberto.' };
}

const INSTALL_DIALOG = {
  type: 'question' as const,
  buttons: ['Cancelar', 'Instalar na barra do menu'],
  defaultId: 1,
  cancelId: 0,
  title: 'Nexus Redline',
  message: 'Instalar o Nexus Redline em /Applications?',
  detail:
    'Copia o companheiro da barra de menu para /Applications e abre. ' +
    'Sem Keychain, sem rede própria. Os dados vêm do próprio Nexus.',
};

const WIN_INSTALL_DIALOG = {
  type: 'question' as const,
  buttons: ['Cancelar', 'Instalar na bandeja'],
  defaultId: 1,
  cancelId: 0,
  title: 'Nexus Redline',
  message: 'Instalar o Nexus Redline na bandeja do Windows?',
  detail:
    'Copia o companheiro para a sua pasta (%LocalAppData%\\NexusRedline, ' +
    'sem admin) e abre. Sem rede própria. Os dados vêm do próprio Nexus.',
};

const OFFER_DIALOG = {
  type: 'info' as const,
  buttons: ['Agora não', 'Instalar na barra do menu'],
  defaultId: 1,
  cancelId: 0,
  title: 'Nexus Redline',
  message: 'Mostrar as cotas das suas contas de IA no topo do Mac?',
  detail:
    'O Nexus Redline fica na barra de menu e mostra, por conta, a folga ' +
    'das janelas 5h e semanal — sem Keychain, sem rede própria. Os dados ' +
    'vêm do próprio Nexus. Você pode instalar depois em Uso e cotas.',
};

const WIN_OFFER_DIALOG = {
  type: 'info' as const,
  buttons: ['Agora não', 'Instalar na bandeja'],
  defaultId: 1,
  cancelId: 0,
  title: 'Nexus Redline',
  message: 'Mostrar as cotas das suas contas de IA na bandeja do Windows?',
  detail:
    'O Nexus Redline fica na bandeja e mostra, por conta, a folga ' +
    'das janelas 5h e semanal — sem rede própria. Os dados vêm do próprio ' +
    'Nexus. Você pode instalar depois em Uso e cotas.',
};

/** IPC de Settings: diálogo nativo obrigatório antes de escrever fora do userData. */
export async function confirmAndInstallRedline(
  resourcesPath?: string,
): Promise<RedlineInstallResult> {
  if (process.platform === 'win32') {
    const win =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    try {
      const { response } = win
        ? await dialog.showMessageBox(win, WIN_INSTALL_DIALOG)
        : await dialog.showMessageBox(WIN_INSTALL_DIALOG);
      if (response !== 1) {
        return { ok: false, message: 'Instalação cancelada.' };
      }
    } catch {
      return { ok: false, message: 'Instalação cancelada.' };
    }
    return installRedline(resourcesPath);
  }
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'O Redline é exclusivo do macOS e do Windows.' };
  }
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  try {
    const { response } = win
      ? await dialog.showMessageBox(win, INSTALL_DIALOG)
      : await dialog.showMessageBox(INSTALL_DIALOG);
    if (response !== 1) {
      return { ok: false, message: 'Instalação cancelada.' };
    }
  } catch {
    return { ok: false, message: 'Instalação cancelada.' };
  }
  return installRedline(resourcesPath);
}

export async function openRedline(): Promise<RedlineInstallResult> {
  if (process.platform === 'win32') {
    return openRedlineWin(process.resourcesPath, app.isPackaged);
  }
  const installed = resolveInstalledRedlineApp();
  const target = installed ?? resolveBundledRedlineApp(process.resourcesPath, app.isPackaged);
  if (!target) {
    return { ok: false, message: 'Companheiro não encontrado.' };
  }
  try {
    // `open` num LSUIElement já rodando não reconstruí o extra — o operador
    // clica "Abrir" justamente quando não vê a faixa (F-612).
    await stopRunningRedline();
    launchRedline(target);
    return { ok: true, message: 'Redline aberto.' };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/**
 * Depois de um update do Nexus: se o operador já instalou o companheiro,
 * substitui o instalado pelo binário empacotado quando diferem e garante
 * que o processo está no ar. Não instala sem consentimento.
 */
export async function syncInstalledRedline(
  resourcesPath?: string,
): Promise<void> {
  if (process.platform === 'win32') {
    await syncInstalledRedlineWin(resourcesPath, app.isPackaged);
    return;
  }
  if (process.platform !== 'darwin') return;
  const bundled = resolveBundledRedlineApp(resourcesPath, app.isPackaged);
  const installed = resolveInstalledRedlineApp();
  if (!bundled || !installed) return;
  if (redlineAppNeedsReplace(bundled, installed)) {
    await installRedline(resourcesPath);
    return;
  }
  if (!isRunning()) {
    launchRedline(installed);
  }
}

const ONE_TIME_COOLDOWN_MS = 0;

/**
 * Oferta one-time por instalação (marker em userData). Nunca lança.
 */
export async function maybeOfferRedlineInstall(
  userDataDir: string,
): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const markerPath = path.join(userDataDir, REDLINE_MARKER);
  try {
    if (existsSync(markerPath)) return;
  } catch {
    return;
  }
  const isWin = process.platform === 'win32';
  const bundled = isWin
    ? resolveBundledRedlineExe(process.resourcesPath, app.isPackaged)
    : resolveBundledRedlineApp(process.resourcesPath, app.isPackaged);
  const writeMarker = (accepted: boolean): void => {
    try {
      writeFileSync(
        markerPath,
        JSON.stringify({ offeredAt: Date.now(), accepted, bundled: bundled !== null }),
        { mode: 0o600 },
      );
    } catch {
      // Marker é conveniência; falha não pode quebrar o boot.
    }
  };
  const alreadyInstalled = isWin
    ? resolveInstalledRedlineExe()
    : resolveInstalledRedlineApp();
  if (!bundled || alreadyInstalled) {
    writeMarker(false);
    return;
  }

  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const offerDialog = isWin ? WIN_OFFER_DIALOG : OFFER_DIALOG;
  try {
    const { response } = win
      ? await dialog.showMessageBox(win, offerDialog)
      : await dialog.showMessageBox(offerDialog);
    const accepted = response === 1;
    writeMarker(accepted);
    if (accepted) {
      const result = await installRedline();
      if (!result.ok) {
        console.warn('[redline] instalação pós-oferta falhou:', result.message);
      }
    }
  } catch {
    // Diálogo cancelado/indisponível: sem marker para oferecer de novo depois.
  }
}

export function initRedlineIpc(): void {
  handleTrusted(REDLINE_IPC.status, () => redlineStatus(process.resourcesPath));
  handleTrusted(REDLINE_IPC.install, () =>
    confirmAndInstallRedline(process.resourcesPath),
  );
  handleTrusted(REDLINE_IPC.open, () => openRedline());
}

export function shutdownRedlineIpc(): void {
  ipcMain.removeHandler(REDLINE_IPC.status);
  ipcMain.removeHandler(REDLINE_IPC.install);
  ipcMain.removeHandler(REDLINE_IPC.open);
}

// Cooldown exportado para testes futuros de repetição da oferta.
export const REDLINE_OFFER_COOLDOWN_MS = ONE_TIME_COOLDOWN_MS;
