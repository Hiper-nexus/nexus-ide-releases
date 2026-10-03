import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
/**
 * Sink de persistência do Nexus Redline: publica cada snapshot que virou
 * `lastSnapshot` em `~/.nexus/redline-last-good.json` (atômico, 0600, sem
 * segredos) e observa o arquivo-sinal de refresh escrito pelo companheiro.
 *
 * Falha de escrita nunca afeta o quota-service: warn no máx. 1×/min.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import type { AccountInfo } from '../../shared/account-types';
import {
  collapseSharedQuotaEntries,
  compareEntriesByConsumption,
  type QuotaFleetSnapshot,
} from '../../shared/quota-types';
import {
  REDLINE_REFRESH_FILENAME,
  REDLINE_SNAPSHOT_FILENAME,
  REDLINE_SNAPSHOT_FORMAT_VERSION,
  selectRedlineStatusBarEntryIds,
  type RedlineSnapshotFile,
} from '../../shared/redline-types';
import { scoreFleet } from './smart-pick';

const WARN_INTERVAL_MS = 60_000;

/** `~/.nexus` — mesmo home de config que o resto do ecossistema. */
export function resolveRedlineHome(homedir = osHomedir()): string {
  return join(homedir, '.nexus');
}

export function resolveRedlineSnapshotPath(homedir = osHomedir()): string {
  return join(resolveRedlineHome(homedir), REDLINE_SNAPSHOT_FILENAME);
}

export function resolveRedlineRefreshPath(homedir = osHomedir()): string {
  return join(resolveRedlineHome(homedir), REDLINE_REFRESH_FILENAME);
}

/** Monta o conteúdo do arquivo a partir do snapshot + contas. Puro. */
export function buildRedlineSnapshotFile(
  snap: QuotaFleetSnapshot,
  accounts: ReadonlyArray<AccountInfo>,
  now = Date.now(),
): RedlineSnapshotFile {
  const scored = scoreFleet(snap.entries, accounts, now);
  // F-720: o Redline mostra uma linha por cota (GLM/GLM Flash na mesma chave).
  // O grupo vem do snapshot: as linhas decoradas pelo scorer não o carregam.
  const shown = new Set(collapseSharedQuotaEntries(snap.entries).map((entry) => entry.id));
  const entries = scored.entries
    .filter((entry) => shown.has(entry.id))
    .sort(compareEntriesByConsumption);
  const ratios = entries.flatMap((entry) => entry.windows.map((window) => window.usedRatio))
    .filter((ratio): ratio is number => ratio !== null);
  return {
    formatVersion: REDLINE_SNAPSHOT_FORMAT_VERSION,
    generatedBy: 'nexus',
    updatedAt: snap.updatedAt || now,
    worstUsedRatio: ratios.length > 0 ? Math.max(...ratios) : null,
    entries,
    ranking: scored.ranking,
    statusBarEntryIds: selectRedlineStatusBarEntryIds(entries),
  };
}

export interface RedlineSink {
  /** Agenda a escrita do snapshot (last-wins; nunca lança). */
  persist(snap: QuotaFleetSnapshot, accounts: ReadonlyArray<AccountInfo>): void;
  /** Observa o arquivo-sinal de refresh; retorna stop(). */
  watchRefreshRequests(onRequest: () => unknown | Promise<unknown>): () => Promise<void>;
  stop(): Promise<void>;
}

export interface RedlineSinkDeps {
  homedir?: string;
  now?: () => number;
}

let lastWarnAt = 0;

function warnThrottled(message: string): void {
  const at = Date.now();
  if (at - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = at;
  console.warn(`[redline] ${message}`);
}

/**
 * Escrita atômica: tmp no mesmo diretório + rename. 0600 antes do rename —
 * o rename preserva permissão e o destino nunca é visto pela metade.
 */
export function writeRedlineSnapshotFileSync(
  path: string,
  file: RedlineSnapshotFile,
): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${REDLINE_SNAPSHOT_FILENAME}.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

export function createRedlineSink(deps?: RedlineSinkDeps): RedlineSink {
  const now = deps?.now ?? Date.now;
  const snapshotPath = resolveRedlineSnapshotPath(deps?.homedir);
  const refreshPath = resolveRedlineRefreshPath(deps?.homedir);
  let writing: Promise<void> | null = null;
  let stopped = false;
  const controller = new AbortController();
  const taskId = `redline-refresh-request:${randomUUID()}`;
  let pending: RedlineSnapshotFile | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastRefreshAt = 0;

  function flush(): Promise<void> {
    if (writing) return writing;
    if (stopped || !pending) return Promise.resolve();
    const flight = (async () => {
      while (pending && !stopped) {
        const file = pending;
        pending = null;
        const directory = join(snapshotPath, '..');
        const temporary = join(directory, `.${REDLINE_SNAPSHOT_FILENAME}.tmp-${randomUUID()}`);
        try {
          await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
          await fsp.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          if (!stopped) await fsp.rename(temporary, snapshotPath);
        } catch (error) { warnThrottled(`falha ao publicar snapshot (${(error as Error).message ?? error})`); }
        finally { await fsp.rm(temporary, { force: true }).catch(() => undefined); }
      }
    })();
    writing = flight;
    void flight.finally(() => { if (writing === flight) writing = null; });
    return flight;
  }

  return {
    persist(snap, accounts) {
      if (stopped) return;
      if (pending) {
        // Last-wins: um snapshot mais novo substitui o enfileirado.
        pending = buildRedlineSnapshotFile(snap, accounts, now());
        return;
      }
      pending = buildRedlineSnapshotFile(snap, accounts, now());
      void flush();
    },

    watchRefreshRequests(onRequest) {
      // Poll de 1s: o arquivo-sinal é minúsculo e raro — simples vence esperto.
      pollTimer = setInterval(() => {
        void runPeriodicTask(taskId, async (context) => {
          const signalFile = await context.wait(fsp.lstat(refreshPath).catch(() => null));
          if (!signalFile || !signalFile.isFile() || signalFile.isSymbolicLink()) return;
          const at = now();
          if (at - lastRefreshAt < 1_000) return;
          const identity = await context.wait(fsp.lstat(refreshPath).catch(() => null));
          if (!identity || identity.dev !== signalFile.dev || identity.ino !== signalFile.ino ||
            identity.size !== signalFile.size || identity.mtimeMs !== signalFile.mtimeMs) return;
          await context.wait(fsp.unlink(refreshPath));
          lastRefreshAt = at;
          await context.wait(Promise.resolve(onRequest()));
        }, { signal: controller.signal, cadenceMs: 1_000 }).catch((error) => {
          if (!stopped) warnThrottled(`refresh pedido falhou (${(error as Error).message ?? error})`);
        });
      }, 1_000);
      pollTimer.unref?.();
      return async () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        await stopPeriodicTask(taskId);
      };
    },

    async stop() {
      stopped = true;
      controller.abort(new Error('redline sink stopped'));
      pending = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      await stopPeriodicTask(taskId);
      await writing;
    },
  };
}
