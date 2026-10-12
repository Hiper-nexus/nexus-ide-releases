import { randomUUID } from 'node:crypto';
import { runPeriodicTask, stopPeriodicTask } from './observability/periodic-task';
import { app, autoUpdater, BrowserWindow } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { UPDATE_CHANNELS, type UpdateState } from '../shared/update-ipc';
import { handleTrusted } from './security/trusted-ipc';
import {
  buildSquirrelFeed,
  isMacUpdatePlatform,
  parseGhReleases,
  type ParsedRelease,
  LINUX_DOWNLOAD_URL,
  LINUX_UPDATE_COMMAND,
  linuxPackageUpdateCommand,
  parseLinuxReleases,
} from './update-source';
import { validateUpdateFeedUrl } from './update-feed-policy';
import {
  CANONICAL_RELEASE_REPO,
  CANONICAL_RELEASE_REPOS,
  githubReleasesApiUrl,
  PUBLIC_RELEASES_REPOS,
} from './update-repos';
import { createSingleFlight } from './single-flight';
import {
  cleanupStaleStaging,
  detectLinuxInstall,
  launchApplyHelper,
  scheduleOldInstallCleanup,
  stageLinuxUpdate,
  UpdateRefused,
  type LinuxInstall,
  type StagedUpdate,
} from './linux-self-update';

/**
 * Auto-update com UI de verdade (fim do "às cegas"): o estado inteiro do
 * updater é transmitido ao renderer (badge na WorkspaceBar + modal), com
 * checagem no boot e a cada 6h.
 *
 * Três fontes, em ordem:
 *  1. NEXUS_UPDATE_FEED — feed Squirrel direto (o caminho do SaaS futuro).
 *  2. `gh` CLI no canônico `Hiper-nexus/nexus-ide`, com fallback no slug
 *     legado `cleofasvolarehost/nexus-ide` (redirect pós-transferência).
 *  3. API REST anônima do espelho público `Hiper-nexus/nexus-ide-releases`,
 *     com o mesmo fallback no slug legado. Sem gh no PATH (app aberto pelo
 *     Finder) este é o caminho real.
 *
 * Toda borda tem deadline (disciplina do pipeline de voz): gh check 15s,
 * download 10min. Dev (não empacotado) checa mas não instala.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BOOT_CHECK_DELAY_MS = 3_000;
const FRESH_CHECK_MS = 60_000;
const AUTO_INSTALL_RETRY_MS = 6 * 60 * 60 * 1000;
const WINDOWS_SQUIRREL_FIRST_RUN_DELAY_MS = 10_000;
const GH_CHECK_TIMEOUT_MS = 15_000;
const GH_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const GH_RELEASES_PER_PAGE = 100;

type UpdateLogLevel = 'info' | 'warn';

export interface AutoUpdaterInitOptions {
  /** Keep the IPC contract but skip every external update operation. */
  networkEnabled?: boolean;
}

function formatLogDetail(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) return detail.message;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function writeUpdateLog(
  level: UpdateLogLevel,
  message: string,
  detail?: unknown,
): void {
  const renderedDetail = formatLogDetail(detail);
  const consoleArgs = renderedDetail
    ? [`[updater] ${message}`, detail]
    : [`[updater] ${message}`];
  if (level === 'warn') {
    console.warn(...consoleArgs);
  } else {
    console.info(...consoleArgs);
  }

  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'update.log'),
      `${new Date().toISOString()} ${level.toUpperCase()} ${message}${
        renderedDetail ? ` ${renderedDetail}` : ''
      }\n`,
      'utf8',
    );
  } catch (err) {
    console.warn('[updater] falha ao gravar log:', err);
  }
}

function summarizeState(state: UpdateState): Record<string, unknown> {
  return {
    phase: state.phase,
    source: state.source,
    currentVersion: state.currentVersion,
    availableVersion: state.available?.version,
    canInstall: state.canInstall,
    error: state.error,
  };
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    wc.send(channel, payload);
  }
}

function ghExec(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
          reject(new Error(detail || 'gh falhou'));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

type GhExecutor = (args: string[], timeoutMs: number) => Promise<string>;

function githubMovedPermanentlyUrl(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; url?: unknown };
    if (
      parsed.message === 'Moved Permanently' &&
      typeof parsed.url === 'string' &&
      parsed.url.startsWith('https://api.github.com/')
    ) {
      return parsed.url;
    }
  } catch {
    return null;
  }
  return null;
}

/** GET anônimo de um arquivo pequeno (somas e assinatura) com deadline e teto de tamanho. */
async function fetchPublicText(url: string, timeoutMs: number, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'NexusIDE-updater' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`download público: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('arquivo maior que o esperado');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('arquivo maior que o esperado');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * F-1279: 403/429 com a cota anônima esgotada (mesma cota por IP para todos os slugs) não diz nada
 * sobre os releases. A checagem para aí e a UI mantém o que já mostrava.
 */
class PublicApiRateLimited extends Error {}

/** GET anônimo na API pública com deadline (mesma disciplina do gh). */
async function fetchPublicJson(
  url: string,
  timeoutMs: number,
  hop = 0,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'NexusIDE-updater',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const moved = hop < 2 ? githubMovedPermanentlyUrl(text) : null;
    if (moved && moved !== url) {
      return fetchPublicJson(moved, timeoutMs, hop + 1);
    }
    if (
      (response.status === 403 || response.status === 429) &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))
    ) {
      throw new PublicApiRateLimited(`releases públicos: HTTP ${response.status} (limite da API do GitHub)`);
    }
    if (!response.ok) {
      throw new Error(`releases públicos: HTTP ${response.status}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Janela sem NENHUM byte novo que caracteriza rede travada (não wall-clock). */
export const DOWNLOAD_STALL_MS = 90_000;

export interface DownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes?: number;
}

