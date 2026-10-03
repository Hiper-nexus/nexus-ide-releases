/**
 * Watchdog da main thread em worker thread (campanha 0.50, C7).
 *
 * O main posta heartbeat a cada HANG_WATCHDOG_HEARTBEAT_MS; a worker mede o
 * gap. Acima do limiar, a worker escreve/regrava o marker em
 * `userData/logs/main-hang-marker.json` (a worker tem fs próprio — o main
 * pendurado não escreve nada). Só empacotado: dev pausa em debugger por
 * design (doutrina Orca). Nada de auto-kill: a evidência é o produto.
 */

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import {
  HANG_WATCHDOG_HEARTBEAT_MS,
  HANG_WATCHDOG_THRESHOLD_MS,
  buildHangMarker,
} from './hang-watchdog-logic';

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
let lastHeartbeat = null;
let markedAt = 0;
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'heartbeat') lastHeartbeat = msg.at;
  if (msg && msg.type === 'stop') process.exit(0);
});
setInterval(() => {
  const now = Date.now();
  if (lastHeartbeat === null) return;
  const gap = now - lastHeartbeat;
  if (gap <= workerData.thresholdMs) return;
  // Remarca no máximo a cada 60s: a duração atualiza, sem spam de disco.
  if (now - markedAt < 60_000) return;
  markedAt = now;
  const line = JSON.stringify({
    kind: 'main-thread-hang',
    hangDurationMs: gap,
    appVersion: workerData.version,
    lastHeartbeatAt: lastHeartbeat,
    detectedAt: now,
  }) + '\\n';
  try {
    fs.mkdirSync(workerData.logsDir, { recursive: true });
    fs.writeFileSync(path.join(workerData.logsDir, 'main-hang-marker.json'), line);
  } catch {}
  // F-764: o marker é sobrescrito; o histórico guarda TODOS os travamentos
  // (o incidente de 03/10 teve três seguidos e só o último sobrou).
  try {
    const history = path.join(workerData.logsDir, 'main-hang.ndjson');
    try {
      if (fs.statSync(history).size > 512 * 1024) fs.renameSync(history, history + '.1');
    } catch {}
    fs.appendFileSync(history, line);
  } catch {}
}, workerData.checkIntervalMs);
`;

export interface HangWatchdogHandle {
  readonly stop: () => void;
}

export function startMainThreadHangWatchdog(options: {
  readonly logsDir: string;
  readonly version: string;
}): HangWatchdogHandle | null {
  try {
    mkdirSync(options.logsDir, { recursive: true });
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        logsDir: options.logsDir,
        version: options.version,
        thresholdMs: HANG_WATCHDOG_THRESHOLD_MS,
        checkIntervalMs: HANG_WATCHDOG_HEARTBEAT_MS,
      },
    });
    const heartbeat = setInterval(() => {
      worker.postMessage({ type: 'heartbeat', at: Date.now() });
    }, HANG_WATCHDOG_HEARTBEAT_MS);
    heartbeat.unref?.();
    const stop = () => {
      clearInterval(heartbeat);
      try {
        worker.postMessage({ type: 'stop' });
      } catch {
        // worker já saiu.
      }
    };
    return { stop };
  } catch (error) {
    // Watchdog é best-effort: falha ao armar nunca derruba o boot.
    try {
      appendFileSync(
        join(options.logsDir, 'main-hang-marker.json'),
        `${JSON.stringify({ kind: 'hang-watchdog-arm-failure', error: String(error) })}\n`,
      );
    } catch {
      // Sem disco, sem watchdog — o boot segue.
    }
    return null;
  }
}

/** Test-only: constrói o marker da worker com a mesma shape. */
export const hangMarkerForTest = buildHangMarker;
