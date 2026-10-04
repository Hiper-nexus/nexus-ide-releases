import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron';
import type { PerfSnapshot } from '../shared/types';
import { parseFunctionalSmokeResult } from '../shared/smoke-types';
import { SOAK_CHANNELS, SOAK_ENV, SOAK_FILE, SOAK_POLICY, SOAK_HEAP_SOURCE, SOAK_ELECTRON,
  parseSoakCycle, parseSoakSample, assertSoakSamples, type SoakSample } from '../shared/soak-smoke';

export function isSoakSmokeRequested(input: { smokeTest: boolean; packaged: boolean; env: NodeJS.ProcessEnv; userData: string }): boolean {
  return input.smokeTest && input.packaged && input.env[SOAK_ENV] === '1' && input.env.NEXUS_PACKAGED_SMOKE === '1' &&
    path.isAbsolute(input.userData) && input.env.NEXUS_USER_DATA_DIR === input.userData && input.env.HOME === path.join(input.userData, 'home');
}
interface Ports {
  collect(): Promise<PerfSnapshot>;
  terminate(id: string): Promise<boolean>;
  owned(wc: Electron.WebContents, id: string): boolean;
  cwd(id: string): string | null;
  now?(): number;
  listOwned?(wc: Electron.WebContents): string[];
}
export async function proveSoakForSmoke(win: BrowserWindow, input: {
  ipc: IpcMain; userData: string; appVersion: string; packaged: boolean; smokeTest: boolean;
  workspacePath: string; signal: AbortSignal; env?: NodeJS.ProcessEnv;
  /** Enter the application's existing sealed, physically drained FAIL quit.
   * A hung renderer/collector must not prevent arming its native quit ceiling. */
  requestPhysicalShutdown?(reason: string): void;
}, ports?: Ports): Promise<void> {
  const env = input.env ?? process.env;
  const check = (): void => { if (input.signal.aborted) throw new Error('soak setup cancelled'); };
  check();
  if (!isSoakSmokeRequested({ ...input, env })) throw new Error('soak requires explicit packaged smoke and private profile');
  for (const directory of [input.userData, path.join(input.userData, 'home')]) {
    const stat = await fs.lstat(directory);
    check();
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('soak profile is not private');
    const canonical = await fs.realpath(directory); check();
    if (canonical !== directory) throw new Error('soak profile is not canonical');
  }
  if (!ports) {
    if (process.versions.electron !== SOAK_ELECTRON) throw new Error('soak requires the qualified Electron heap implementation');
    const [perf, pty] = await Promise.all([import('./perf/perf-ipc'), import('./pty/pty-manager')]);
    check();
    ports = { collect: perf.collectPerfSnapshotDetailed, terminate: id => pty.orchTerminateSession(id, { origin: 'soak-smoke' }), owned: pty.isSessionOwnedBy, cwd: pty.getSessionCwd, listOwned: wc => pty.listLiveSessionLocations().filter(v => pty.isSessionOwnedBy(wc, v.sessionId) && v.cwd === input.workspacePath).map(v => v.sessionId) };
  }
  const deps = ports, now = deps.now ?? (() => performance.now());
  const wc = win.webContents, frame = wc.mainFrame, rendererPid = wc.getOSProcessId(), nonce = randomUUID();
  const startedAt = Date.now(), start = now(), samples: SoakSample[] = [], held = new Set<string>(), seen = new Set<string>();
  const logs = path.join(input.userData, 'logs'); await fs.mkdir(logs, { recursive: true, mode: 0o700 });
  check();
  const progress = path.join(logs, 'soak-samples.ndjson');
  await fs.writeFile(progress, JSON.stringify({ schema: 'nexus.soak-start/v1', nonce, pid: process.pid, rendererPid,
    appVersion: input.appVersion, policy: SOAK_POLICY, heapSource: SOAK_HEAP_SOURCE, startedAt }) + '\n', { mode: 0o600, flag: 'wx' });
  check();
  let activityDurationMs = 0, awaitingDone = false, rendererGone = false;
  let stopAcknowledged!: () => void;
  const rendererStopped = new Promise<void>(resolve => { stopAcknowledged = resolve; });
  let flight: Promise<void> | null = null, stopped = false, failure: Error | null = null;
  await new Promise<void>((resolve, reject) => {
    const authorized = (event: IpcMainEvent): boolean => { try { return event.sender === wc && event.senderFrame === frame && wc.mainFrame === frame && wc.getOSProcessId() === rendererPid; } catch { return false; } };
    const cleanup = (): void => {
      clearTimeout(timer); input.signal.removeEventListener('abort', onAbort); win.removeListener('closed', onClosed);
      wc.removeListener('render-process-gone', onGone);
      input.ipc.removeListener(SOAK_CHANNELS.cycle, onCycle); input.ipc.removeListener(SOAK_CHANNELS.failed, onFailed);
      input.ipc.removeListener(SOAK_CHANNELS.done, onDone); input.ipc.removeListener(SOAK_CHANNELS.stopped, onStopped);
    };
    const finish = async (): Promise<void> => {
      try {
        if (!rendererGone) await rendererStopped;
        if (flight) await flight;
        for (const id of deps.listOwned?.(wc) ?? []) { held.add(id); seen.add(id); }
        for (const id of held) { if (!await deps.terminate(id)) throw new Error('soak physical cleanup unproved'); held.delete(id); }
        if (failure) throw failure;
        cleanup(); resolve();
      } catch (error) { cleanup(); reject(error); }
    };
    const fail = (message: string): void => {
      if (stopped) return; stopped = true; failure = new Error(message);
      console.error(`[smoke] soak-failed: ${message}`);
      try { wc.send(SOAK_CHANNELS.stop, { nonce }); } catch { /* Closing renderer; Main still drains. */ }
      input.requestPhysicalShutdown?.(message);
      void finish();
    };
    const onAbort = (): void => fail('soak cancelled');
    const onClosed = (): void => { rendererGone = true; stopAcknowledged(); fail('soak renderer closed'); };
    const onGone = (): void => { rendererGone = true; stopAcknowledged(); fail('soak renderer process gone'); };
    const onFailed = (event: IpcMainEvent, raw: unknown): void => {
      if (authorized(event) && raw && typeof raw === 'object' && (raw as { nonce?: unknown }).nonce === nonce) fail('soak renderer activity failed');
    };
    const onStopped = (event: IpcMainEvent, raw: unknown): void => {
      if (!authorized(event) || !raw || typeof raw !== 'object') return;
      const value = raw as { nonce?: unknown; sessionIds?: unknown };
      if (value.nonce !== nonce || !Array.isArray(value.sessionIds) || value.sessionIds.length > 3 || !value.sessionIds.every(id =>
        typeof id === 'string' && id.length <= 256 && (seen.has(id) || deps.owned(wc, id) && deps.cwd(id) === input.workspacePath))) return;
      for (const id of value.sessionIds) held.add(id as string);
      stopAcknowledged(); if (!stopped) fail('soak activity stopped before completion');
    };
    const onDone = (event: IpcMainEvent, raw: unknown): void => {
      if (!authorized(event) || stopped) return;
      const value = raw as { nonce?: unknown; result?: unknown } | null;
      const result = value && parseFunctionalSmokeResult(value.result);
      if (!awaitingDone || flight || held.size || !result?.ok || value?.nonce !== nonce) { fail('soak final functional/cleanup proof refused'); return; }
      flight = (async () => {
        const summary = assertSoakSamples(samples, activityDurationMs);
        const temporary = path.join(logs, `.${SOAK_FILE}.${nonce}`);
        await fs.writeFile(temporary, JSON.stringify({ schema: 'nexus.soak-smoke/v1', nonce, pid: process.pid, rendererPid,
          appVersion: input.appVersion, packaged: true, electronVersion: SOAK_ELECTRON, heapSource: SOAK_HEAP_SOURCE,
          startedAt, finishedAt: Date.now(), durationMs: activityDurationMs, postFunctionalMs: now() - start - activityDurationMs,
          policy: SOAK_POLICY, units: 'bytes', samples, summary, finalFunctional: result }) + '\n', { mode: 0o600, flag: 'wx' });
        if (stopped) return;
        await fs.rename(temporary, path.join(logs, SOAK_FILE));
        if (stopped) return;
        console.log('[smoke] soak-ready: sustained activity, memory bounds and final functionality proven');
        stopped = true; cleanup(); resolve();
      })().catch(error => { failure = error instanceof Error ? error : new Error('soak receipt failed'); }).finally(() => {
        flight = null; if (failure && !stopped) fail(failure.message);
      });
    };
    const onCycle = (event: IpcMainEvent, raw: unknown): void => {
      if (!authorized(event) || stopped) return;
      const value = parseSoakCycle(raw);
      if (!value || value.nonce !== nonce || value.sequence !== samples.length || flight || awaitingDone || value.rendererPid !== rendererPid ||
        !deps.owned(wc, value.sessionId) || deps.cwd(value.sessionId) !== input.workspacePath) { fail('soak cycle authority/protocol refused'); return; }
      held.add(value.sessionId); seen.add(value.sessionId);
      for (const id of deps.listOwned?.(wc) ?? []) seen.add(id);
      flight = (async () => {
        let terminated = false;
        try {
          const perf = await deps.collect();
          if (stopped) return;
          if (!authorized(event) || !deps.owned(wc, value.sessionId)) throw new Error('soak ownership changed during sample');
          const renderer = perf.appMetrics.find(v => v.pid === rendererPid && v.type === 'Tab');
          const footprints = perf.panes.footprints;
          const footprint = footprints?.find(v => v.sessionId === value.sessionId);
          if (!renderer || !footprint || footprint.rootPid <= 0 || footprint.processCount <= 0 || !footprint.rssBytes ||
              !renderer.memory.workingSetSize || !footprints?.length || footprints.some(v => !v.rssBytes || v.rssBytes <= 0) || perf.process.pid !== process.pid) throw new Error('soak renderer/pane RSS missing');
          const sample: SoakSample = { sequence: value.sequence, elapsedMs: now() - start, rendererPid,
            livePtys: perf.panes.livePtySessions, rendererHosts: value.rendererHosts,
            memoryBytes: { mainHeap: perf.process.heapUsedBytes, mainRss: perf.process.rssBytes,
              rendererHeap: value.heapUsedKiB * 1024, rendererRss: renderer.memory.workingSetSize * 1024,
              electronRss: perf.appMetrics.reduce((s, v) => s + v.memory.workingSetSize * 1024, 0), paneRss: footprints.reduce((s, v) => s + v.rssBytes!, 0) },
            activity: { ...value.activity, physicalClose: true } };
          if (!parseSoakSample(sample)) throw new Error('soak metrics/counts unavailable');
          terminated = await deps.terminate(value.sessionId);
          if (!terminated) throw new Error('soak physical close unproved');
          held.delete(value.sessionId);
          if (stopped) return;
          samples.push(sample);
          await fs.appendFile(progress, JSON.stringify(sample) + '\n');
          if (stopped) return;
          const durationMs = now() - start;
          if (durationMs >= SOAK_POLICY.requiredDurationMs && sample.elapsedMs >= SOAK_POLICY.requiredDurationMs) {
            assertSoakSamples(samples, durationMs);
            activityDurationMs = durationMs; awaitingDone = true;
            wc.send(SOAK_CHANNELS.ack, { nonce, sequence: value.sequence, done: true });
          } else {
            wc.send(SOAK_CHANNELS.ack, { nonce, sequence: value.sequence, done: false });
          }
        } finally {
          if (!terminated && held.has(value.sessionId)) {
            if (await deps.terminate(value.sessionId)) held.delete(value.sessionId);
          }
        }
      })().catch(error => { failure = error instanceof Error ? error : new Error('soak sample failed'); }).finally(() => {
        flight = null;
        if (failure && !stopped) fail(failure.message);
      });
    };
    const timer = setTimeout(() => fail('soak deadline exceeded'), SOAK_POLICY.timeoutMs);
    input.ipc.on(SOAK_CHANNELS.cycle, onCycle); input.ipc.on(SOAK_CHANNELS.failed, onFailed);
    input.ipc.on(SOAK_CHANNELS.done, onDone); input.ipc.on(SOAK_CHANNELS.stopped, onStopped);
    input.signal.addEventListener('abort', onAbort, { once: true }); win.once('closed', onClosed);
    wc.once('render-process-gone', onGone);
    if (input.signal.aborted) onAbort(); else wc.send(SOAK_CHANNELS.run, { nonce, workspacePath: input.workspacePath });
  });
}