/**
 * Baixa um asset público (redirects seguidos pelo fetch) em stream p/ disco.
 *
 * Robustez 0.32.25 (a noite do print: "baixando…" pendurado por horas sem
 * erro): conta bytes e reporta progresso, e arma um watchdog de STALL que
 * aborta quando a rede para de entregar — timer rearmado a cada chunk, então
 * mede progresso, não tempo de parede. O deadline total continua valendo.
 */
export async function downloadPublicAsset(
  url: string,
  destination: string,
  timeoutMs: number,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  // F-1280: só existe arquivo no destino quando o download terminou inteiro.
  const partial = `${destination}.part`;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let receivedBytes = 0;
  let abortedByStall = false;
  const armStallWatchdog = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortedByStall = true;
      controller.abort();
    }, DOWNLOAD_STALL_MS);
  };
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'NexusIDE-updater' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`download público: HTTP ${response.status}`);
    }
    const totalHeader = response.headers.get('content-length');
    const totalBytes = totalHeader ? Number(totalHeader) : undefined;
    const { Readable, Transform } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const counter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        receivedBytes += chunk.length;
        armStallWatchdog();
        try {
          onProgress?.({
            receivedBytes,
            ...(Number.isFinite(totalBytes) ? { totalBytes } : {}),
          });
        } catch {
          // progresso é best-effort
        }
        callback(null, chunk);
      },
    });
    armStallWatchdog();
    await pipeline(
      Readable.fromWeb(response.body as import('stream/web').ReadableStream),
      counter,
      fs.createWriteStream(partial),
    );
    await fs.promises.rename(partial, destination);
  } catch (err) {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    if (abortedByStall) {
      throw new Error(
        `download travou: sem byte novo por ${Math.round(DOWNLOAD_STALL_MS / 1000)}s ` +
          `(${receivedBytes} bytes recebidos) — rede instável`,
      );
    }
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    clearTimeout(deadline);
  }
}

/** Costuras do auto-update do Linux portátil; os testes trocam por falsos. */
export interface LinuxSelfUpdateDependencies {
  detect: (execPath: string) => LinuxInstall;
  stage: typeof stageLinuxUpdate;
  launch: typeof launchApplyHelper;
  quit: () => void;
}

export interface UpdateManagerDependencies {
  linuxSelfUpdate?: Partial<LinuxSelfUpdateDependencies>;
  runGh?: GhExecutor;
  runtimeArch?: string;
  runtimePlatform?: string;
  runtimeArgs?: readonly string[];
  appExecutablePath?: string;
  pathExists?: (candidate: string) => boolean;
}

function officialWindowsUpdateFeed(version: string): string {
  return `https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/${version}`;
}

export class UpdateManager {
  private readonly periodicId = `app-update-check:${randomUUID()}`;
  private stopped = false;
  private bootCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private onFocus: (() => void) | null = null;
  private state: UpdateState;
  private release: ParsedRelease | null = null;
  /** De onde veio o release ofertado: gh (repo privado) ou espelho público. */
  /** Slug que respondeu na última checagem (org nova ou redirect legado). */
  private releaseRepo: string = CANONICAL_RELEASE_REPO;
  private server: http.Server | null = null;
  /** Diretório nexus-update-* da instalação em curso (o ZIP servido pelo feed local). */
  private updateDir: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private squirrelWired = false;
  private autoInstallAttempt: { version: string; at: number } | null = null;
  private readonly runGh: GhExecutor;
  private readonly runtimeArch: string;
  private readonly runtimePlatform: string;
  private readonly runtimeArgs: readonly string[];
  private readonly isInstalledWindowsTarget: boolean;
  private readonly firstRunCheckDeadline: number | null;
  private firstRunCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 'feed' = NEXUS_UPDATE_FEED direto; 'gh' = release privado via gh;
   * 'manual' = Linux (DEB/RPM): só consulta o espelho público e avisa (F-751).
   * 'linux-self' = Linux portátil (ZIP do install.sh): baixa, confere a assinatura e se troca sozinho.
   */
  private mode: 'feed' | 'gh' | 'manual' | 'linux-self' | 'none' = 'none';
  private linuxInstall: Extract<LinuxInstall, { kind: 'portable' }> | null = null;
  private linuxStaged: StagedUpdate | null = null;
  private readonly linuxSelf: LinuxSelfUpdateDependencies;
  private readonly checkSingleFlight = createSingleFlight(() => this.performCheck());

