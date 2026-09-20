/**
 * Sink de persistência do Nexus Redline: publica cada snapshot que virou
 * `lastSnapshot` em `~/.nexus/redline-last-good.json` (atômico, 0600, sem
 * segredos) e observa o arquivo-sinal de refresh escrito pelo companheiro.
 *
 * Falha de escrita nunca afeta o quota-service: warn no máx. 1×/min.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import type { AccountInfo } from '../../shared/account-types';
import type { QuotaFleetSnapshot } from '../../shared/quota-types';
import {
  REDLINE_REFRESH_FILENAME,
  REDLINE_SNAPSHOT_FILENAME,
  REDLINE_SNAPSHOT_FORMAT_VERSION,
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
  return {
    formatVersion: REDLINE_SNAPSHOT_FORMAT_VERSION,
    generatedBy: 'nexus',
    updatedAt: snap.updatedAt || now,
    worstUsedRatio: snap.worstUsedRatio,
    entries: scored.entries,
    ranking: scored.ranking,
  };
}

export interface RedlineSink {
  /** Agenda a escrita do snapshot (last-wins; nunca lança). */
  persist(snap: QuotaFleetSnapshot, accounts: ReadonlyArray<AccountInfo>): void;
  /** Observa o arquivo-sinal de refresh; retorna stop(). */
  watchRefreshRequests(onRequest: () => void): () => void;
  stop(): void;
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
  let writing = false;
  let pending: RedlineSnapshotFile | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastRefreshAt = 0;

  async function flush(): Promise<void> {
    if (writing || !pending) return;
    const file = pending;
    pending = null;
    writing = true;
    try {
      writeRedlineSnapshotFileSync(snapshotPath, file);
    } catch (err) {
      warnThrottled(
        `falha ao publicar snapshot (${(err as Error).message ?? err})`,
      );
    } finally {
      writing = false;
      if (pending) void flush();
    }
  }

  return {
    persist(snap, accounts) {
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
        if (!existsSync(refreshPath)) return;
        const at = now();
        if (at - lastRefreshAt < 1_000) return;
        lastRefreshAt = at;
        try {
          rmSync(refreshPath, { force: true });
        } catch {
          return;
        }
        try {
          onRequest();
        } catch (err) {
          warnThrottled(`refresh pedido falhou (${(err as Error).message ?? err})`);
        }
      }, 1_000);
      pollTimer.unref?.();
      return () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    },

    stop() {
      pending = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
