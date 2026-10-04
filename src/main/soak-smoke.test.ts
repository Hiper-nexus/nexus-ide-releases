import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { isSoakSmokeRequested, proveSoakForSmoke } from './soak-smoke';
import { SOAK_CHANNELS, SOAK_ENV } from '../shared/soak-smoke';
import { soakCycle as cycle } from '../shared/__tests__/soak-fixture';
import { FUNCTIONAL_SMOKE_REQUIRED_PROBES, FUNCTIONAL_SMOKE_MIN_ADAPTERS, FUNCTIONAL_SMOKE_MIN_TOOLS } from '../shared/smoke-types';
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
const profile = '/tmp/soak-fixture';
const env = { NEXUS_PACKAGED_SMOKE: '1', NEXUS_USER_DATA_DIR: profile, HOME: `${profile}/home`, [SOAK_ENV]: '1' };
it('only allows explicit packaged smoke in its exact private HOME/userData', () => {
  expect(isSoakSmokeRequested({ smokeTest: true, packaged: true, env, userData: profile })).toBe(true);
  for (const input of [{ smokeTest: false }, { packaged: false }, { env: { ...env, HOME: '/operator' } }, { env: { ...env, [SOAK_ENV]: '0' } }, { userData: '/other' }]) {
    expect(isSoakSmokeRequested({ smokeTest: true, packaged: true, env, userData: profile, ...input })).toBe(false);
  }
});
it('cancellation drains the sole pending collector and owned PTY before settling', async () => {
  const userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-soak-unit-'))); directories.push(userData);
  await fs.mkdir(path.join(userData, 'home'), { mode: 0o700 });
  const ipc = new EventEmitter(), win = new EventEmitter();
  const frame = {}; const sent: Array<[string, unknown]> = [];
  const wc = Object.assign(new EventEmitter(), { mainFrame: frame, getOSProcessId: () => 1234, send: (channel: string, data: unknown) => { sent.push([channel, data]); } });
  Object.assign(win, { webContents: wc });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const stop = vi.fn(async () => true), collect = vi.fn(async () => { await pending; throw new Error('cancelled sample'); });
  const physicalShutdown = vi.fn();
  const controller = new AbortController();
  const flight = proveSoakForSmoke(win as never, { ipc: ipc as never, userData, appVersion: '0.76.192', packaged: true, smokeTest: true,
    workspacePath: `${userData}/functional-smoke-workspace`, env: { ...env, NEXUS_USER_DATA_DIR: userData, HOME: `${userData}/home` }, signal: controller.signal, requestPhysicalShutdown: physicalShutdown },
    { collect, terminate: stop, owned: () => true, cwd: () => `${userData}/functional-smoke-workspace` });
  await vi.waitFor(() => expect(sent.length).toBe(1));
  const run = sent[0]![1] as { nonce: string };
  ipc.emit(SOAK_CHANNELS.cycle, { sender: {}, senderFrame: frame }, { ...cycle(), nonce: run.nonce });
  expect(collect).not.toHaveBeenCalled();
  ipc.emit(SOAK_CHANNELS.cycle, { sender: wc, senderFrame: {} }, { ...cycle(), nonce: run.nonce });
  expect(collect).not.toHaveBeenCalled();
  ipc.emit(SOAK_CHANNELS.cycle, { sender: wc, senderFrame: frame }, { ...cycle(), nonce: run.nonce });
  await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce());
  const outcome = flight.catch(error => error); let settled = false; void outcome.then(() => { settled = true; });
  controller.abort(); await Promise.resolve(); expect(settled).toBe(false); expect(stop).not.toHaveBeenCalled();
  expect(physicalShutdown).toHaveBeenCalledOnce();
  // Main enters its sealed FAIL shutdown even when the renderer never ACKs.
  // A native render crash also unblocks its stopped handshake, preserving the
  // collector/physical drain rather than declaring a fabricated successful close.
  wc.emit('render-process-gone');
  release(); ipc.emit(SOAK_CHANNELS.stopped, { sender: wc, senderFrame: frame }, { nonce: run.nonce, sessionIds: ['pty-fixture'] });
  expect(await outcome).toBeInstanceOf(Error);
  expect(stop).toHaveBeenCalledExactlyOnceWith('pty-fixture');
  expect(ipc.listenerCount(SOAK_CHANNELS.cycle)).toBe(0);
  await expect(fs.stat(path.join(userData, 'logs', 'soak-smoke.json'))).rejects.toThrow();
});
it('Main measures monotonic activity and writes acceptance only after all physical closes and final functional probes', async () => {
  const userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-soak-clock-unit-'))); directories.push(userData);
  await fs.mkdir(path.join(userData, 'home'), { mode: 0o700 });
  const ipc = new EventEmitter(), win = new EventEmitter(), frame = {};
  const sent: Array<[string, any]> = [];
  const wc = Object.assign(new EventEmitter(), { mainFrame: frame, getOSProcessId: () => 1234, send: (channel: string, data: unknown) => { sent.push([channel, data]); } });
  Object.assign(win, { webContents: wc }); let clock = 1;
  const terminate = vi.fn(async () => true);
  const perf = { process: { pid: process.pid, heapUsedBytes: 32000000, rssBytes: 160000000 },
    appMetrics: [{ pid: 1234, type: 'Tab', memory: { workingSetSize: 180000 } }],
    panes: { livePtySessions: 1, footprints: [{ sessionId: 'pty-fixture', rootPid: 9000, processCount: 1, rssBytes: 12000000 }] } };
  const flight = proveSoakForSmoke(win as never, { ipc: ipc as never, userData, appVersion: '0.76.192', packaged: true, smokeTest: true,
    workspacePath: `${userData}/functional-smoke-workspace`, env: { ...env, NEXUS_USER_DATA_DIR: userData, HOME: `${userData}/home` }, signal: new AbortController().signal },
    { collect: async () => perf as never, terminate, owned: () => true, cwd: () => `${userData}/functional-smoke-workspace`, now: () => clock });
  await vi.waitFor(() => expect(sent[0]?.[0]).toBe(SOAK_CHANNELS.run));
  const nonce = sent[0]![1].nonce;
  for (let sequence = 0; sequence < 61; sequence++) {
    clock = sequence * 5000 + 500;
    ipc.emit(SOAK_CHANNELS.cycle, { sender: wc, senderFrame: frame }, { ...cycle(), nonce, sequence });
    await vi.waitFor(() => expect(sent.some(v => v[0] === SOAK_CHANNELS.ack && v[1].sequence === sequence)).toBe(true));
  }
  expect(terminate).toHaveBeenCalledTimes(61);
  await expect(fs.stat(path.join(userData, 'logs', 'soak-smoke.json'))).rejects.toThrow();
  expect(sent.at(-1)![1].done).toBe(true);
  clock += 1000;
  ipc.emit(SOAK_CHANNELS.done, { sender: wc, senderFrame: frame }, { nonce, result: { ok: true, probes: [...FUNCTIONAL_SMOKE_REQUIRED_PROBES], adapterCount: FUNCTIONAL_SMOKE_MIN_ADAPTERS, toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS } });
  await flight;
  const receipt = JSON.parse(await fs.readFile(path.join(userData, 'logs', 'soak-smoke.json'), 'utf8'));
  expect(receipt.durationMs).toBeGreaterThanOrEqual(300000); expect(receipt.samples.length).toBe(61);
  expect(receipt.samples[0].memoryBytes.rendererHeap).toBe(32000 * 1024);
  expect(receipt.samples[0].memoryBytes.rendererRss).toBe(180000 * 1024);
  expect(receipt.finalFunctional.ok).toBe(true);
});