  constructor(
    private readonly networkEnabled = true,
    dependencies: UpdateManagerDependencies = {},
  ) {
    this.runGh = dependencies.runGh ?? ghExec;
    this.runtimeArch = dependencies.runtimeArch ?? process.arch;
    this.runtimePlatform = dependencies.runtimePlatform ?? process.platform;
    this.runtimeArgs = dependencies.runtimeArgs ?? process.argv;
    this.linuxSelf = {
      detect: dependencies.linuxSelfUpdate?.detect ?? detectLinuxInstall,
      stage: dependencies.linuxSelfUpdate?.stage ?? stageLinuxUpdate,
      launch: dependencies.linuxSelfUpdate?.launch ?? launchApplyHelper,
      quit: dependencies.linuxSelfUpdate?.quit ?? (() => app.quit()),
    };
    const isPackagedWindowsX64 =
      app.isPackaged &&
      this.runtimePlatform === 'win32' &&
      this.runtimeArch === 'x64';
    if (isPackagedWindowsX64) {
      const pathExists = dependencies.pathExists ?? fs.existsSync;
      const appExecutablePath =
        dependencies.appExecutablePath ?? app.getPath('exe');
      const windowsUpdateExecutable = path.win32.resolve(
        path.win32.dirname(appExecutablePath),
        '..',
        'Update.exe',
      );
      this.isInstalledWindowsTarget = pathExists(windowsUpdateExecutable);
    } else {
      this.isInstalledWindowsTarget = false;
    }
    this.firstRunCheckDeadline =
      this.isInstalledWindowsTarget &&
      this.runtimeArgs.includes('--squirrel-firstrun')
        ? Date.now() + WINDOWS_SQUIRREL_FIRST_RUN_DELAY_MS
        : null;
    // Override dev-only para exercitar a UI ("finge" que a versão atual é
    // antiga) — nunca ativo empacotado.
    const fakeCurrent = !app.isPackaged
      ? process.env.NEXUS_UPDATE_FAKE_CURRENT?.trim()
      : undefined;
    this.state = {
      phase: 'idle',
      currentVersion: fakeCurrent || app.getVersion(),
      source: 'none',
      canInstall:
        app.isPackaged &&
        (isMacUpdatePlatform(this.runtimePlatform) || this.isInstalledWindowsTarget),
    };
  }

  init(): void {
    this.registerIpcHandlers();
    // Smoke and other explicitly offline boots must stay self-contained. Check
    // this before validating a Windows Squirrel layout: Forge's direct package
    // output intentionally has no Update.exe, and labelling that test package
    // as a damaged user installation is both wrong and alarming.
    if (!this.networkEnabled) {
      this.patch({
        phase: 'unsupported',
        source: 'none',
        canInstall: false,
        error: undefined,
      });
      writeUpdateLog('info', 'init:offline', {
        packaged: app.isPackaged,
        currentVersion: this.state.currentVersion,
      });
      return;
    }
    const isWindows = this.runtimePlatform === 'win32';
    // Linux x64 empacotado: não há auto-update, mas o app avisa da versão nova
    // e entrega o comando. Antes isto caía em "Plataforma sem atualização
    // automática: linux." em vermelho, com um "Verificar agora" que não
    // verificava nada, e ninguém ficava sabendo que havia versão nova (F-751).
    const isLinuxManual =
      this.runtimePlatform === 'linux' && this.runtimeArch === 'x64' && app.isPackaged;
    if (isLinuxManual) {
      const install = this.linuxSelf.detect(app.getPath('exe'));
      if (install.kind === 'portable') {
        // Pacote portátil (Arch, Omarchy): o app se atualiza sozinho, com assinatura conferida.
        this.mode = 'linux-self';
        this.linuxInstall = install;
        this.patch({ phase: 'idle', source: 'gh', canInstall: true, error: undefined, installerPlatform: 'linux' });
        scheduleOldInstallCleanup(install);
        void cleanupStaleStaging(install).then((removed) => {
          if (removed.length) writeUpdateLog('info', 'init:linux-stale-staging-removed', { count: removed.length });
        });
        writeUpdateLog('info', 'init:linux-self', { installDir: install.installDir });
      } else {
        this.mode = 'manual';
        this.patch({
          phase: 'idle',
          source: 'manual',
          canInstall: false,
          error: undefined,
          installerPlatform: 'linux',
          manual: { command: linuxPackageUpdateCommand(), downloadUrl: LINUX_DOWNLOAD_URL },
        });
        writeUpdateLog('info', 'init:linux-manual', { reason: install.reason });
      }
    }
    if (
      !isLinuxManual &&
      !isMacUpdatePlatform(this.runtimePlatform) &&
      !this.isInstalledWindowsTarget
    ) {
      const error = isWindows
        ? !app.isPackaged
          ? 'Atualizações automáticas exigem o NexusIDE instalado pelo Setup.exe.'
          : this.runtimeArch !== 'x64'
            ? `Arquitetura Windows sem atualização automática: ${this.runtimeArch}.`
            : 'Instalação Squirrel incompleta: Update.exe não foi encontrado.'
        : `Plataforma sem atualização automática: ${this.runtimePlatform}.`;
      this.patch({
        phase: 'unsupported',
        source: 'none',
        canInstall: false,
        error,
      });
      writeUpdateLog('info', 'init:unsupported-platform', {
        platform: this.runtimePlatform,
        packaged: app.isPackaged,
        currentVersion: this.state.currentVersion,
      });
      return;
    }

    const rawFeed = isLinuxManual ? undefined : process.env.NEXUS_UPDATE_FEED?.trim();
    const defaultWindowsFeed = this.isInstalledWindowsTarget
      ? officialWindowsUpdateFeed(this.state.currentVersion)
      : undefined;
    const feed = validateUpdateFeedUrl(rawFeed || defaultWindowsFeed);
    if (rawFeed && !feed) {
      console.warn('[updater] NEXUS_UPDATE_FEED rejeitado: origem/HTTPS inválidos');
      if (this.isInstalledWindowsTarget) {
        this.patch({
          phase: 'error',
          source: 'none',
          canInstall: false,
          error: 'Feed de atualização inválido.',
        });
        return;
      }
    }
    if (isLinuxManual) {
      // Modo já definido acima; nada de feed nem de gh.
    } else if (feed && app.isPackaged) {
      this.mode = 'feed';
      this.patch({ source: 'feed' });
      try {
        autoUpdater.setFeedURL({ url: feed });
        this.wireSquirrel();
      } catch (err) {
        console.warn('[updater] setFeedURL falhou:', err);
        this.patch({ phase: 'error', error: 'feed inválido' });
      }
    } else {
      // Sem feed: o gh decide na primeira checagem se a fonte existe.
      this.mode = 'gh';
      this.patch({ source: 'gh' });
    }
    writeUpdateLog('info', 'init', {
      mode: this.mode,
      packaged: app.isPackaged,
      currentVersion: this.state.currentVersion,
      canInstall: this.state.canInstall,
    });

    const scheduled = () => {
      if (this.stopped) return;
      // Checagem de fundo: só quando não há nada em andamento/pronto.
      if (['idle', 'uptodate', 'error', 'available'].includes(this.state.phase)) {
        void this.backgroundCheck();
      }
    };
    if (!this.deferUntilWindowsFirstRunDeadline()) {
      this.bootCheckTimer = setTimeout(scheduled, BOOT_CHECK_DELAY_MS);
      this.bootCheckTimer.unref?.();
    }
    this.timer = setInterval(scheduled, CHECK_INTERVAL_MS);
    this.timer.unref?.();

    const onFocus = () => {
      if (
        !this.state.checkedAt ||
        Date.now() - this.state.checkedAt > 15 * 60 * 1000
      ) {
        scheduled();
      }
    };
    this.onFocus = onFocus;
    app.on('browser-window-focus', onFocus);
  }

