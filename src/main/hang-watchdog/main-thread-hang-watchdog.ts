/**
 * Watchdog da main thread em worker thread (campanha 0.50, C7; F-764 A.1).
 *
 * O main posta heartbeat a cada HANG_WATCHDOG_HEARTBEAT_MS; a worker mede o
 * gap. Acima do limiar, a worker grava o marker em
 * `userData/logs/main-hang-marker.json`, uma linha em `main-hang.ndjson` e —
 * uma vez por episódio — liga o Profiler da main pelo inspector e grava
 * `main-hang-<ts>.cpuprofile` com as frames mais quentes (a worker tem fs
 * próprio; o main pendurado não escreve nada). Só empacotado: dev pausa em
 * debugger por design (doutrina Orca). Nada de auto-kill: a evidência é o
 * produto.
 *
 * A worker é `hang-watchdog-worker.cjs`, embutida verbatim (`?raw`) e
 * avaliada com `eval: true` — nada de arquivo de worker dentro do asar.
 */

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import HANG_WATCHDOG_WORKER_SOURCE from './hang-watchdog-worker.cjs?raw';
import {
  HANG_WATCHDOG_HEARTBEAT_MS,
  HANG_WATCHDOG_WORKER_KIND,
  buildHangMarker,
  buildHangWatchdogConfig,
  parseHangWatchdogMessage,
  type HangWatchdogRecord,
  type HangWatchdogTuning,
} from './hang-watchdog-logic';

export { HANG_WATCHDOG_WORKER_SOURCE };

/** Prazo para a worker sair sozinha no `stop()` antes do terminate. */
const STOP_GRACE_MS = 2_000;

export interface HangWatchdogHandle {
  /** Último resumo do event-loop (A.3): sai na próxima linha de travamento. */
  readonly reportEventLoop: (summary: object) => void;
  /** Para a worker; resolve quando ela sair. */
  readonly stop: () => Promise<void>;
}

export interface StartHangWatchdogOptions {
  readonly logsDir: string;
  readonly version: string;
  /** Ajustes de limiar/captura (testes e o probe de smoke). */
  readonly tuning?: HangWatchdogTuning;
  /** Intervalo do heartbeat do main (padrão HANG_WATCHDOG_HEARTBEAT_MS). */
  readonly heartbeatMs?: number;
  /**
   * Cada linha que a worker grava no `main-hang.ndjson`. Chega quando o main
   * volta a processar mensagens — é o caminho para o `main.trace.ndjson`.
   */
  readonly onRecord?: (record: HangWatchdogRecord) => void;
}

/** Falha do próprio watchdog: vai para o histórico, nunca para o boot. */
function recordWatchdogFailure(logsDir: string, kind: string, error: unknown): void {
  try {
    appendFileSync(
      join(logsDir, 'main-hang.ndjson'),
      `${JSON.stringify({ kind, error: String(error), at: Date.now() })}\n`,
    );
  } catch {
    // Sem disco, sem registro — o app segue.
  }
}

export function startMainThreadHangWatchdog(
  options: StartHangWatchdogOptions,
): HangWatchdogHandle | null {
  try {
    mkdirSync(options.logsDir, { recursive: true });
    const config = buildHangWatchdogConfig({
      logsDir: options.logsDir,
      version: options.version,
      tuning: options.tuning,
    });
    const heartbeatMs =
      options.heartbeatMs && options.heartbeatMs > 0
        ? options.heartbeatMs
        : HANG_WATCHDOG_HEARTBEAT_MS;
    const worker = new Worker(HANG_WATCHDOG_WORKER_SOURCE, {
      eval: true,
      workerData: { kind: HANG_WATCHDOG_WORKER_KIND, config },
    });
    // A worker não segura o processo vivo (testes, quit).
    worker.unref();
    let exited = false;
    const exit = new Promise<void>((resolve) => {
      worker.once('exit', () => {
        exited = true;
        resolve();
      });
    });
    // Sem listener, um erro na worker vira exceção não tratada NO MAIN.
    worker.on('error', (error) => {
      recordWatchdogFailure(options.logsDir, 'hang-watchdog-worker-error', error);
    });
    worker.on('message', (message: unknown) => {
      const record = parseHangWatchdogMessage(message);
      if (!record || !options.onRecord) return;
      try {
        options.onRecord(record);
      } catch {
        // Consumidor com defeito não derruba o watchdog.
      }
    });
    const post = (message: object): void => {
      if (exited) return;
      try {
        worker.postMessage(message);
      } catch {
        // Worker já saiu.
      }
    };
    // Primeiro heartbeat na hora: a medição começa com a worker, não 5 s depois.
    post({ type: 'heartbeat', at: Date.now() });
    const heartbeat = setInterval(() => {
      post({ type: 'heartbeat', at: Date.now() });
    }, heartbeatMs);
    heartbeat.unref?.();
    const stop = async (): Promise<void> => {
      clearInterval(heartbeat);
      post({ type: 'stop' });
      await Promise.race([
        exit,
        new Promise<void>((resolve) => {
          setTimeout(resolve, STOP_GRACE_MS).unref?.();
        }),
      ]);
      if (!exited) await worker.terminate().catch(() => undefined);
    };
    return {
      reportEventLoop: (summary) => post({ type: 'event-loop', summary }),
      stop,
    };
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
