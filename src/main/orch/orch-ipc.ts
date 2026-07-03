import { dialog, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import fs from 'node:fs';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import {
  orchPaneSpawnResultSchema,
  panesSyncSchema,
  squadSchema,
} from '../../shared/orch-types';
import { getDb } from '../persistence/db';
import { initSquadStore, listSquads, saveSquad, deleteSquad, onSquadsChange, exportSquadsJson, importSquadsJson } from './squad-store';
import { initMissionStore, listMissions, onMissionsChange } from './mission-store';
import { initHandoffStore, listHandoffs, onHandoffsChange } from './handoff-store';
import { initTodoStore, listTodoLists, onTodosChange } from './todo-store';
import { initTaskStore } from './task-store';
import {
  initPaneRegistry,
  registerOrchRenderer,
  resolvePaneSpawn,
  syncPanes,
  unregisterOrchRenderer,
} from './pane-registry';
import { initIdleDelivery } from './idle-delivery';
import { getMcpRuntimeInfo, startMcpServer, stopMcpServer } from './mcp-server';

/**
 * Renderer-facing IPC for the orchestration domain, plus the domain
 * bootstrap. Every renderer payload is zod-validated at this boundary.
 */

const listeners = new Set<WebContents>();

function broadcast(channel: string, payload: unknown): void {
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(channel, payload);
  }
}

export function registerOrchListener(wc: WebContents): void {
  listeners.add(wc);
  registerOrchRenderer(wc);
}

export function unregisterOrchListener(wc: WebContents): void {
  listeners.delete(wc);
  unregisterOrchRenderer(wc);
}

/** Boot the whole orchestration domain (stores → registry → MCP server). */
export async function initOrchestration(): Promise<void> {
  const db = getDb();
  initSquadStore(db);
  initMissionStore(db);
  initHandoffStore(db);
  initTodoStore(db);
  initTaskStore(db);
  initPaneRegistry();
  initIdleDelivery();
  await startMcpServer();

  onMissionsChange(() =>
    broadcast(ORCH_CHANNELS.missionsChanged, listMissions()),
  );
  onHandoffsChange(() =>
    broadcast(
      ORCH_CHANNELS.handoffsChanged,
      listHandoffs({ includeDelivered: true }),
    ),
  );
  onTodosChange(() => broadcast(ORCH_CHANNELS.todosChanged, listTodoLists()));
  onSquadsChange(() => broadcast(ORCH_CHANNELS.squadsChanged, listSquads()));
}

export function closeOrchestration(): void {
  stopMcpServer();
}

export function registerOrchIpc(): void {
  ipcMain.on(ORCH_CHANNELS.panesSync, (_event, raw) => {
    const parsed = panesSyncSchema.safeParse(raw);
    if (parsed.success) syncPanes(parsed.data);
  });

  ipcMain.on(ORCH_CHANNELS.paneSpawnResult, (_event, raw) => {
    const parsed = orchPaneSpawnResultSchema.safeParse(raw);
    if (parsed.success) resolvePaneSpawn(parsed.data);
  });

  ipcMain.handle(ORCH_CHANNELS.missionsList, () => listMissions());
  ipcMain.handle(ORCH_CHANNELS.handoffsList, () =>
    listHandoffs({ includeDelivered: true }),
  );
  ipcMain.handle(ORCH_CHANNELS.todosGet, () => listTodoLists());
  ipcMain.handle(ORCH_CHANNELS.squadsList, () => listSquads());
  ipcMain.handle(ORCH_CHANNELS.mcpInfo, () => getMcpRuntimeInfo());

  ipcMain.handle(ORCH_CHANNELS.squadSave, (_event, raw) => {
    const parsed = squadSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'invalid squad payload' };
    }
    try {
      saveSquad(parsed.data);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'failed to save squad',
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.squadDelete, (_event, raw) => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) {
      return { ok: false };
    }
    return { ok: deleteSquad(raw) };
  });

  ipcMain.handle(ORCH_CHANNELS.squadExport, async () => {
    const result = await dialog.showSaveDialog({
      title: 'Export squads',
      defaultPath: 'nexus-squads.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    try {
      fs.writeFileSync(result.filePath, exportSquadsJson(), 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'failed to write file',
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.squadImport, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import squads',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    try {
      const json = fs.readFileSync(result.filePaths[0], 'utf8');
      const count = importSquadsJson(json);
      return { ok: true, count };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : 'failed to import squads file',
      };
    }
  });
}
