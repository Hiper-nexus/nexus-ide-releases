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
import { getLiveSessionCount, probePaneFootprints } from '../pty/pty-manager';

const BROADCAST_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;

function broadcast(payload: PaneFootprintBroadcast): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    try {
      wc.send(PERF_CHANNELS.paneFootprints, payload);
    } catch {
      // Frame descartado entre a listagem e o send.
    }
  }
}

async function tick(): Promise<void> {
  if (getLiveSessionCount() === 0) return;
  const footprints = await probePaneFootprints();
  if (!footprints) return;
  const bySessionId: PaneFootprintBroadcast['bySessionId'] = {};
  for (const footprint of footprints) {
    bySessionId[footprint.sessionId] = {
      rssBytes: footprint.rssBytes,
      processCount: footprint.processCount,
    };
  }
  broadcast({
    capturedAt: Date.now(),
    bySessionId,
    systemMemory: getCachedSystemMemory(),
  });
}

export function startPaneFootprintBroadcast(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), BROADCAST_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopPaneFootprintBroadcast(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Só para teste: dispara um ciclo fora do relógio de 30s. */
export function runPaneFootprintBroadcastTickForTests(): Promise<void> {
  return tick();
}
