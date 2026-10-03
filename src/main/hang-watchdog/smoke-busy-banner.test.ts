import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUSY_BANNER_SMOKE_CHANNELS } from '../../shared/busy-banner-smoke';
import { isSmokeBusyBannerProbeRequested, proveMountedBusyBannerForSmoke, validateBusyBannerEpisode } from './smoke-busy-banner';

// A real 40s stall belongs to the signed acceptance run. Here a deterministic
// clock advance tests the IPC authority and ordering without blocking the suite.
vi.mock('./smoke-hang-probe', async importOriginal => ({
  ...await importOriginal<typeof import('./smoke-hang-probe')>(),
  induceSmokeMainHang: () => { vi.setSystemTime(Date.now() + 40_000); return 1; },
}));
const profiles: string[] = [];
afterEach(async () => { vi.useRealTimers(); while (profiles.length) await fs.rm(profiles.pop()!, { recursive: true, force: true }); });

const env = {
  NEXUS_SMOKE_BUSY_BANNER_PROBE: '1', NEXUS_PACKAGED_SMOKE: '1',
  NEXUS_USER_DATA_DIR: '/private/smoke', HOME: '/private/smoke/home',
};
const nonce = '11111111-1111-4111-8111-111111111111';
const renderer = {
  nonce, armedAt: 100, shownAt: 11_000, visibleAt: 11_016, clearedAt: 40_200,
  title: 'Nexus ocupado — capturando diagnóstico',
  rect: { x: 30, y: 8, width: 480, height: 28, viewportWidth: 1000, viewportHeight: 700 },
};

describe('mounted busy banner smoke authority', () => {
  it('requires explicit smoke mode and a separately confined profile and HOME', () => {
    expect(isSmokeBusyBannerProbeRequested({ smokeTest: true, env, userDataPath: '/private/smoke' })).toBe(true);
    for (const input of [
      { smokeTest: false, env, userDataPath: '/private/smoke' },
      { smokeTest: true, env: { ...env, NEXUS_PACKAGED_SMOKE: undefined }, userDataPath: '/private/smoke' },
      { smokeTest: true, env: { ...env, NEXUS_SMOKE_BUSY_BANNER_PROBE: undefined }, userDataPath: '/private/smoke' },
      { smokeTest: true, env: { ...env, HOME: '/operator' }, userDataPath: '/private/smoke' },
      { smokeTest: true, env, userDataPath: '/operator' },
    ]) expect(isSmokeBusyBannerProbeRequested(input)).toBe(false);
  });

  it('accepts a real forty-second episode containing the banner onset and recovery', () => {
    expect(validateBusyBannerEpisode({ nonce, startedAt: 200, recoveredAt: 40_200 }, renderer)).toEqual(renderer);
  });

  it.each([
    { startedAt: 1000, recoveredAt: 6000 },
    { startedAt: 12_000, recoveredAt: 52_000 },
    { startedAt: 200, recoveredAt: 10_000 },
    { nonce: '22222222-2222-4222-8222-222222222222' },
  ])('refuses unrelated or premature DOM evidence %j', patch => {
    expect(() => validateBusyBannerEpisode({ nonce, startedAt: 200, recoveredAt: 40_200, ...patch }, renderer)).toThrow();
  });

  it('only lets the mounted main frame trigger once and persists the matching receipt', async () => {
    const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-busy-main-test-')));
    profiles.push(profile);
    await fs.mkdir(path.join(profile, 'home'), { mode: 0o700 });
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const ipc = new EventEmitter();
    const mainFrame = {};
    let deliver!: (payload: { nonce: string }) => void;
    const requested = new Promise<{ nonce: string }>(resolve => { deliver = resolve; });
    const wc = { mainFrame, send: (_channel: string, payload: { nonce: string }) => deliver(payload) };
    const win = Object.assign(new EventEmitter(), { webContents: wc });
    const pending = proveMountedBusyBannerForSmoke(win as unknown as BrowserWindow, {
      ipc: ipc as IpcMain, userData: profile, appVersion: '0.76.191', packaged: true, smokeTest: true,
      env: { ...env, NEXUS_USER_DATA_DIR: profile, HOME: path.join(profile, 'home') },
    });
    const request = await requested;
    const payload = { nonce: request.nonce, armedAt: 1000 };
    ipc.emit(BUSY_BANNER_SMOKE_CHANNELS.ready, { sender: {}, senderFrame: mainFrame }, payload);
    ipc.emit(BUSY_BANNER_SMOKE_CHANNELS.ready, { sender: wc, senderFrame: {} }, payload);
    expect(Date.now()).toBe(1000);
    const event = { sender: wc, senderFrame: mainFrame };
    ipc.emit(BUSY_BANNER_SMOKE_CHANNELS.ready, event, payload);
    ipc.emit(BUSY_BANNER_SMOKE_CHANNELS.ready, event, payload);
    expect(Date.now()).toBe(41_000);
    vi.setSystemTime(41_100);
    ipc.emit(BUSY_BANNER_SMOKE_CHANNELS.result, event, {
      ...renderer, nonce: request.nonce, armedAt: 1000, shownAt: 12_000, visibleAt: 12_016, clearedAt: 41_100,
    });
    await pending;
    const receipt = JSON.parse(await fs.readFile(path.join(profile, 'logs', 'busy-banner-smoke.json'), 'utf8'));
    expect(receipt).toMatchObject({ schema: 'nexus.busy-banner-smoke/v1', main: { startedAt: 1000, recoveredAt: 41_000 }, renderer: { clearedAt: 41_100 } });
    expect(ipc.eventNames()).toEqual([]);
    expect(win.eventNames()).toEqual([]);
  });
});
