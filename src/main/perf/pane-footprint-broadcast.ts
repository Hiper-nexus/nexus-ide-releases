import { runPeriodicTask, stopPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';
/**
 * F-572/0.76.45: push periódico do footprint por pane para o badge de custo no
 * PaneToolbar — o badge não pode fazer poll a cada frame. Mesma fonte do
 * perf:snapshot (probePaneFootprints + getCachedSystemMemory), a cada 30s e só
 * quando há sessão viva (nada a medir, nada a mandar — silêncio nunca vira
 * "0 MB" inventado).
 *
 * QLT-11: só mede enquanto algum renderer exibe o badge. O renderer assina por
 * PERF_CHANNELS.paneFootprintsWatch; sem assinante não há timer nem `ps`, e
 * assinar dispara uma amostra na hora. Cada vez que o coletor liga abre uma
 * geração nova e a sequência recomeça em 1: amostra presa da geração anterior
 * é descartada, nunca entra na série nova.
 *
 * O gate de admissão de panes NÃO depende deste push: lê a memória do sistema
 * (getCachedSystemMemory), que a própria admissão e a varredura do pane
 * guardian (60s) renovam.
 */
import type { WebContents } from 'electron';
import { PERF_CHANNELS } from '../../shared/channels';
import type { PaneFootprintBroadcast } from '../../shared/surface-payload-types';
import { getCachedSystemMemory } from '../orch/pane-admission';
import { getLiveSessionCount, getSessionState, probePaneFootprints } from '../pty/pty-manager';
import { machineResourceSampler } from './machine-resources';

const BROADCAST_INTERVAL_MS = 30_000;

const subscribers = new Set<WebContents>();
const watchedForDestroy = new WeakSet<WebContents>();
let enabled = false;
let timer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;
let stopFlight: Promise<void> | null = null;
let flight: Promise<void> | null = null;
let generation = 0;
let sequence = 0;

async function tick(context: PeriodicTaskContext): Promise<void> {
  const series = generation;
  // Coletor desligado ou religado depois que este tick começou: a amostra é
  // de outra série e não sai.
  const current = () => timer !== null && series === generation;
  if (!current() || getLiveSessionCount() === 0) return;
  const footprints = await context.wait(probePaneFootprints());
  if (!footprints) return;
  const bySessionId: PaneFootprintBroadcast['bySessionId'] = {};
  let panesRssBytes: number | null = null;
  let paneCount = 0;
  for (const footprint of footprints) {
    await context.checkpoint();
    if (getSessionState(footprint.sessionId) === null) continue;
    bySessionId[footprint.sessionId] = {
      rssBytes: footprint.rssBytes,
      processCount: footprint.processCount,
    };
    paneCount += 1;
    if (footprint.rssBytes !== null) panesRssBytes = (panesRssBytes ?? 0) + footprint.rssBytes;
  }
  if (!current()) return;
  const systemMemory = getCachedSystemMemory();
  const payload: PaneFootprintBroadcast = {
    generation: series,
    sequence: ++sequence,
    capturedAt: Date.now(),
    bySessionId,
    systemMemory,
    // F-1172: resumo da máquina com a mesma leitura do gate (sem `ps` extra).
    machine: machineResourceSampler.sample({ memory: systemMemory, panesRssBytes, paneCount }),
  };
  for (const wc of [...subscribers]) {
    await context.checkpoint();
    if (!current()) return;
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    try {
      wc.send(PERF_CHANNELS.paneFootprints, payload);
    } catch {
      // Frame descartado entre a listagem e o send.
    }
  }
}

function requestTick(): Promise<void> {
  if (!timer) return Promise.resolve();
  controller ??= new AbortController();
  const run = runPeriodicTask('pane-footprint', tick, { signal: controller.signal, cadenceMs: BROADCAST_INTERVAL_MS });
  flight = run;
  const settled = () => { if (flight === run) flight = null; };
  void run.then(settled, settled);
  return run;
}

/** Amostra para quem acabou de assinar — depois do tick em voo, que pode ser da geração anterior. */
function sampleNow(): void {
  const pending = flight;
  void (pending ? pending.then(requestTick, requestTick) : requestTick()).catch(() => undefined);
}

function reconcileCollector(): void {
  const wanted = enabled && subscribers.size > 0;
  if (wanted === (timer !== null)) return;
  if (timer) {
    clearInterval(timer);
    timer = null;
    return;
  }
  generation += 1;
  sequence = 0;
  timer = setInterval(() => { void requestTick().catch(() => undefined); }, BROADCAST_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Liga/desliga a assinatura de um renderer. Assinar de novo (mesmo renderer
 * depois de um reload) também pede amostra na hora.
 *
 * ponytail: um renderer recarregado sem badge nenhum continua assinante até
 * desassinar ou ser destruído — no pior caso volta ao custo antigo (um `ps` a
 * cada 30s com sessão viva). Se pesar, desassinar em `did-start-navigation`.
 */
export function setPaneFootprintSubscription(contents: WebContents, active: boolean): void {
  if (!active) {
    subscribers.delete(contents);
    reconcileCollector();
    return;
  }
  if (!watchedForDestroy.has(contents)) {
    watchedForDestroy.add(contents);
    contents.once('destroyed', () => setPaneFootprintSubscription(contents, false));
  }
  subscribers.add(contents);
  reconcileCollector();
  sampleNow();
}

export function startPaneFootprintBroadcast(): void {
  if (enabled) return;
  if (stopFlight) throw new Error('pane footprint broadcast is still stopping');
  enabled = true;
  controller = new AbortController();
  reconcileCollector();
  sampleNow();
}

export function stopPaneFootprintBroadcast(): Promise<void> {
  if (stopFlight) return stopFlight;
  enabled = false;
  reconcileCollector();
  controller?.abort(new Error('pane footprint broadcast stopped'));
  const stop = stopPeriodicTask('pane-footprint').then(() => { controller = null; });
  stopFlight = stop;
  void stop.finally(() => { if (stopFlight === stop) stopFlight = null; });
  return stop;
}
