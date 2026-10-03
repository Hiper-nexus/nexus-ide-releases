import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron';
import {
  BUSY_BANNER_SMOKE_CHANNELS, BUSY_BANNER_SMOKE_ENV, BUSY_BANNER_SMOKE_FILE, BUSY_BANNER_SMOKE_TIMEOUT_MS,
  parseBusyBannerSmokeReady, parseBusyBannerSmokeResult, type BusyBannerSmokeResult,
} from '../../shared/busy-banner-smoke';
import { induceSmokeMainHang, SMOKE_HANG_PROBE_BLOCK_MS } from './smoke-hang-probe';

export function isSmokeBusyBannerProbeRequested(input: {
  smokeTest: boolean; env: NodeJS.ProcessEnv; userDataPath: string;
}): boolean {
  const profile = input.env.NEXUS_USER_DATA_DIR;
  return input.smokeTest && input.env[BUSY_BANNER_SMOKE_ENV] === '1' && input.env.NEXUS_PACKAGED_SMOKE === '1' &&
    typeof profile === 'string' && path.isAbsolute(profile) && profile === input.userDataPath &&
    input.env.HOME === path.join(profile, 'home');
}

export interface BusyBannerSmokeEpisode { nonce: string; startedAt: number; recoveredAt: number }
export function validateBusyBannerEpisode(episode: BusyBannerSmokeEpisode, raw: unknown): BusyBannerSmokeResult {
  const result = parseBusyBannerSmokeResult(raw);
  if (!result || result.nonce !== episode.nonce || episode.recoveredAt - episode.startedAt < SMOKE_HANG_PROBE_BLOCK_MS ||
      result.armedAt > episode.startedAt || result.shownAt < episode.startedAt || result.visibleAt >= episode.recoveredAt ||
      result.clearedAt < episode.recoveredAt) throw new Error('busy banner evidence does not match the real forty-second Main hang');
  return result;
}

/** Only the mounted main frame in the private smoke profile can start the hang. */
export async function proveMountedBusyBannerForSmoke(win: BrowserWindow, input: {
  ipc: IpcMain; userData: string; appVersion: string; packaged: boolean; smokeTest: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = input.env ?? process.env;
  if (!isSmokeBusyBannerProbeRequested({ smokeTest: input.smokeTest, env, userDataPath: input.userData })) {
    throw new Error('busy banner probe requires explicit smoke mode and a private profile');
  }
  for (const directory of [input.userData, path.join(input.userData, 'home')]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory ||
        (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' && stat.uid !== process.getuid())))) {
      throw new Error('busy banner probe profile lost its private ownership');
    }
  }
  const wc = win.webContents;
  const mainFrame = wc.mainFrame;
  const nonce = randomUUID();
  const sentAt = Date.now();
  const episode = await new Promise<{ main: BusyBannerSmokeEpisode; renderer: BusyBannerSmokeResult }>((resolve, reject) => {
    let main: BusyBannerSmokeEpisode | null = null;
    let started = false;
    const authorized = (event: IpcMainEvent): boolean => event.sender === wc && event.senderFrame === mainFrame && wc.mainFrame === mainFrame;
    const cleanup = (): void => {
      clearTimeout(timer);
      input.ipc.removeListener(BUSY_BANNER_SMOKE_CHANNELS.ready, onReady);
      input.ipc.removeListener(BUSY_BANNER_SMOKE_CHANNELS.result, onResult);
      win.removeListener('closed', onClosed);
    };
    const fail = (message: string): void => { cleanup(); reject(new Error(message)); };
    const onClosed = (): void => fail('busy banner probe window closed');
    const onReady = (event: IpcMainEvent, raw: unknown): void => {
      if (!authorized(event) || started) return;
      const ready = parseBusyBannerSmokeReady(raw);
      if (!ready || ready.nonce !== nonce || ready.armedAt < sentAt || ready.armedAt > Date.now()) {
        fail('busy banner probe invalid renderer readiness'); return;
      }
      started = true;
      const startedAt = Date.now();
      console.log(`[smoke] busy-banner: blocking mounted Main for ${SMOKE_HANG_PROBE_BLOCK_MS} ms`);
      try { induceSmokeMainHang(); }
      catch { fail('busy banner probe could not induce the Main hang'); return; }
      main = { nonce, startedAt, recoveredAt: Date.now() };
      console.log('[smoke] busy-banner: Main recovered; waiting for banner to clear');
    };
    const onResult = (event: IpcMainEvent, raw: unknown): void => {
      if (!authorized(event)) return;
      if (!main) { fail('busy banner evidence arrived before the Main hang'); return; }
      try {
        const renderer = validateBusyBannerEpisode(main, raw);
        if (renderer.clearedAt > Date.now()) throw new Error('future renderer evidence');
        cleanup(); resolve({ main, renderer });
      } catch { fail('busy banner probe invalid renderer evidence'); }
    };
    const timer = setTimeout(() => fail('busy banner Main probe timed out'), BUSY_BANNER_SMOKE_TIMEOUT_MS + 5_000);
    input.ipc.on(BUSY_BANNER_SMOKE_CHANNELS.ready, onReady);
    input.ipc.on(BUSY_BANNER_SMOKE_CHANNELS.result, onResult);
    win.once('closed', onClosed);
    wc.send(BUSY_BANNER_SMOKE_CHANNELS.run, { nonce });
  });
  const logsDir = path.join(input.userData, 'logs');
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(logsDir, BUSY_BANNER_SMOKE_FILE);
  const temporaryReceipt = path.join(logsDir, `.${BUSY_BANNER_SMOKE_FILE}.${nonce}`);
  await fs.writeFile(temporaryReceipt, JSON.stringify({
    schema: 'nexus.busy-banner-smoke/v1', pid: process.pid,
    appVersion: input.appVersion, packaged: input.packaged, ...episode,
  }) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temporaryReceipt, receiptPath);
  console.log('[smoke] busy-banner: visible frames and automatic recovery proven');
}
