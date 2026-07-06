import { ipcMain, BrowserWindow } from 'electron';
import { getDb } from '../persistence/db';
import {
  setSessionDictationHook,
  setResumeSessionLookup,
  type DictatedSessionInfo,
} from '../pty/pty-manager';
import {
  captureProviderSession,
  getProviderSession,
} from '../persistence/provider-session-store';
import { findPane, getPaneAuthzInfo } from '../orch/pane-registry';
import { ClaudeTranscriptWatcher } from './claude-transcript-watcher';
import { CodexUsageScanner } from './codex-scanner';
import {
  computeRealCost,
  initUsageStore,
  recordUsage,
  usageTotalsGlobal,
} from './usage-store';
import { initMediaUsageStore, mediaUsageTotalsGlobal } from './media-usage-store';
import { USAGE_CHANNELS, type UsageSnapshot, type PaneUsage } from '../../shared/usage-types';
import type { UsageEvent } from './claude-transcript';
import type { Db } from '../persistence/db';

/**
 * Orquestra a telemetria REAL de tokens (relatório de benchmark §4.2):
 *
 *   spawn de agente (pty-manager dita --session-id)
 *     → registro providerSessionId → ptySessionId          (aqui)
 *     → ClaudeTranscriptWatcher do workspace (cwd)          (tail do JSONL)
 *     → recordUsage no SQLite (dedupe last-wins)            (usage-store)
 *     → broadcast throttled `usage:changed` para a UI       (aqui)
 *
 * Atribuição: determinística quando o session id foi ditado; caso contrário o
 * evento ainda é gravado (workspace-level), nunca descartado. A resolução de
 * pane/missão é LAZY no momento do evento via pane-registry — o pane pode ter
 * sido registrado depois do spawn.
 */

interface Attribution {
  ptySessionId: string;
  adapterId: string;
  cwd: string;
}

const dictated = new Map<string, Attribution>(); // providerSessionId → attribution
const watchers = new Map<string, ClaudeTranscriptWatcher>(); // workspacePath → watcher
const paneTotals = new Map<string, PaneUsage>(); // agregados em memória p/ snapshot

let db: Db | null = null;
let codexScanner: CodexUsageScanner | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

function buildSnapshot(): UsageSnapshot {
  const global = db
    ? usageTotalsGlobal(db)
    : { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let media = { generations: 0, costUsd: 0 };
  if (db) {
    try {
      media = mediaUsageTotalsGlobal(db);
    } catch {
      // tabela de mídia ainda não criada — sem gerações, totais zerados
    }
  }
  return {
    byPane: Object.fromEntries(paneTotals),
    global: {
      costUsd: global.costUsd,
      inputTokens: global.inputTokens,
      outputTokens: global.outputTokens,
      turns: global.turns,
    },
    media,
  };
}

/** Poke externo (geração de mídia gravada) — reaproveita o broadcast coalescido. */
export function notifyMediaGenerated(): void {
  scheduleBroadcast();
}

/** Broadcast coalescido (máx. 1/s) — o transcript chega em rajadas. */
function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const snapshot = buildSnapshot();
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents;
      if (!wc.isDestroyed() && !wc.isCrashed()) wc.send(USAGE_CHANNELS.changed, snapshot);
    }
  }, 1000);
  broadcastTimer.unref?.();
}

function accumulatePane(paneId: string, ev: UsageEvent, costUsd: number): void {
  const prev = paneTotals.get(paneId) ?? {
    paneId,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    source: 'real' as const,
  };
  // Nota: o agregado em memória soma snapshots (o dedupe fino vive no SQLite);
  // como o CLI só regrava a mensagem DENTRO do mesmo turno de streaming e o
  // watcher lê o tail consolidado, a distorção prática é desprezível — e o
  // snapshot pull (usage:snapshot) reconstrói do SQLite quando a UI recarrega.
  paneTotals.set(paneId, {
    ...prev,
    costUsd: prev.costUsd + costUsd,
    inputTokens: prev.inputTokens + ev.inputTokens,
    outputTokens: prev.outputTokens + ev.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + ev.cacheReadTokens,
    turns: prev.turns + 1,
  });
}

function onClaudeEvent(workspacePath: string, ev: UsageEvent): void {
  if (!db) return;
  const attribution = dictated.get(ev.sessionId);
  let paneId: string | null = null;
  let missionId: string | null = null;
  if (attribution) {
    const pane = findPane(attribution.ptySessionId);
    paneId = pane?.paneId ?? null;
    if (paneId) missionId = getPaneAuthzInfo(paneId)?.missionId ?? null;
  }
  try {
    recordUsage(db, { ...ev, paneId, missionId, workspacePath });
  } catch (err) {
    console.warn('[usage] recordUsage falhou:', err);
    return;
  }
  if (paneId) {
    accumulatePane(paneId, ev, computeRealCost(ev));
    // Sessão durável: o session id REAL deste pane fica persistido — no reopen
    // o spawn usa `--resume <id>` e o pane volta para a SUA conversa.
    captureProviderSession(workspacePath, paneId, {
      provider: 'claude',
      sessionId: ev.sessionId,
      source: 'transcript-file',
      confidence: 'high',
    });
  }
  scheduleBroadcast();
}

/** Garante um watcher de transcript para o workspace (idempotente). */
export function watchWorkspaceUsage(workspacePath: string): void {
  if (!db || watchers.has(workspacePath)) return;
  const watcher = new ClaudeTranscriptWatcher({
    workspacePath,
    onEvent: (ev) => onClaudeEvent(workspacePath, ev),
  });
  watcher.start();
  watchers.set(workspacePath, watcher);
  console.log(`[usage] transcript watcher ligado para ${workspacePath}`);
}

function onSessionDictated(info: DictatedSessionInfo): void {
  dictated.set(info.providerSessionId, {
    ptySessionId: info.ptySessionId,
    adapterId: info.adapterId,
    cwd: info.cwd,
  });
  // O cwd do spawn de agente é o workspace — liga o watcher na primeira vez.
  watchWorkspaceUsage(info.cwd);
  // Codex não aceita session id ditado: o scanner global resolve por cwd.
  if (!codexScanner && db) {
    codexScanner = new CodexUsageScanner({
      isWatched: (cwd) => watchers.has(cwd),
      onEvent: (ev, cwd) => {
        if (!db) return;
        try {
          recordUsage(db, { ...ev, paneId: null, missionId: null, workspacePath: cwd });
          scheduleBroadcast();
        } catch (err) {
          console.warn('[usage] recordUsage (codex) falhou:', err);
        }
      },
    });
    codexScanner.start();
    console.log('[usage] codex scanner ligado');
  }
}

export function initUsageTelemetry(): void {
  db = getDb();
  if (!db) {
    console.warn('[usage] SQLite indisponível — telemetria real desativada (fallback: estimativa)');
    return;
  }
  try {
    initUsageStore(db);
    initMediaUsageStore(db);
  } catch (err) {
    console.warn('[usage] schema falhou — telemetria real desativada:', err);
    db = null;
    return;
  }
  setSessionDictationHook(onSessionDictated);
  setResumeSessionLookup(
    (cwd, paneId) => getProviderSession(cwd, paneId)?.sessionId ?? null,
  );
  ipcMain.handle(USAGE_CHANNELS.snapshot, (): UsageSnapshot => buildSnapshot());
}

export function shutdownUsageTelemetry(): void {
  for (const watcher of watchers.values()) watcher.stop();
  watchers.clear();
  codexScanner?.stop();
  codexScanner = null;
  setSessionDictationHook(null);
  setResumeSessionLookup(null);
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = null;
}
