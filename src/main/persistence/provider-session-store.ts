import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * Sessões de provider CAPTURADAS por pane (benchmark §4.3 — o coração das
 * sessões duráveis): (workspace, paneId) → session id real do CLI, colhido do
 * transcript pelo usage-service. No reopen, o spawn usa `--resume <id>` e cada
 * pane volta para a SUA conversa — não para "a última do workspace".
 *
 * paneId é estável entre boots (vem do layout persistido). Um resume gera novo
 * session id no CLI; o watcher captura o novo id e o registro se auto-corrige.
 */

export interface CapturedProviderSession {
  provider: string;
  sessionId: string;
  capturedAt: number;
  source: 'transcript-file' | 'dictated';
  confidence: 'high' | 'low';
}

type StoreShape = Record<string, CapturedProviderSession>;

const FILE = () => path.join(app.getPath('userData'), 'provider-sessions.json');
const MAX_ENTRIES = 500;

let cache: StoreShape | null = null;

function key(workspacePath: string, paneId: string): string {
  return `${workspacePath}::${paneId}`;
}

function load(): StoreShape {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as StoreShape;
  } catch {
    cache = {};
  }
  return cache;
}

function save(store: StoreShape): void {
  cache = store;
  try {
    const entries = Object.entries(store);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].capturedAt - a[1].capturedAt);
      cache = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }
    const tmp = `${FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE());
  } catch (err) {
    console.warn('[provider-sessions] persist falhou:', err);
  }
}

export function captureProviderSession(
  workspacePath: string,
  paneId: string,
  entry: Omit<CapturedProviderSession, 'capturedAt'>,
): void {
  const store = load();
  const existing = store[key(workspacePath, paneId)];
  if (existing?.sessionId === entry.sessionId) return; // no-op: mesmo id
  store[key(workspacePath, paneId)] = { ...entry, capturedAt: Date.now() };
  save(store);
}

export function getProviderSession(
  workspacePath: string,
  paneId: string,
): CapturedProviderSession | null {
  return load()[key(workspacePath, paneId)] ?? null;
}