  private registerIpcHandlers(): void {
    handleTrusted(UPDATE_CHANNELS.getState, () => this.getState());
    handleTrusted(UPDATE_CHANNELS.check, async () => {
      await this.check();
      return this.getState();
    });
    handleTrusted(UPDATE_CHANNELS.install, async () => {
      await this.install();
      return this.getState();
    });
    handleTrusted(UPDATE_CHANNELS.restart, () => {
      if (this.state.phase !== 'ready') return;
      if (this.mode === 'linux-self') {
        this.restartLinuxSelf();
        return;
      }
      autoUpdater.quitAndInstall();
    });
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  private patch(patch: Partial<UpdateState>): void {
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    if (
      previous.phase !== this.state.phase ||
      previous.source !== this.state.source ||
      previous.available?.version !== this.state.available?.version ||
      previous.error !== this.state.error
    ) {
      writeUpdateLog(
        this.state.phase === 'error' ? 'warn' : 'info',
        'state',
        summarizeState(this.state),
      );
    }
    broadcast(UPDATE_CHANNELS.state, this.getState());
  }

  /**
   * F-1012: a 0.76.208 viu a 0.76.210 às 08:32 e ficou 7 h em `available`
   * esperando um clique que o operador não deu. A checagem de fundo (boot,
   * relógio e foco) já baixa a versão nova sozinha; o Squirrel aplica no
   * próximo reinício e o banner passa a pedir só "Reiniciar". A checagem pedida
   * pela UI continua só avisando. Uma falha não rebaixa os mesmos 240 MB a cada
   * foco: a mesma versão só tenta de novo depois de AUTO_INSTALL_RETRY_MS.
   */
  private async backgroundCheck(): Promise<void> {
    // F-1182: no boot o chip do renderer checa ao montar e o relógio de 3 s
    // checaria de novo logo depois. Resultado fresco basta; install() revalida.
    const checkedAt = this.state.checkedAt;
    if (!checkedAt || Date.now() - checkedAt >= FRESH_CHECK_MS) await this.check();
    const version = this.state.available?.version;
    if (this.mode !== 'gh' || this.state.phase !== 'available' || !this.state.canInstall || !version) return;
    const last = this.autoInstallAttempt;
    if (last?.version === version && Date.now() - last.at < AUTO_INSTALL_RETRY_MS) return;
    this.autoInstallAttempt = { version, at: Date.now() };
    writeUpdateLog('info', 'install:auto', { version });
    await this.install();
  }

  private check(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return runPeriodicTask(this.periodicId, ctx => ctx.wait(this.checkSingleFlight()),
      { cadenceMs: CHECK_INTERVAL_MS, timeoutMs: 60_000 }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.bootCheckTimer) clearTimeout(this.bootCheckTimer);
    if (this.firstRunCheckTimer) clearTimeout(this.firstRunCheckTimer);
    if (this.onFocus) app.removeListener('browser-window-focus', this.onFocus);
    this.releaseLocalFeed();
    await stopPeriodicTask(this.periodicId);
  }

  /** F-1280: o ZIP (~240 MB) e o feed local só servem até o Squirrel terminar ou falhar. */
  private releaseLocalFeed(): void {
    this.server?.close();
    this.server = null;
    const dir = this.updateDir;
    this.updateDir = null;
    if (!dir) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      writeUpdateLog('warn', 'install:cleanup-failed', err);
    }
  }

