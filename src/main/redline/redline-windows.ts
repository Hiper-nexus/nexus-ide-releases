/**
 * Nexus Redline no Windows — instalação do companheiro de bandeja.
 *
 * O NexusRedline.exe viaja dentro do Nexus (Resources/nexus-redline) e a
 * instalação copia o bundle para %LocalAppData%\NexusRedline (sem admin,
 * combinando com o Squirrel per-user). O autostart mora em
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run (valor NexusRedline);
 * o painel do próprio companheiro liga/desliga sem passar por aqui.
 *
 * Doutrina de segurança: nenhum shell, argv fixo, caminhos resolvidos em
 * código. Os únicos binários tocados são reg.exe/tasklist.exe/taskkill.exe
 * do System32. Toda execução vai pelo seam `WinDeps.execFile`, injetável
 * nos testes — nenhum teste encosta no registro real.
 */

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const REDLINE_WIN_EXE_NAME = 'NexusRedline.exe';
export const REDLINE_WIN_DIR_NAME = 'NexusRedline';
export const REDLINE_WIN_RUN_VALUE = 'NexusRedline';
export const REDLINE_WIN_RUN_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

export interface WinExecResult {
  stdout: string;
}

export interface WinDeps {
  platform?: NodeJS.Platform;
  /** %LOCALAPPDATA% efetivo (seam de teste). */
  localAppData?: string;
  /** Execução síncrona de binário do System32; lança quando exit != 0. */
  execFile?: (file: string, args: readonly string[]) => WinExecResult;
  /** Abertura destacada do companheiro instalado. */
  spawnDetached?: (target: string, args?: readonly string[]) => void;
  /** Caminho do exe embutido (seam de teste; null = ausente). */
  bundledExe?: string | null;
  /** Diretório de instalação (seam de teste). */
  installDir?: string;
}

function depsPlatform(deps?: WinDeps): NodeJS.Platform {
  return deps?.platform ?? process.platform;
}

export function defaultWindowsLocalAppData(): string {
  const fromEnv = process.env.LOCALAPPDATA;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return path.join(homedir(), 'AppData', 'Local');
}

/** Onde o exe embutido mora (pacote ou checkout de dev). */
export function resolveBundledRedlineExe(
  resourcesPath?: string,
  isPackaged = true,
  deps?: WinDeps,
): string | null {
  if (deps?.bundledExe !== undefined) return deps.bundledExe;
  const candidates = isPackaged
    ? [path.join(resourcesPath ?? '', 'nexus-redline', REDLINE_WIN_EXE_NAME)]
    : [
        path.resolve(
          __dirname,
          '../../resources/native/win32/nexus-redline',
          REDLINE_WIN_EXE_NAME,
        ),
        path.resolve(
          process.cwd(),
          'resources/native/win32/nexus-redline',
          REDLINE_WIN_EXE_NAME,
        ),
      ];
  return (
    candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
  );
}

/** %LocalAppData%\NexusRedline (onde a cópia instalada mora). */
export function resolveWindowsInstallDir(deps?: WinDeps): string {
  if (deps?.installDir) return deps.installDir;
  return path.join(
    deps?.localAppData ?? defaultWindowsLocalAppData(),
    REDLINE_WIN_DIR_NAME,
  );
}

/** Cópia instalada (o local onde o autostart aponta). */
export function resolveInstalledRedlineExe(deps?: WinDeps): string | null {
  const candidate = path.join(
    resolveWindowsInstallDir(deps),
    REDLINE_WIN_EXE_NAME,
  );
  return existsSync(candidate) ? candidate : null;
}

function defaultExecFile(
  file: string,
  args: readonly string[],
): WinExecResult {
  const stdout = execFileSync(file, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: typeof stdout === 'string' ? stdout : String(stdout) };
}

/** tasklist CSV sem header: `"NexusRedline.exe","1234",...`. */
export function parseTasklistCsv(stdout: string): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    const first = line.split(',')[0]?.replace(/^"|"$/g, '').trim() ?? '';
    if (first.toLowerCase() === REDLINE_WIN_EXE_NAME.toLowerCase()) {
      return true;
    }
  }
  return false;
}

export function isRedlineRunningWin(deps?: WinDeps): boolean {
  const exec = deps?.execFile ?? defaultExecFile;
  try {
    const { stdout } = exec('tasklist', [
      '/FI',
      `IMAGENAME eq ${REDLINE_WIN_EXE_NAME}`,
      '/FO',
      'CSV',
      '/NH',
    ]);
    return parseTasklistCsv(stdout);
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* relógio indisponível: segue sem esperar */
  }
}

/**
 * Espera o processo morrer (poll do tasklist). Sem isso o relançamento
 * perde a corrida do mutex single-instance e o operador fica sem nada
 * rodando — com toast de "aberto".
 */
export function waitForRedlineExit(
  deps?: WinDeps,
  timeoutMs = 4000,
): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isRedlineRunningWin(deps)) return true;
    sleepSync(200);
  }
  return !isRedlineRunningWin(deps);
}

export function stopRunningRedlineWin(deps?: WinDeps): void {
  if (!isRedlineRunningWin(deps)) return;
  const exec = deps?.execFile ?? defaultExecFile;
  try {
    exec('taskkill', ['/IM', REDLINE_WIN_EXE_NAME]);
  } catch {
    /* taskkill sem match sai != 0 — ok */
  }
  waitForRedlineExit(deps);
}

/**
 * Lê o autostart HKCU. True só quando o valor aponta exatamente para o
 * executável instalado (entre aspas, como o set grava).
 */
