import { app, autoUpdater, BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { UPDATE_CHANNELS, type UpdateState } from '../shared/update-ipc';
import {
  buildSquirrelFeed,
  isMacUpdatePlatform,
  parseGhRelease,
  type ParsedRelease,
} from './update-source';
import { validateUpdateFeedUrl } from './update-feed-policy';
import { createSingleFlight } from './single-flight';

/**
 * Auto-update com UI de verdade (fim do "às cegas"): o estado inteiro do
 * updater é transmitido ao renderer (badge na WorkspaceBar + modal), com
 * checagem no boot e a cada 6h.
 *
 * Duas fontes, em ordem:
 *  1. NEXUS_UPDATE_FEED — feed Squirrel direto (o caminho do SaaS futuro).
 *  2. `gh` CLI — o repo é PRIVADO, então feed público não existe e token
 *     embutido vazaria; o gh autenticado da máquina checa o último release e
 *     baixa o zip. O zip baixado é servido num feed Squirrel em 127.0.0.1
 *     para o Squirrel.Mac validar a assinatura e fazer o swap seguro + relaunch
 *     (nunca troque o .app na mão).
 *
 * Toda borda tem deadline (disciplina do pipeline de voz): gh check 15s,
 * download 10min. Dev (não empacotado) checa mas não instala.
 */

const REPO = 'cleofasvolarehost/nexus-ide';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BOOT_CHECK_DELAY_MS = 20_000;
const GH_CHECK_TIMEOUT_MS = 15_000;
const GH_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

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

class UpdateManager {
  private state: UpdateState;
  private release: ParsedRelease | null = null;
  private server: http.Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private squirrelWired = false;
  /** 'feed' = NEXUS_UPDATE_FEED direto; 'gh' = release privado via gh. */
  private mode: 'feed' | 'gh' | 'none' = 'none';
  private readonly checkSingleFlight = createSingleFlight(() => this.performCheck());

  constructor(private readonly networkEnabled = true) {
    // Override dev-only para exercitar a UI ("finge" que a versão atual é
    // antiga) — nunca ativo empacotado.
    const fakeCurrent = !app.isPackaged
      ? process.env.NEXUS_UPDATE_FAKE_CURRENT?.trim()
      : undefined;
    this.state = {
      phase: 'idle',
      currentVersion: fakeCurrent || app.getVersion(),
      source: 'none',
      canInstall: app.isPackaged && isMacUpdatePlatform(process.platform),
    };
  }

  init(): void {
    this.registerIpcHandlers();
    if (!isMacUpdatePlatform(process.platform)) {
      this.patch({
        phase: 'unsupported',
        source: 'none',
        canInstall: false,
        error: undefined,
      });
      writeUpdateLog('info', 'init:unsupported-platform', {
        platform: process.platform,
        packaged: app.isPackaged,
        currentVersion: this.state.currentVersion,
      });
      return;
    }
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

    const rawFeed = process.env.NEXUS_UPDATE_FEED?.trim();
    const feed = validateUpdateFeedUrl(rawFeed);
    if (rawFeed && !feed) {
      console.warn('[updater] NEXUS_UPDATE_FEED rejeitado: origem/HTTPS inválidos');
    }
    if (feed && app.isPackaged) {
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
      // Checagem de fundo: só quando não há nada em andamento/pronto.
      if (['idle', 'uptodate', 'error', 'available'].includes(this.state.phase)) {
        void this.check();
      }
    };
    setTimeout(scheduled, BOOT_CHECK_DELAY_MS).unref?.();
    this.timer = setInterval(scheduled, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private registerIpcHandlers(): void {
    ipcMain.handle(UPDATE_CHANNELS.getState, () => this.getState());
    ipcMain.handle(UPDATE_CHANNELS.check, async () => {
      await this.check();
      return this.getState();
    });
    ipcMain.handle(UPDATE_CHANNELS.install, async () => {
      await this.install();
      return this.getState();
    });
    ipcMain.handle(UPDATE_CHANNELS.restart, () => {
      if (this.state.phase === 'ready') autoUpdater.quitAndInstall();
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

  private check(): Promise<void> {
    return this.checkSingleFlight();
  }

  private async performCheck(): Promise<void> {
    if (!this.networkEnabled) return;
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
    this.patch({ phase: 'checking', error: undefined });
    try {
      const raw = await ghExec(
        [
          'release',
          'view',
          '--repo',
          REPO,
          '--json',
          'tagName,publishedAt,assets,body',
        ],
        GH_CHECK_TIMEOUT_MS,
      );
      const release = parseGhRelease(raw, this.state.currentVersion);
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
      const message = err instanceof Error ? err.message : String(err);
      const missing = /ENOENT/.test(message);
      writeUpdateLog('warn', 'check:gh-failed', { message, missing });
      this.patch({
        phase: missing ? 'unsupported' : 'error',
        error: missing
          ? 'gh CLI não encontrado — atualização manual pelo DMG do release.'
          : `checagem falhou: ${message}`,
      });
    }
  }

  private async install(): Promise<void> {
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
    const release = this.release;
    writeUpdateLog('info', 'install:start', {
      tag: release.tag,
      zipAsset: release.zipAsset,
    });
    this.patch({ phase: 'downloading', error: undefined });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-update-'));
    try {
      await ghExec(
        [
          'release',
          'download',
          release.tag,
          '--repo',
          REPO,
          '--pattern',
          release.zipAsset,
          '--dir',
          dir,
          '--clobber',
        ],
        GH_DOWNLOAD_TIMEOUT_MS,
      );
      const zipPath = path.join(dir, release.zipAsset);
      if (!fs.existsSync(zipPath)) throw new Error('zip do release não veio');
      const feedUrl = await this.serveLocalFeed(release, zipPath);
      writeUpdateLog('info', 'install:local-feed-ready', { feedUrl });
      this.wireSquirrel();
      autoUpdater.setFeedURL({ url: feedUrl });
      autoUpdater.checkForUpdates(); // Squirrel valida assinatura + faz o swap
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeUpdateLog('warn', 'install:failed', { message });
      this.patch({ phase: 'error', error: `download falhou: ${message}` });
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
      this.patch({ phase: 'error', error: String(err.message ?? err).slice(0, 200) });
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
    autoUpdater.on('update-downloaded', (_e, _notes, name) => {
      writeUpdateLog('info', 'squirrel:update-downloaded', { name });
      this.patch({
        phase: 'ready',
        available: this.state.available ?? {
          version: String(name ?? '').replace(/^v/i, ''),
          tag: String(name ?? ''),
        },
      });
      void dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Reiniciar agora', 'Depois'],
          defaultId: 0,
          cancelId: 1,
          title: 'Atualização pronta',
          message: `NexusIDE ${name ?? ''} foi baixado.`,
          detail: 'Reinicie para aplicar a atualização.',
          noLink: true,
        })
        .then((res) => {
          if (res.response === 0) autoUpdater.quitAndInstall();
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