  private deferUntilWindowsFirstRunDeadline(): boolean {
    if (this.firstRunCheckDeadline === null) return false;
    const remainingMs = this.firstRunCheckDeadline - Date.now();
    if (remainingMs <= 0) return false;
    if (!this.firstRunCheckTimer) {
      this.firstRunCheckTimer = setTimeout(() => {
        this.firstRunCheckTimer = null;
        void this.check();
      }, remainingMs);
      this.firstRunCheckTimer.unref?.();
    }
    return true;
  }

  private async performCheck(): Promise<void> {
    if (!this.networkEnabled) return;
    if (this.mode === 'none') return;
    if (this.deferUntilWindowsFirstRunDeadline()) return;
    if (this.state.phase === 'downloading' || this.state.phase === 'ready') return;
    writeUpdateLog('info', 'check:start', {
      mode: this.mode,
      currentVersion: this.state.currentVersion,
    });
    if (this.mode === 'feed') {
      // Squirrel direto: os eventos do autoUpdater dirigem o estado.
      this.patch({ phase: 'checking', error: undefined });
      try {
        autoUpdater.checkForUpdates();
      } catch (err) {
        writeUpdateLog('warn', 'check:feed-failed', err);
        this.patch({ phase: 'error', error: String(err).slice(0, 200) });
      }
      return;
    }
    if (this.mode === 'manual' || this.mode === 'linux-self') {
      await this.performManualCheck();
      return;
    }
    const before = { phase: this.state.phase, error: this.state.error };
    this.patch({ phase: 'checking', error: undefined });
    try {
      const raw = await this.loadReleaseJson();
      const release = parseGhReleases(
        raw,
        this.state.currentVersion,
        this.runtimeArch,
        this.runtimePlatform,
      );
      this.release = release;
      if (release) {
        writeUpdateLog('info', 'check:available', {
          currentVersion: this.state.currentVersion,
          availableVersion: release.version,
          tag: release.tag,
          zipAsset: release.zipAsset,
        });
        this.patch({
          phase: 'available',
          available: {
            version: release.version,
            tag: release.tag,
            publishedAt: release.publishedAt,
            notes: release.notes,
          },
          checkedAt: Date.now(),
        });
      } else {
        writeUpdateLog('info', 'check:uptodate', {
          currentVersion: this.state.currentVersion,
        });
        this.patch({
          phase: 'uptodate',
          available: undefined,
          checkedAt: Date.now(),
        });
      }
    } catch (err) {
      if (this.keepStateWhenRateLimited(err, before)) return;
      const message = err instanceof Error ? err.message : String(err);
      const missing = /ENOENT/.test(message);
      writeUpdateLog('warn', 'check:gh-failed', { message, missing });
      // F-1278: a tentativa também conta como checagem; sem checkedAt cada foco refazia gh + fetch.
      this.patch({
        phase: missing ? 'unsupported' : 'error',
        error: missing
          ? 'gh CLI não encontrado — atualização manual pelo DMG do release.'
          : `checagem falhou: ${message}`,
        checkedAt: Date.now(),
      });
    }
  }

  /**
   * Linux: consulta só o espelho PÚBLICO (anônimo, sem gh) e avisa. Nunca
   * baixa nem instala: quem atualiza é o operador, com o comando do estado.
   */
  private async performManualCheck(): Promise<void> {
    const before = { phase: this.state.phase, error: this.state.error };
    this.patch({ phase: 'checking', error: undefined });
    try {
      const raw = await this.loadPublicReleaseJson();
      const available = parseLinuxReleases(raw, this.state.currentVersion, this.runtimeArch);
      if (this.mode === 'linux-self' && this.state.phase !== 'ready') this.linuxStaged = null;
      if (available) {
        writeUpdateLog('info', 'check:available', {
          currentVersion: this.state.currentVersion,
          availableVersion: available.version,
          tag: available.tag,
          manual: true,
        });
        this.patch({ phase: 'available', available, checkedAt: Date.now() });
      } else {
        writeUpdateLog('info', 'check:uptodate', {
          currentVersion: this.state.currentVersion,
          manual: true,
        });
        this.patch({ phase: 'uptodate', available: undefined, checkedAt: Date.now() });
      }
    } catch (err) {
      if (this.keepStateWhenRateLimited(err, before)) return;
      const message = err instanceof Error ? err.message : String(err);
      writeUpdateLog('warn', 'check:public-failed', { message });
      this.patch({ phase: 'error', error: `checagem falhou: ${message.slice(0, 160)}`, checkedAt: Date.now() });
    }
  }