export function readWindowsAutostart(
  installedExe: string,
  deps?: WinDeps,
): boolean {
  const exec = deps?.execFile ?? defaultExecFile;
  try {
    const { stdout } = exec('reg', [
      'query',
      REDLINE_WIN_RUN_KEY,
      '/v',
      REDLINE_WIN_RUN_VALUE,
    ]);
    const wanted = `"${installedExe}"`.toLowerCase();
    return stdout
      .split(/\r?\n/)
      .some((line) => line.toLowerCase().includes(wanted));
  } catch {
    return false;
  }
}

export function setWindowsAutostart(
  on: boolean,
  installedExe: string,
  deps?: WinDeps,
): boolean {
  const exec = deps?.execFile ?? defaultExecFile;
  try {
    if (!on) {
      if (!readWindowsAutostart(installedExe, deps)) return true;
      exec('reg', [
        'delete',
        REDLINE_WIN_RUN_KEY,
        '/v',
        REDLINE_WIN_RUN_VALUE,
        '/f',
      ]);
      return true;
    }
    exec('reg', [
      'add',
      REDLINE_WIN_RUN_KEY,
      '/v',
      REDLINE_WIN_RUN_VALUE,
      '/t',
      'REG_SZ',
      '/d',
      `"${installedExe}"`,
      '/f',
    ]);
    return true;
  } catch {
    return false;
  }
}

/** True quando o instalado falta ou é um build diferente do embutido. */
export function redlineExeNeedsReplace(
  bundledExe: string,
  installedExe: string,
): boolean {
  try {
    if (!existsSync(bundledExe) || !existsSync(installedExe)) return true;
    const bundled = readFileSync(bundledExe);
    const installed = readFileSync(installedExe);
    return bundled.length !== installed.length || !bundled.equals(installed);
  } catch {
    return true;
  }
}

export interface RedlineWinInstallResult {
  ok: boolean;
  message: string;
}

function launchDetached(
  target: string,
  deps?: WinDeps,
  args: readonly string[] = [],
): void {
  if (deps?.spawnDetached) {
    deps.spawnDetached(target, args);
    return;
  }
  spawn(target, [...args], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Copia o bundle embutido para %LocalAppData%\NexusRedline e abre.
 * Substitui instalação anterior. Não mexe no autostart (o painel do
 * próprio companheiro oferece "Iniciar com o Windows").
 */
export function installRedlineWin(
  resourcesPath?: string,
  isPackaged = true,
  deps?: WinDeps,
): RedlineWinInstallResult {
  if (depsPlatform(deps) !== 'win32') {
    return { ok: false, message: 'O Redline de bandeja é exclusivo do Windows.' };
  }
  // Empacotado nunca instala de um checkout de dev — sem o bundle não há
  // instalação.
  const source = resolveBundledRedlineExe(resourcesPath, isPackaged, deps);
  if (!source) {
    return {
      ok: false,
      message: 'Companheiro não encontrado no pacote deste Nexus.',
    };
  }
  return installRedlineWinFrom(source, deps);
}

function installRedlineWinFrom(
  sourceExe: string,
  deps?: WinDeps,
): RedlineWinInstallResult {
  const destination = resolveWindowsInstallDir(deps);
  if (existsSync(destination)) {
    stopRunningRedlineWin(deps);
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
    // O bundle viaja como diretório (exe + provider-logos): copia tudo.
    mkdirSync(destination, { recursive: true });
    cpSync(path.dirname(sourceExe), destination, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      message: `Falha ao copiar para ${destination}: ${(error as Error).message}`,
    };
  }
  try {
    // --first-run: o Windows esconde ícones novos no overflow; o balão
    // aponta o operador para o ^ na primeira execução pós-instalação.
    launchDetached(path.join(destination, REDLINE_WIN_EXE_NAME), deps, [
      '--first-run',
    ]);
  } catch {
    /* instalação vale mesmo se o abrir falhar */
  }
  return {
    ok: true,
    message: 'Nexus Redline instalado na bandeja do Windows e aberto.',
  };
}

/**
 * Abre o instalado (ou o embutido). Para e espera o anterior (corrida do
 * mutex) e relança com --open-panel: "Abrir" mostra o painel, não só
 * garante o processo na bandeja.
 */
export function openRedlineWin(
  resourcesPath?: string,
  isPackaged = true,
  deps?: WinDeps,
): RedlineWinInstallResult {
  const installed = resolveInstalledRedlineExe(deps);
  const target =
    installed ?? resolveBundledRedlineExe(resourcesPath, isPackaged, deps);
  if (!target) {
    return { ok: false, message: 'Companheiro não encontrado.' };
  }
  try {
    stopRunningRedlineWin(deps);
    launchDetached(target, deps, ['--open-panel']);
    return { ok: true, message: 'Redline aberto.' };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/**
 * Depois de um update do Nexus: se o operador já instalou o companheiro,
 * substitui %LocalAppData%\NexusRedline pelo binário empacotado quando
 * diferem e garante que o processo está no ar. Não instala sem consentimento
 * nem mexe no autostart.
 */
export async function syncInstalledRedlineWin(
  resourcesPath?: string,
  isPackaged = true,
  deps?: WinDeps,
): Promise<void> {
  if (depsPlatform(deps) !== 'win32') return;
  const bundled = resolveBundledRedlineExe(resourcesPath, isPackaged, deps);
  const installed = resolveInstalledRedlineExe(deps);
  if (!bundled || !installed) return;
  if (redlineExeNeedsReplace(bundled, installed)) {
    installRedlineWin(resourcesPath, isPackaged, deps);
    return;
  }
  if (!isRedlineRunningWin(deps)) {
    try {
      launchDetached(installed, deps);
    } catch {
      /* best-effort */
    }
  }
}
