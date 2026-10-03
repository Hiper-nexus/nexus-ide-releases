import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
/**
 * F-572/0.76.45: push periódico do footprint por pane a todos os renderers —
 * o badge de custo no PaneToolbar não pode fazer poll a cada frame. Mesma
 * fonte do perf:snapshot (probePaneFootprints + getCachedSystemMemory), mas
 * por evento a cada 30s e só quando há sessão viva (nada a medir, nada a
 * mandar — silêncio nunca vira "0 MB" inventado).
 */
import { webContents } from 'electron';
import { PERF_CHANNELS } from '../../shared/channels';
import type { PaneFootprintBroadcast } from '../../shared/surface-payload-types';
import { getCachedSystemMemory } from '../orch/pane-admission';
import { getLiveSessionCount, getSessionState, probePaneFootprints } from '../pty/pty-manager';

const BROADCAST_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;
let stopFlight: Promise<void> | null = null;

async function broadcast(payload: PaneFootprintBroadcast, context: PeriodicTaskContext): Promise<void> {
  for (const wc of webContents.getAllWebContents()) {
    await context.checkpoint();
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    try {
      wc.send(PERF_CHANNELS.paneFootprints, payload);
    } catch {
      // Frame descartado entre a listagem e o send.
    }
  }
}

async function tick(context: PeriodicTaskContext): Promise<void> {
  if (getLiveSessionCount() === 0) return;
  const footprints = await context.wait(probePaneFootprints());
  if (!footprints) return;
  const bySessionId: PaneFootprintBroadcast['bySessionId'] = {};
  for (const footprint of footprints) {
    await context.checkpoint();
    if (getSessionState(footprint.sessionId) === null) continue;
    bySessionId[footprint.sessionId] = {
      rssBytes: footprint.rssBytes,
      processCount: footprint.processCount,
    };
  }
  await broadcast({
    capturedAt: Date.now(),
    bySessionId,
    systemMemory: getCachedSystemMemory(),
  }, context);
}

function requestTick(): Promise<void> {
  controller ??= new AbortController();
  return runPeriodicTask('pane-footprint', tick, { signal: controller.signal, cadenceMs: BROADCAST_INTERVAL_MS });
}

export function startPaneFootprintBroadcast(): void {
  if (timer) return;
  if (stopFlight) throw new Error('pane footprint broadcast is still stopping');
  controller = new AbortController();
  timer = setInterval(() => { void requestTick().catch(() => undefined); }, BROADCAST_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopPaneFootprintBroadcast(): Promise<void> {
  if (stopFlight) return stopFlight;
  if (timer) clearInterval(timer);
  timer = null;
  controller?.abort(new Error('pane footprint broadcast stopped'));
  const stop = stopPeriodicTask('pane-footprint').then(() => { controller = null; });
  stopFlight = stop;
  void stop.finally(() => { if (stopFlight === stop) stopFlight = null; });
  return stop;
}

/** Só para teste: dispara um ciclo fora do relógio de 30s. */
export function runPaneFootprintBroadcastTickForTests(): Promise<void> {
  return requestTick();
}
