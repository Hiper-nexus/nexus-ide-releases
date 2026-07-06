import { dialog, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import fs from 'node:fs';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import {
  missionPatchSchema,
  browserPaneOpenResultSchema,
  orchPaneSpawnResultSchema,
  panesSyncSchema,
  squadSchema,
} from '../../shared/orch-types';
import { getDb } from '../persistence/db';
import { initSquadStore, listSquads, saveSquad, deleteSquad, onSquadsChange, exportSquadsJson, importSquadsJson } from './squad-store';
import { designSquadForWorkspace } from './squad-architect';
import {
  initMissionStore,
  listMissions,
  onMissionsChange,
  setMissionOrchestratorSession,
  updateMission,
  removeMission,
} from './mission-store';
import { initMissionPaneStore, listMissionPanes } from './mission-pane-store';
import { initHandoffStore, listHandoffs, onHandoffsChange } from './handoff-store';
import { initTodoStore, listTodoLists, onTodosChange, setItemStatus } from './todo-store';
import { initTaskStore } from './task-store';
import {
  initPaneRegistry,
  registerOrchRenderer,
  resolveBrowserOpen,
  resolvePaneSpawn,
  syncPanes,
  unregisterOrchRenderer,
} from './pane-registry';
import { initIdleDelivery } from './idle-delivery';
import { initStallWatchdog, shutdownStallWatchdog } from './stall-watchdog';
import { stopAllPreviews } from './preview-server';
import { startRemoteBridge, stopRemoteBridge } from '../remote/remote-bridge';
import { buildRecipeOverlay } from './recipe-overlay';
import { proposeRecipes, saveCatalogOverlay } from './catalog-overlay';
import { writeAgentSpec } from './agent-spec-writer';
import {
  getMcpRuntimeInfo,
  getToolCatalog,
  startMcpServer,
  stopMcpServer,
} from './mcp-server';
import {
  getCatalogIndex,
  installCatalogItem,
  listHookHomes,
  listInstalledCatalogItems,
  listPluginFiles,
} from './catalog';
import { z } from 'zod';

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
  initMissionPaneStore(db);
  initHandoffStore(db);
  initTodoStore(db);
  initTaskStore(db);
  initPaneRegistry();
  initIdleDelivery();
  initStallWatchdog();
  await startMcpServer();
  void startRemoteBridge().catch((err) =>
    console.warn('[remote] bridge failed to start:', err),
  );

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
  shutdownStallWatchdog();
  stopAllPreviews();
  stopRemoteBridge();
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

  ipcMain.on(ORCH_CHANNELS.browserOpenResult, (_event, raw) => {
    const parsed = browserPaneOpenResultSchema.safeParse(raw);
    if (parsed.success) resolveBrowserOpen(parsed.data);
  });

  ipcMain.handle(ORCH_CHANNELS.missionsList, () => listMissions());
  ipcMain.handle(ORCH_CHANNELS.missionPanesList, (_event, raw) => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) {
      return [];
    }
    return listMissionPanes(raw);
  });

  const missionRebindSchema = z.object({
    missionId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
  });
  ipcMain.handle(ORCH_CHANNELS.missionRebind, (_event, raw) => {
    const parsed = missionRebindSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    const mission = setMissionOrchestratorSession(
      parsed.data.missionId,
      parsed.data.sessionId,
    );
    return { ok: mission !== null };
  });

  const missionUpdateSchema = z.object({
    missionId: z.string().min(1).max(128),
    patch: missionPatchSchema,
  });
  ipcMain.handle(ORCH_CHANNELS.missionUpdate, (_event, raw) => {
    const parsed = missionUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('invalid mission update payload');
    }
    const mission = updateMission(parsed.data.missionId, parsed.data.patch);
    if (!mission) {
      throw new Error('mission not found');
    }
    return mission;
  });

  ipcMain.handle(ORCH_CHANNELS.missionRemove, (_event, raw) => {
    const missionId = typeof raw === 'string' ? raw : '';
    if (!missionId) throw new Error('invalid mission id');
    return { removed: removeMission(missionId) };
  });

  ipcMain.handle(ORCH_CHANNELS.handoffsList, () =>
    listHandoffs({ includeDelivered: true }),
  );
  ipcMain.handle(ORCH_CHANNELS.todosGet, () => listTodoLists());

  const todoSetStatusSchema = z.object({
    listId: z.string().min(1).max(128),
    itemId: z.string().min(1).max(128),
    status: z.enum(['todo', 'in_progress', 'done']),
  });
  ipcMain.handle(ORCH_CHANNELS.todoSetStatus, (_event, raw) => {
    const parsed = todoSetStatusSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('invalid todo status payload');
    }
    const list = setItemStatus(
      parsed.data.listId,
      parsed.data.itemId,
      parsed.data.status,
    );
    if (!list) {
      throw new Error('todo list or item not found');
    }
    return list;
  });
  ipcMain.handle(ORCH_CHANNELS.squadsList, () => listSquads());
  ipcMain.handle(ORCH_CHANNELS.squadDesign, async (_event, raw: unknown) => {
    const wsPath = typeof raw === 'string' && raw.length > 0 && raw.length < 1024 ? raw : null;
    if (!wsPath) return { ok: false, error: 'workspace inválido' };
    try {
      return await designSquadForWorkspace(wsPath);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
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

  const catalogIndexSchema = z.object({ refresh: z.boolean().optional() });
  const catalogInstallSchema = z.object({
    kind: z.enum(['agent', 'skill']),
    slug: z.string().min(1).max(256),
  });

  ipcMain.handle(ORCH_CHANNELS.catalogIndex, async (_event, raw) => {
    const parsed = catalogIndexSchema.safeParse(raw ?? {});
    return getCatalogIndex(parsed.success ? parsed.data.refresh : false);
  });

  ipcMain.handle(ORCH_CHANNELS.catalogInstall, async (_event, raw) => {
    const parsed = catalogInstallSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'invalid catalog install request' };
    }
    return installCatalogItem(parsed.data);
  });

  const recipeOverlaySchema = z.object({
    workspacePath: z.string().min(1).max(4096).optional(),
  });
  ipcMain.handle(ORCH_CHANNELS.recipeOverlay, (_event, raw) => {
    const parsed = recipeOverlaySchema.safeParse(raw ?? {});
    return buildRecipeOverlay(parsed.success ? parsed.data.workspacePath : undefined);
  });

  const catalogOverlaySaveSchema = z.object({
    workspacePath: z.string().min(1).max(4096).optional(),
    stacks: z.array(z.string().min(1).max(64)).max(32).optional(),
    disabled: z.array(z.string().min(1).max(128)).max(512).optional(),
    tombstones: z.array(z.string().min(1).max(128)).max(512).optional(),
    categories: z.record(z.string().min(1).max(128), z.string().min(1).max(128)).optional(),
  });
  ipcMain.handle(ORCH_CHANNELS.catalogOverlaySave, (_event, raw) => {
    const parsed = catalogOverlaySaveSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new Error('invalid catalog overlay');
    return saveCatalogOverlay(parsed.data);
  });

  ipcMain.handle(ORCH_CHANNELS.recipePropose, (_event, raw) => {
    const parsed = recipeOverlaySchema.safeParse(raw ?? {});
    return proposeRecipes(parsed.success ? parsed.data.workspacePath : undefined);
  });

  const agentSpecWriteSchema = z.object({
    name: z.string().min(1).max(96),
    tools: z.array(z.string().min(1).max(128)).max(128).optional(),
    skills: z.array(z.string().min(1).max(128)).max(128).optional(),
    model: z.string().max(128).optional(),
    effort: z.string().max(32).optional(),
    category: z.string().max(64).optional(),
    systemPrompt: z.string().max(65_536).optional(),
  });
  ipcMain.handle(ORCH_CHANNELS.agentSpecWrite, (_event, raw) => {
    const parsed = agentSpecWriteSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid agent spec' };
    return writeAgentSpec(parsed.data);
  });

  ipcMain.handle(ORCH_CHANNELS.catalogInstalled, () =>
    listInstalledCatalogItems(),
  );
  ipcMain.handle(ORCH_CHANNELS.toolsList, () => getToolCatalog());
  ipcMain.handle(ORCH_CHANNELS.pluginsList, () => listPluginFiles());
  ipcMain.handle(ORCH_CHANNELS.hooksList, () => listHookHomes());

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