  /** F-1279: limite da API não é falha de atualização; volta ao que a UI mostrava e conta como checagem. */
  private keepStateWhenRateLimited(err: unknown, before: Pick<UpdateState, 'phase' | 'error'>): boolean {
    if (!(err instanceof PublicApiRateLimited)) return false;
    writeUpdateLog('warn', 'check:rate-limited', { message: err.message });
    this.patch({ ...before, checkedAt: Date.now() });
    return true;
  }

  /**
   * Linux portátil: baixa o ZIP, confere a assinatura das somas e o SHA-256, extrai ao lado da instalação
   * e fica `ready` até o operador reiniciar. Qualquer falha deixa a instalação atual intacta e devolve o
   * comando manual na mensagem.
   */
  private async installLinuxSelf(): Promise<void> {
    const install = this.linuxInstall;
    const retrying = this.state.phase === 'error' && Boolean(this.state.available);
    if (!install || (this.state.phase !== 'available' && !retrying) || !this.state.available) return;
    // A oferta pode ter ficado aberta por horas (ou a tentativa anterior falhou): revalida antes de baixar 240 MB.
    await this.check();
    const available = this.state.available;
    if (this.state.phase !== 'available' || !available) return;
    writeUpdateLog('info', 'install:linux-start', { tag: available.tag });
    this.patch({ phase: 'downloading', error: undefined, downloadProgress: undefined });
    let lastEmittedBytes = -1;
    try {
      const staged = await this.linuxSelf.stage({
        install,
        currentVersion: this.state.currentVersion,
        release: { version: available.version, tag: available.tag },
        repos: PUBLIC_RELEASES_REPOS,
        deps: {
          fetchText: (url, maxBytes) => fetchPublicText(url, GH_CHECK_TIMEOUT_MS, maxBytes),
          download: (url, destination, onProgress) =>
            downloadPublicAsset(url, destination, GH_DOWNLOAD_TIMEOUT_MS, (progress) =>
              onProgress?.(progress.receivedBytes, progress.totalBytes),
            ),
          onProgress: (receivedBytes, totalBytes) => {
            const shouldEmit =
              receivedBytes - lastEmittedBytes >= 8 * 1024 * 1024 ||
              (totalBytes !== undefined && receivedBytes === totalBytes);
            if (!shouldEmit) return;
            lastEmittedBytes = receivedBytes;
            this.patch({
              phase: 'downloading',
              downloadProgress: { receivedBytes, ...(totalBytes !== undefined ? { totalBytes } : {}) },
            });
          },
          log: (event, detail) => writeUpdateLog('info', `install:linux:${event}`, detail),
        },
      });
      this.linuxStaged = staged;
      writeUpdateLog('info', 'install:linux-ready', { version: staged.version, keyId: staged.keyId });
      this.patch({ phase: 'ready', downloadProgress: undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeUpdateLog('warn', 'install:linux-failed', { message });
      this.patch({
        phase: 'error',
        downloadProgress: undefined,
        error:
          (err instanceof UpdateRefused ? `atualização recusada: ${message}` : `download falhou: ${message}`).slice(0, 160) +
          ` — rode no terminal: ${LINUX_UPDATE_COMMAND}`,
      });
    }
  }

  /** Reinício do Linux portátil: um script solto troca a pasta depois que o app sai e reabre o novo. */
  private restartLinuxSelf(): void {
    const install = this.linuxInstall;
    const staged = this.linuxStaged;
    if (!install || !staged || !fs.existsSync(path.join(staged.stagedDir, 'nexus-ide'))) {
      this.patch({ phase: 'error', error: `a atualização baixada sumiu — rode no terminal: ${LINUX_UPDATE_COMMAND}` });
      return;
    }
    try {
      this.linuxSelf.launch({
        scriptPath: path.join(app.getPath('userData'), 'linux-apply-update.sh'),
        pid: process.pid,
        install,
        deps: {
          writeScript: (scriptPath, content) => {
            fs.writeFileSync(scriptPath, content, { mode: 0o700 });
            fs.chmodSync(scriptPath, 0o700);
          },
          spawnDetached: (command, args) => {
            const child = spawn(command, args, { detached: true, stdio: 'ignore' });
            child.unref();
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeUpdateLog('warn', 'restart:linux-failed', { message });
      this.patch({ phase: 'error', error: `não consegui reiniciar: ${message.slice(0, 120)}` });
      return;
    }
    writeUpdateLog('info', 'restart:linux-apply', { version: staged.version });
    this.linuxSelf.quit();
  }

  private async loadPublicReleaseJson(): Promise<string> {
    const errors: string[] = [];
    for (const repo of PUBLIC_RELEASES_REPOS) {
      try {
        const raw = await fetchPublicJson(githubReleasesApiUrl(repo), GH_CHECK_TIMEOUT_MS);
        this.releaseRepo = repo;
        return raw;
      } catch (err) {
        if (err instanceof PublicApiRateLimited) throw err;
        errors.push(`${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(errors[0] ?? 'nenhuma fonte de release');
  }

  private async loadReleaseJson(): Promise<string> {
    const ghErrors: string[] = [];
    for (const repo of CANONICAL_RELEASE_REPOS) {
      try {
        const raw = await this.runGh(
          [
            'api',
            '--method',
            'GET',
            `repos/${repo}/releases?per_page=${GH_RELEASES_PER_PAGE}`,
          ],
          GH_CHECK_TIMEOUT_MS,
        );
        this.releaseRepo = repo;
        return raw;
      } catch (ghErr) {
        ghErrors.push(
          `${repo}: ${ghErr instanceof Error ? ghErr.message : String(ghErr)}`,
        );
      }
    }
    writeUpdateLog('info', 'check:gh-unavailable-try-public', {
      message: ghErrors.join('; '),
    });
    const publicErrors: string[] = [];
    for (const repo of PUBLIC_RELEASES_REPOS) {
      try {
        const raw = await fetchPublicJson(
          githubReleasesApiUrl(repo),
          GH_CHECK_TIMEOUT_MS,
        );
        this.releaseRepo = repo;
        return raw;
      } catch (pubErr) {
        if (pubErr instanceof PublicApiRateLimited) throw pubErr;
        publicErrors.push(
          `${repo}: ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`,
        );
      }
    }
    throw new Error(
      publicErrors[0] ?? ghErrors[0] ?? 'nenhuma fonte de release',
    );
  }

  /**
   * Download do zip com progresso visível e tolerância a rede instável
   * (0.32.25): tenta primeiro o fetch público do espelho (conta bytes,
   * watchdog de stall, progresso na UI), cai para o gh autenticado e ainda
   * tem uma segunda tentativa completa antes de errar.
   */
  private async downloadWithProgress(
    release: ParsedRelease,
    dir: string,
  ): Promise<void> {
    const destination = path.join(dir, release.zipAsset);
    const publicUrls = [
      ...(release.zipDownloadUrl ? [release.zipDownloadUrl] : []),
      ...PUBLIC_RELEASES_REPOS.map(
        (repo) =>
          `https://github.com/${repo}/releases/download/${release.tag}/${release.zipAsset}`,
      ),
    ];
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      for (const url of publicUrls) {
        try {
          let lastEmittedBytes = -1;
          await downloadPublicAsset(
            url,
            destination,
            GH_DOWNLOAD_TIMEOUT_MS,
            (progress) => {
              // Throttle: patch a cada 8 MiB (ou quando o total chega).
              const shouldEmit =
                progress.receivedBytes - lastEmittedBytes >= 8 * 1024 * 1024 ||
                (progress.totalBytes !== undefined &&
                  progress.receivedBytes === progress.totalBytes);
              if (!shouldEmit) return;
              lastEmittedBytes = progress.receivedBytes;
              this.patch({
                phase: 'downloading',
                downloadProgress: { ...progress },
              });
            },
          );
          return;
        } catch (err) {
          lastError = err;
          writeUpdateLog('warn', 'install:download-source-failed', {
            url,
            attempt,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Fonte gh autenticada (canônico privado): sem progresso, mas cobre o
      // caso do espelho inacessível.
      try {
        this.patch({ phase: 'downloading', downloadProgress: undefined });
        await this.downloadGhZip(release, dir);
        return;
      } catch (err) {
        lastError = err;
        writeUpdateLog('warn', 'install:download-gh-failed', {
          attempt,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? 'download falhou'));
  }

  private async downloadGhZip(release: ParsedRelease, dir: string): Promise<void> {    const repos = [
      this.releaseRepo,
      ...CANONICAL_RELEASE_REPOS.filter((repo) => repo !== this.releaseRepo),
    ];
    let lastError: unknown;
    for (const repo of repos) {
      try {
        await this.runGh(
          [
            'release',
            'download',
            release.tag,
            '--repo',
            repo,
            '--pattern',
            release.zipAsset,
            '--dir',
            dir,
            '--clobber',
          ],
          GH_DOWNLOAD_TIMEOUT_MS,
        );
        this.releaseRepo = repo;
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async install(): Promise<void> {
    // Linux (DEB/RPM): a atualização é feita pelo operador (comando do estado `manual`).
    if (this.mode === 'manual') return;
    if (this.mode === 'linux-self') {
      await this.installLinuxSelf();
      return;
    }
    if (this.state.phase !== 'available' || !this.release) return;
    if (!this.state.canInstall) {
      writeUpdateLog('warn', 'install:blocked-dev-build');
      this.patch({
        phase: 'available',
        error: 'Build de desenvolvimento — instale pelo app empacotado.',
      });
      return;
    }
    if (this.mode === 'feed') return; // no modo feed o Squirrel baixa sozinho

    // A oferta pode ter ficado aberta por horas enquanto um release mais novo
    // foi publicado. Revalida imediatamente antes do download para evitar uma
    // cadeia 0.15 → 0.16.1 → 0.16.4 em duas instalações.
    writeUpdateLog('info', 'install:refresh-latest');
    await this.check();
    if (this.state.phase !== 'available' || !this.release) {
      writeUpdateLog(
        'warn',
        'install:refresh-blocked',
        summarizeState(this.state),
      );
      return;
    }

    const release = this.release;
    writeUpdateLog('info', 'install:start', {
      tag: release.tag,
      zipAsset: release.zipAsset,
    });
    this.patch({
      phase: 'downloading',
      error: undefined,
      downloadProgress: undefined,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-update-'));
    this.updateDir = dir;
    try {
      await this.downloadWithProgress(release, dir);
      const zipPath = path.join(dir, release.zipAsset);
      if (!fs.existsSync(zipPath)) throw new Error('zip do release não veio');
      this.patch({ downloadProgress: undefined });
      const feedUrl = await this.serveLocalFeed(release, zipPath);
      writeUpdateLog('info', 'install:local-feed-ready', { feedUrl });
      this.wireSquirrel();
      autoUpdater.setFeedURL({ url: feedUrl });
      autoUpdater.checkForUpdates(); // Squirrel valida assinatura + faz o swap
    } catch (err) {
      this.releaseLocalFeed();
      const message = err instanceof Error ? err.message : String(err);
      writeUpdateLog('warn', 'install:failed', { message });
      this.patch({
        phase: 'error',
        error: `download falhou: ${message}`,
        downloadProgress: undefined,
      });
    }
  }

  /** Serve feed.json + zip em 127.0.0.1 para o Squirrel consumir localmente. */
  private serveLocalFeed(release: ParsedRelease, zipPath: string): Promise<string> {
    this.server?.close();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/feed.json')) {
          const port = (server.address() as { port: number }).port;
          const body = buildSquirrelFeed(
            release,
            `http://127.0.0.1:${port}/update.zip`,
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(body);
          return;
        }
        if (req.url?.startsWith('/update.zip')) {
          const stat = fs.statSync(zipPath);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': stat.size,
          });
          fs.createReadStream(zipPath).pipe(res);
          return;
        }
        res.writeHead(404).end();
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        const { port } = server.address() as { port: number };
        writeUpdateLog('info', 'local-feed:listening', { port });
        resolve(`http://127.0.0.1:${port}/feed.json`);
      });
    });
  }

  private wireSquirrel(): void {
    if (this.squirrelWired) return;
    this.squirrelWired = true;
    autoUpdater.on('error', (err) => {
      writeUpdateLog('warn', 'squirrel:error', err);
      this.releaseLocalFeed();
      const raw = String(err?.message ?? err);
      // A feed can legitimately return 404 while the public mirror has no
      // Windows asset for this channel yet. Treat that as a quiet "no update"
      // result instead of surfacing a scary red error to every installed user.
      // Any other transport/signature failure remains fail-visible below.
      if (/\b404\b|not found|não localizado/i.test(raw)) {
        writeUpdateLog('info', 'squirrel:feed-empty', { status: 404 });
        this.patch({
          phase: 'uptodate',
          available: undefined,
          error: undefined,
          checkedAt: Date.now(),
        });
        return;
      }
      const error = raw.includes('Could not get code signature')
        ? 'O app atual foi aberto fora de /Applications ou a partir de build sem assinatura Developer ID. Instale o .dmg oficial para atualizar.'
        : raw.slice(0, 200);
      this.patch({ phase: 'error', error });
    });
    autoUpdater.on('update-available', () => {
      writeUpdateLog('info', 'squirrel:update-available', { mode: this.mode });
      // No modo gh isto é o Squirrel puxando do feed local (download começou).
      if (this.mode === 'feed') this.patch({ phase: 'downloading' });
    });
    autoUpdater.on('update-not-available', () => {
      writeUpdateLog('info', 'squirrel:update-not-available', { mode: this.mode });
      if (this.mode === 'feed') {
        this.patch({ phase: 'uptodate', checkedAt: Date.now() });
      }
    });
    // F-1181: sem diálogo nativo aqui. Sem janela-mãe, o showMessageBox do
    // macOS é um NSAlert runModal que prende a main thread até o clique; com o
    // download de fundo do F-1012 a 0.76.233 ficou 4,9 h parada de madrugada.
    // O banner "Atualização pronta" do renderer já oferece "Reiniciar agora".
    autoUpdater.on('update-downloaded', (_e, _notes, name) => {
      writeUpdateLog('info', 'squirrel:update-downloaded', { name });
      // O Squirrel já copiou e validou o ZIP no cache dele; o nosso e o feed local sobram.
      this.releaseLocalFeed();
      this.patch({
        phase: 'ready',
        available: this.state.available ?? {
          version: String(name ?? '').replace(/^v/i, ''),
          tag: String(name ?? ''),
        },
      });
    });
  }
}

let manager: UpdateManager | null = null;

/** Chamado no bootstrap do main (depois da janela existir). Idempotente. */
export function initAutoUpdater(options: AutoUpdaterInitOptions = {}): void {
  if (manager) return;
  manager = new UpdateManager(options.networkEnabled ?? true);
  manager.init();
}

export async function stopAutoUpdater(): Promise<void> {
  const current = manager;
  manager = null;
  await current?.stop();
}
