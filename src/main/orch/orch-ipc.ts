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
import {
  designSquadForWorkspace,
  designSquadFromIntent,
} from './squad-architect';
import {
  loadEnrichedCatalog,
  runHarnessEnrichWithBrain,
} from './harness-enrich';
import {
  createMission,
  initMissionStore,
  listMissions,
  onMissionsChange,
  setMissionOrchestratorSession,
  updateMission,
  removeMission,
} from './mission-store';
import {
  initMissionPaneStore,
  listMissionPanes,
  recordMissionPane,
} from './mission-pane-store';
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
import { stopRemoteBridge } from '../remote/remote-bridge';
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
    // isDestroyed() sozinho não basta: renderer recém-crashado ainda reporta
    // false e o send() loga "Render frame was disposed" (mesmo padrão do
    // canSend em pty-manager).
    if (!wc.isDestroyed() && !wc.isCrashed()) wc.send(channel, payload);
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
  // SEGURANÇA: a remote bridge NÃO sobe no boot — só sob demanda, via IPC
  // explícito do usuário (remote:bridge.start) ou pela tool MCP dedicada.

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

  // A missão nasce NO LANÇAMENTO (renderer), não à mercê de o LLM chamar
  // nexus_mission_create — sem isto, a missão nova não aparecia em lugar
  // nenhum enquanto a antiga já tinha sido deslocada.
  const missionCreateSchema = z.object({
    title: z.string().min(1).max(512),
    squadId: z.string().min(1).max(128).optional(),
    /** Pane do orquestrador — entra na composição para o reopen restaurá-lo. */
    orchestratorPane: z
      .object({
        paneId: z.string().min(1).max(128),
        adapterId: z.string().min(1).max(128),
        model: z.string().max(128).optional(),
        cwd: z.string().max(4096).optional(),
        title: z.string().max(512).optional(),
        agentName: z.string().max(256).optional(),
      })
      .optional(),
  });
  ipcMain.handle(ORCH_CHANNELS.missionCreate, (_event, raw) => {
    const parsed = missionCreateSchema.safeParse(raw);
    if (!parsed.success) throw new Error('invalid mission create payload');
    const mission = createMission({
      title: parsed.data.title,
      squadId: parsed.data.squadId,
    });
    const pane = parsed.data.orchestratorPane;
    if (pane) {
      recordMissionPane({
        missionId: mission.id,
        adapterId: pane.adapterId,
        model: pane.model,
        cwd: pane.cwd,
        title: pane.title,
        agentName: pane.agentName,
        role: 'orchestrator',
        paneId: pane.paneId,
      });
    }
    return mission;
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
    // Aceita string (legado: workspace-driven) ou {workspacePath, intent?}
    // (modo Agêntico: intenção em linguagem natural).
    let wsPath: string | null = null;
    let intent: string | undefined;
    if (typeof raw === 'string') {
      wsPath = raw.length > 0 && raw.length < 1024 ? raw : null;
    } else if (raw && typeof raw === 'object') {
      const obj = raw as { workspacePath?: unknown; intent?: unknown };
      if (
        typeof obj.workspacePath === 'string' &&
        obj.workspacePath.length > 0 &&
        obj.workspacePath.length < 1024
      ) {
        wsPath = obj.workspacePath;
      }
      if (typeof obj.intent === 'string' && obj.intent.trim().length > 0) {
        intent = obj.intent.slice(0, 4_000);
      }
    }
    if (!wsPath) return { ok: false, error: 'workspace inválido' };
    try {
      return intent
        ? await designSquadFromIntent(intent, wsPath)
        : await designSquadForWorkspace(wsPath);
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
  ipcMain.handle(ORCH_CHANNELS.harnessEnriched, () => loadEnrichedCatalog());
  ipcMain.handle(ORCH_CHANNELS.harnessEnrich, async () => {
    try {
      const catalog = await runHarnessEnrichWithBrain();
      return { ok: true, catalog };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
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
