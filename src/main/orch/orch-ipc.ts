import { BrowserWindow, dialog, ipcMain } from "electron";
import type { WebContents } from "electron";
import fs from "node:fs";
import { ORCH_CHANNELS } from "../../shared/orch-channels";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  missionPatchSchema,
  browserPaneOpenResultSchema,
  orchPaneSpawnResultSchema,
  panesSyncSchema,
  squadSchema,
} from "../../shared/orch-types";
import { getDb } from "../persistence/db";
import type { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  requireLiveRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";
import {
  initSquadStore,
  listSquads,
  saveSquad,
  deleteSquad,
  onSquadsChange,
  exportSquadsJson,
  importSquadsJson,
} from "./squad-store";
import {
  designSquadForWorkspace,
  designSquadFromIntent,
} from "./squad-architect";
import {
  loadEnrichedCatalog,
  runHarnessEnrichWithBrain,
} from "./harness-enrich";
import {
  initPaneRegistry,
  registerOrchRenderer,
  resolveBrowserOpen,
  resolvePaneSpawn,
  syncPanes,
  unregisterOrchRenderer,
} from "./pane-registry";
import { RendererMissionAuthority } from "./renderer-mission-authority";
import {
  ProjectDomainStoreRegistry,
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  type ProjectDomainStoreSuite,
  type ProjectDomainStoreName,
} from "./project-domain-store-registry";
import { broadcastToProject } from "./project-scoped-broadcast";
import { initIdleDelivery } from "./idle-delivery";
import { initStallWatchdog, shutdownStallWatchdog } from "./stall-watchdog";
import { stopAllPreviews } from "./preview-server";
import { stopRemoteBridge } from "../remote/remote-bridge";
import { buildRecipeOverlay } from "./recipe-overlay";
import { proposeRecipes, saveCatalogOverlay } from "./catalog-overlay";
import {
  writeAgentSpec,
  type AgentSpecPatch,
} from "./agent-spec-writer";
import {
  confirmationReason,
  requiresConfirmation,
} from "../jarvis/guardrails";
import {
  getMcpRuntimeInfo,
  getToolCatalog,
  startMcpServer,
  stopMcpServer,
} from "./mcp-server";
import {
  getCatalogIndex,
  installCatalogItem,
  listHookHomes,
  listInstalledCatalogItems,
  listPluginFiles,
} from "./catalog";
import { z } from "zod";

/**
 * Renderer-facing IPC for the orchestration domain, plus the domain
 * bootstrap. Every renderer payload is zod-validated at this boundary.
 */

const listeners = new Set<WebContents>();
let rendererMissionAuthority: RendererMissionAuthority | null = null;
let projectDomainStores: ProjectDomainStoreRegistry | null = null;

const agentSpecWriteSchema = z.object({
  name: z.string().min(1).max(96),
  tools: z.array(z.string().min(1).max(128)).max(128).optional(),
  skills: z.array(z.string().min(1).max(128)).max(128).optional(),
  model: z.string().max(128).optional(),
  effort: z.string().max(32).optional(),
  category: z.string().max(64).optional(),
  systemPrompt: z.string().max(65_536).optional(),
});
const AGENT_SPEC_WRITE_TOOL = "nexus_agent_spec_write";

function safeDialogLabel(value: string, maxChars = 256): string {
  return value
    .replace(/[\0-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .trim()
    .slice(0, maxChars);
}

async function confirmAgentSpecWrite(
  owner: WebContents,
  scope: ProjectExecutionScope,
  patch: AgentSpecPatch,
): Promise<boolean> {
  const args: Record<string, unknown> = { ...patch };
  if (!requiresConfirmation(AGENT_SPEC_WRITE_TOOL, args)) {
    throw new Error("agent spec confirmation policy is unavailable");
  }
  const window = BrowserWindow.fromWebContents(owner);
  if (!window || window.isDestroyed()) {
    throw new Error("renderer window is unavailable");
  }
  const fields = ["tools", "skills", "model", "effort", "category", "systemPrompt"]
    .filter((field) => args[field] !== undefined)
    .join(", ");
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Nexus IDE — autorização de agente",
    buttons: ["Negar", "Permitir"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: "Gravar especificação global de agente?",
    detail:
      `Workspace solicitante: ${safeDialogLabel(scope.rootRealPath, 512)}\n` +
      `Agente: ${safeDialogLabel(patch.name, 96)}\n` +
      `Campos alterados: ${fields || "nenhum"}\n` +
      `Motivo: ${confirmationReason(AGENT_SPEC_WRITE_TOOL, args)}\n\n` +
      "O conteúdo do system prompt não é exibido neste diálogo.",
  });
  return result.response === 1;
}

export function configureRendererMissionAuthority(
  runtimeManager: ProjectRuntimeManager,
): void {
  projectDomainStores = configureProjectDomainStoreRegistry(runtimeManager);
  rendererMissionAuthority = new RendererMissionAuthority(projectDomainStores);
  projectDomainStores.onChange((scope, store) => {
    broadcastProjectStore(scope, store);
  });
}

function requireMissionAuthority(): RendererMissionAuthority {
  if (!rendererMissionAuthority) {
    throw new Error("project-scoped mission authority is not initialized");
  }
  return rendererMissionAuthority;
}

function requireProjectStores(owner: WebContents): ProjectDomainStoreSuite {
  if (!projectDomainStores) {
    throw new Error("project-scoped domain stores are not initialized");
  }
  return projectDomainStores.forScope(requireRendererWorkspaceScope(owner));
}

function broadcastProjectStore(
  scope: ReturnType<typeof requireRendererWorkspaceScope>,
  store: ProjectDomainStoreName,
): void {
  if (!projectDomainStores) return;
  const suite = projectDomainStores.forScope(scope);
  if (store === "missions") {
    broadcastToProject(
      listeners,
      scope,
      ORCH_CHANNELS.missionsChanged,
      suite.missions.list(),
    );
  } else if (store === "handoffs") {
    broadcastToProject(
      listeners,
      scope,
      ORCH_CHANNELS.handoffsChanged,
      suite.handoffs.list({ includeDelivered: true }),
    );
  } else if (store === "todos") {
    broadcastToProject(
      listeners,
      scope,
      ORCH_CHANNELS.todosChanged,
      suite.todos.list(),
    );
  }
}

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
  initPaneRegistry();
  initIdleDelivery();
  initStallWatchdog();
  await startMcpServer();
  // SEGURANÇA: a remote bridge NÃO sobe no boot — só sob demanda, via IPC
  // explícito do usuário (remote:bridge.start) ou pela tool MCP dedicada.

  onSquadsChange(() => broadcast(ORCH_CHANNELS.squadsChanged, listSquads()));
}

export function closeOrchestration(): void {
  shutdownStallWatchdog();
  stopAllPreviews();
  stopRemoteBridge();
  stopMcpServer();
  disposeProjectDomainStoreRegistry();
  projectDomainStores = null;
  rendererMissionAuthority = null;
}

export function registerOrchIpc(): void {
  ipcMain.on(ORCH_CHANNELS.panesSync, (event, raw) => {
    const parsed = panesSyncSchema.safeParse(raw);
    if (parsed.success) {
      syncPanes(parsed.data, event.sender);
      for (const pane of parsed.data) {
        rendererMissionAuthority?.restorePersistedPaneAuthority(
          event.sender,
          pane.paneId,
        );
      }
    }
  });

  ipcMain.on(ORCH_CHANNELS.paneSpawnResult, (event, raw) => {
    const parsed = orchPaneSpawnResultSchema.safeParse(raw);
    if (parsed.success) resolvePaneSpawn(parsed.data, event.sender);
  });

  ipcMain.on(ORCH_CHANNELS.browserOpenResult, (event, raw) => {
    const parsed = browserPaneOpenResultSchema.safeParse(raw);
    if (parsed.success) resolveBrowserOpen(parsed.data, event.sender);
  });

  ipcMain.handle(ORCH_CHANNELS.missionsList, (event) =>
    requireProjectStores(event.sender).missions.list(),
  );
  ipcMain.handle(ORCH_CHANNELS.missionPanesList, (event, raw) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
      return [];
    }
    return requireMissionAuthority().listMissionPanesForRenderer(
      event.sender,
      raw,
    );
  });

  // A missão nasce NO LANÇAMENTO (renderer), não à mercê de o LLM chamar
  // nexus_mission_create — sem isto, a missão nova não aparecia em lugar
  // nenhum enquanto a antiga já tinha sido deslocada.
  const missionCreateSchema = z.object({
    title: z.string().min(1).max(512),
    squadId: z.string().min(1).max(128),
    /** Pane do orquestrador — entra na composição para o reopen restaurá-lo. */
    orchestratorPane: z.object({
      paneId: z.string().min(1).max(128),
      adapterId: z.string().min(1).max(128).optional(),
      model: z.string().max(128).optional(),
      accountId: z.string().max(128).optional(),
      cwd: z.string().max(4096).optional(),
      title: z.string().max(512).optional(),
      agentName: z.string().max(256).optional(),
    }),
  });
  ipcMain.handle(ORCH_CHANNELS.missionCreate, (event, raw) => {
    const parsed = missionCreateSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid mission create payload");
    return requireMissionAuthority().createMissionFromRenderer(
      event.sender,
      parsed.data,
    );
  });

  const missionRebindSchema = z.object({
    missionId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
  });
  ipcMain.handle(ORCH_CHANNELS.missionRebind, (event, raw) => {
    const parsed = missionRebindSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    const mission = requireMissionAuthority().rebindMissionFromRenderer(
      event.sender,
      parsed.data.missionId,
      parsed.data.sessionId,
    );
    return { ok: mission !== null };
  });

  const missionUpdateSchema = z.object({
    missionId: z.string().min(1).max(128),
    patch: missionPatchSchema,
  });
  ipcMain.handle(ORCH_CHANNELS.missionUpdate, (event, raw) => {
    const parsed = missionUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid mission update payload");
    }
    const mission = requireMissionAuthority().updateMissionFromRenderer(
      event.sender,
      parsed.data.missionId,
      parsed.data.patch,
    );
    if (!mission) {
      throw new Error("mission not found");
    }
    return mission;
  });

  ipcMain.handle(ORCH_CHANNELS.missionRemove, (event, raw) => {
    const stores = requireProjectStores(event.sender);
    const missionId = typeof raw === "string" ? raw : "";
    if (!missionId) throw new Error("invalid mission id");
    return { removed: stores.missions.remove(missionId) };
  });

  ipcMain.handle(ORCH_CHANNELS.handoffsList, (event) =>
    requireProjectStores(event.sender).handoffs.list({
      includeDelivered: true,
    }),
  );
  ipcMain.handle(ORCH_CHANNELS.todosGet, (event) =>
    requireProjectStores(event.sender).todos.list(),
  );

  const todoSetStatusSchema = z.object({
    listId: z.string().min(1).max(128),
    itemId: z.string().min(1).max(128),
    status: z.enum(["todo", "in_progress", "done"]),
  });
  ipcMain.handle(ORCH_CHANNELS.todoSetStatus, (event, raw) => {
    const stores = requireProjectStores(event.sender);
    const parsed = todoSetStatusSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("invalid todo status payload");
    }
    const list = stores.todos.setItemStatus(
      parsed.data.listId,
      parsed.data.itemId,
      parsed.data.status,
    );
    if (!list) {
      throw new Error("todo list or item not found");
    }
    return list;
  });
  ipcMain.handle(ORCH_CHANNELS.squadsList, () => listSquads());
  ipcMain.handle(ORCH_CHANNELS.squadDesign, async (event, raw: unknown) => {
    // O workspace é autoridade do processo principal. O payload legado ainda
    // é aceito por compatibilidade, mas nunca escolhe o projeto analisado.
    const wsPath = requireRendererWorkspaceScope(event.sender).rootRealPath;
    let intent: string | undefined;
    if (raw && typeof raw === "object") {
      const obj = raw as { intent?: unknown };
      if (typeof obj.intent === "string" && obj.intent.trim().length > 0) {
        intent = obj.intent.slice(0, 4_000);
      }
    }
    try {
      return intent
        ? await designSquadFromIntent(intent, wsPath)
        : await designSquadForWorkspace(wsPath);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  ipcMain.handle(ORCH_CHANNELS.mcpInfo, () => getMcpRuntimeInfo());

  ipcMain.handle(ORCH_CHANNELS.squadSave, (_event, raw) => {
    const parsed = squadSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid squad payload" };
    }
    try {
      saveSquad(parsed.data);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "failed to save squad",
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.squadDelete, (_event, raw) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
      return { ok: false };
    }
    return { ok: deleteSquad(raw) };
  });

  ipcMain.handle(ORCH_CHANNELS.squadExport, async () => {
    const result = await dialog.showSaveDialog({
      title: "Export squads",
      defaultPath: "nexus-squads.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    try {
      fs.writeFileSync(result.filePath, exportSquadsJson(), "utf8");
      return { ok: true, path: result.filePath };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "failed to write file",
      };
    }
  });

  const catalogIndexSchema = z.object({ refresh: z.boolean().optional() });
  const catalogInstallSchema = z.object({
    kind: z.enum(["agent", "skill"]),
    slug: z.string().min(1).max(256),
  });

  ipcMain.handle(ORCH_CHANNELS.catalogIndex, async (_event, raw) => {
    const parsed = catalogIndexSchema.safeParse(raw ?? {});
    return getCatalogIndex(parsed.success ? parsed.data.refresh : false);
  });

  ipcMain.handle(ORCH_CHANNELS.catalogInstall, async (_event, raw) => {
    const parsed = catalogInstallSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "invalid catalog install request" };
    }
    return installCatalogItem(parsed.data);
  });

  const recipeOverlaySchema = z.object({
    workspacePath: z.string().min(1).max(4096).optional(),
  });
  ipcMain.handle(ORCH_CHANNELS.recipeOverlay, (_event, raw) => {
    const parsed = recipeOverlaySchema.safeParse(raw ?? {});
    return buildRecipeOverlay(
      parsed.success ? parsed.data.workspacePath : undefined,
    );
  });

  const catalogOverlaySaveSchema = z.object({
    workspacePath: z.string().min(1).max(4096).optional(),
    stacks: z.array(z.string().min(1).max(64)).max(32).optional(),
    disabled: z.array(z.string().min(1).max(128)).max(512).optional(),
    tombstones: z.array(z.string().min(1).max(128)).max(512).optional(),
    categories: z
      .record(z.string().min(1).max(128), z.string().min(1).max(128))
      .optional(),
  });
  ipcMain.handle(ORCH_CHANNELS.catalogOverlaySave, (_event, raw) => {
    const parsed = catalogOverlaySaveSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new Error("invalid catalog overlay");
    return saveCatalogOverlay(parsed.data);
  });

  ipcMain.handle(ORCH_CHANNELS.recipePropose, (_event, raw) => {
    const parsed = recipeOverlaySchema.safeParse(raw ?? {});
    return proposeRecipes(
      parsed.success ? parsed.data.workspacePath : undefined,
    );
  });

  ipcMain.handle(ORCH_CHANNELS.agentSpecWrite, async (event, raw) => {
    const scope = requireLiveRendererWorkspaceScope(event.sender);
    const parsed = agentSpecWriteSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: "invalid agent spec" };
    const approved = await confirmAgentSpecWrite(
      event.sender,
      scope,
      parsed.data,
    );
    if (!approved) return { ok: false, error: "user_denied" };
    requireLiveRendererWorkspaceScope(event.sender, scope);
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
      title: "Import squads",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false };
    try {
      const json = fs.readFileSync(result.filePaths[0], "utf8");
      const count = importSquadsJson(json);
      return { ok: true, count };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "failed to import squads file",
      };
    }
  });
}
