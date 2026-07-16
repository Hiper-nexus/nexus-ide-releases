/**
 * Product-wave IPC: memory, skills, MCP hub, autonomy, search, feature flags,
 * editor document model. All paths respect fail-closed, default-off flags.
 */
import { BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PRODUCT_WAVE_CHANNELS } from '../shared/channels';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';
import {
  MCP_HUB_SYNC_EXPORT_TOOL_ENUM,
  MCP_HUB_SYNC_EXPORT_TOOLS,
} from '../shared/mcp-hub-sync-api';
import { getFeatureFlagRegistry } from './feature-flags/feature-flag-registry';
import {
  decideAutonomy,
  autonomyProfileSchema,
} from './autonomy/autonomy-profiles';
import {
  listMemoryNotes,
  rememberMarkdown,
  searchMemory,
  backlinks,
  wikilinkCompletions,
} from './memory/nexus-memory';
import {
  scanSkillsDirectory,
  skillsLockSchema,
  writeSkillsLock,
  type SkillsLock,
} from './skills/skills-catalog';
import {
  detectDrift,
  maskServerForUi,
  mcpHubConfigSchema,
  restoreMaskedSecrets,
  toolMatrix,
  writeConfigWithBackup,
  rollbackFromBackup,
  healthForServer,
  type McpHubConfig,
} from './mcp-hub/mcp-hub-core';
import { observeAcrossTools } from './mcp-hub/mcp-hub-observers';
import { applyMcpSync, planMcpSync } from './mcp-hub/mcp-hub-sync';
import { isInsidePath } from './orch/workspace-path';
import {
  openEditorDocument,
  applyEdit,
  assertExpectedContentHash,
  markSaved,
  MAX_EDITOR_CHARS,
} from './editor/editor-document';
import {
  publishEditorDocumentApply,
  publishEditorDocumentOpen,
} from './editor/editor-buffer-bridge';
import { writeFileAtomic } from './util/atomic-write';
import { runSearchMixerQuery } from './search/search-mixer-bootstrap';
import {
  requireScopedRoot,
  resolveScopedPath,
  resolveSubdirUnderRoot,
  tryResolveSubdirUnderRoot,
} from './security/scoped-workspace-fs';

export { PRODUCT_WAVE_CHANNELS };

function workspaceRoot(sender: Electron.WebContents): string {
  return requireScopedRoot(sender).root;
}

/** Missing is a valid new document; every other read failure is fail-closed. */
export function readEditorBytesOrEmpty(filePath: string): Buffer {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Buffer.from('');
    }
    throw error;
  }
}

function mcpHubPath(root: string): string {
  return path.join(resolveSubdirUnderRoot(root, '.nexus'), 'mcp-hub.json');
}

/**
 * Fail-closed: .bak must be a regular file under the workspace `.nexus/` dir
 * and must be a backup of the hub config (basename prefix of mcp-hub.json).
 * Exported for unit tests of the product rollback path.
 */
export function assertWorkspaceMcpHubBackup(
  workspaceRoot: string,
  backupPath: string,
): string {
  const root = fs.realpathSync(path.resolve(workspaceRoot));
  const hubPath = mcpHubPath(root);
  const nexusDir = fs.realpathSync(path.dirname(hubPath));
  let resolvedBak = path.resolve(backupPath);
  if (!resolvedBak.endsWith('.bak')) {
    throw new Error('invalid backup path for workspace MCP hub');
  }
  if (!fs.existsSync(resolvedBak) || !fs.lstatSync(resolvedBak).isFile()) {
    throw new Error('backup missing');
  }
  resolvedBak = fs.realpathSync(resolvedBak);
  const hubBase = path.basename(hubPath); // mcp-hub.json
  const bakBase = path.basename(resolvedBak);
  if (
    !bakBase.startsWith(`${hubBase}.`) ||
    !isInsidePath(nexusDir, resolvedBak) ||
    !isInsidePath(root, resolvedBak)
  ) {
    throw new Error('invalid backup path for workspace MCP hub');
  }
  return resolvedBak;
}

/** Workspace-scoped skill roots only — never $HOME (cross-project leak). */
function skillsDirs(root: string): string[] {
  return [
    tryResolveSubdirUnderRoot(root, path.join('.claude', 'skills')),
    tryResolveSubdirUnderRoot(root, path.join('.nexus', 'skills')),
  ].filter((d): d is string => d != null);
}

function requireFlag(id: string, label: string): void {
  if (!getFeatureFlagRegistry().isEnabled(id)) {
    throw new Error(`${label} is disabled`);
  }
}

function loadMcpHub(root: string): McpHubConfig {
  const file = mcpHubPath(root);
  if (!fs.existsSync(file)) {
    return mcpHubConfigSchema.parse({ schemaVersion: 1, servers: [] });
  }
  try {
    if (!fs.lstatSync(file).isFile()) {
      return mcpHubConfigSchema.parse({ schemaVersion: 1, servers: [] });
    }
    return mcpHubConfigSchema.parse(
      JSON.parse(fs.readFileSync(file, 'utf8') as string),
    );
  } catch {
    // Fail-closed: corrupt config does not take down IPC.
    return mcpHubConfigSchema.parse({ schemaVersion: 1, servers: [] });
  }
}

function listFlagResolutions(): Array<{
  id: string;
  enabled: boolean;
  reason: string;
  definition: unknown;
}> {
  const reg = getFeatureFlagRegistry();
  return reg.list().map((f) => {
    // Uma única resolução por flag (evita telemetria dupla e enabled/reason
    // vindos de avaliações distintas).
    const r = reg.resolve(f.id);
    return { id: f.id, enabled: r.enabled, reason: r.reason, definition: f };
  });
}

/**
 * Flags são um gate de PRODUTO e qualquer renderer confiável pode alterná-las
 * — mas só a webContents de uma janela do app (não um WebContentsView de pane
 * de browser, que carrega web arbitrária) pode mutar/persistir o estado global.
 */
function assertTrustedFlagSender(event: Electron.IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender)) {
    throw new Error('untrusted sender for feature flag IPC');
  }
}

const flagOverrideSchema = z
  .object({
    id: z.string().min(1).max(128),
    /** boolean = override explícito; null = limpar (volta ao default). */
    enabled: z.boolean().nullable(),
  })
  .strict();

/**
 * Aplica um override de flag no registry vivo e persiste em disco.
 * Exportada para teste unitário do caminho Labs (ids desconhecidos lançam
 * dentro do registry — fail-closed).
 */
export function applyFlagOverride(input: unknown): Array<{
  id: string;
  enabled: boolean;
  reason: string;
  definition: unknown;
}> {
  const parsed = flagOverrideSchema.parse(input);
  const reg = getFeatureFlagRegistry();
  const prev = reg.peekOverride(parsed.id); // para rollback se o persist falhar
  if (parsed.enabled === null) {
    reg.clearOverride(parsed.id);
  } else {
    reg.setOverride(parsed.id, parsed.enabled);
  }
  try {
    reg.persistOverrides();
  } catch (err) {
    // Persist falhou (disco cheio/permesão): reverte o estado VIVO para não
    // deixar main ≠ disco ≠ UI. O caller propaga o erro; a UI mantém o valor
    // antigo e nada foi gravado.
    if (prev === undefined) reg.clearOverride(parsed.id);
    else reg.setOverride(parsed.id, prev);
    throw err;
  }
  return listFlagResolutions();
}

function broadcastFlagsChanged(list: ReturnType<typeof listFlagResolutions>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    wc.send(PRODUCT_WAVE_CHANNELS.flagsChanged, list);
  }
}

/**
 * Efeito de segurança do override: desligar `feature.remote.relayTransport`
 * enquanto um relay está ativo derruba o transporte — senão o celular pareado
 * segue conectado (fail-open) mesmo com a flag off. A flag gateia só o start;
 * este é o par que faz o desligar valer na hora, como o painel Labs promete.
 */
async function enforceRelayFlagState(): Promise<void> {
  if (getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.remoteRelayTransport)) {
    return;
  }
  try {
    const relay = await import('./remote/relay/companion-relay-transport');
    if (relay.getActiveCompanionRelayHost()) {
      relay.stopCompanionRelayTransport();
    }
  } catch {
    // Módulo de relay indisponível (ex.: contexto de teste) — nada a parar.
  }
}

export function registerProductWaveIpc(): void {
  ipcMain.handle(PRODUCT_WAVE_CHANNELS.flagsList, (event) => {
    assertTrustedFlagSender(event);
    return listFlagResolutions();
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.flagsSetOverride, async (event, raw) => {
    assertTrustedFlagSender(event);
    const list = applyFlagOverride(raw);
    await enforceRelayFlagState();
    broadcastFlagsChanged(list);
    return list;
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.memoryList, (event) => {
    requireFlag(FEATURE_FLAG_IDS.nexusMemory, 'feature.memory.nexusMemory');
    const root = workspaceRoot(event.sender);
    return listMemoryNotes(root);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.memoryRemember, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.nexusMemory, 'feature.memory.nexusMemory');
    const root = workspaceRoot(event.sender);
    const input = z
      .object({
        title: z.string().min(1).max(256),
        body: z.string().max(64_000),
        kind: z.enum(['decision', 'mission', 'agent', 'note']).optional(),
        missionId: z.string().max(128).optional(),
      })
      .parse(raw);
    return rememberMarkdown(root, input);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.memorySearch, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.nexusMemory, 'feature.memory.nexusMemory');
    const root = workspaceRoot(event.sender);
    const { query } = z.object({ query: z.string().max(512) }).parse(raw);
    return searchMemory(root, query);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.memoryBacklinks, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.nexusMemory, 'feature.memory.nexusMemory');
    const root = workspaceRoot(event.sender);
    const { title } = z.object({ title: z.string().min(1).max(256) }).parse(raw);
    return backlinks(root, title);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.memoryComplete, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.nexusMemory, 'feature.memory.nexusMemory');
    const root = workspaceRoot(event.sender);
    const { prefix } = z.object({ prefix: z.string().max(128) }).parse(raw);
    return wikilinkCompletions(root, prefix);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.skillsList, (event) => {
    requireFlag(FEATURE_FLAG_IDS.skillsCatalog, 'feature.skills.catalog');
    const root = workspaceRoot(event.sender);
    return skillsDirs(root).flatMap((d) => scanSkillsDirectory(d));
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.skillsLockRead, (event) => {
    requireFlag(FEATURE_FLAG_IDS.skillsCatalog, 'feature.skills.catalog');
    const root = workspaceRoot(event.sender);
    const lockPath = path.join(
      resolveSubdirUnderRoot(root, '.nexus'),
      'skills-lock.json',
    );
    if (!fs.existsSync(lockPath)) {
      return skillsLockSchema.parse({ schemaVersion: 1, skills: [] });
    }
    try {
      if (!fs.lstatSync(lockPath).isFile()) {
        return skillsLockSchema.parse({ schemaVersion: 1, skills: [] });
      }
      return skillsLockSchema.parse(
        JSON.parse(fs.readFileSync(lockPath, 'utf8')),
      );
    } catch {
      return skillsLockSchema.parse({ schemaVersion: 1, skills: [] });
    }
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.skillsLockWrite, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.skillsCatalog, 'feature.skills.catalog');
    const root = workspaceRoot(event.sender);
    const lock = skillsLockSchema.parse(raw) as SkillsLock;
    const lockPath = path.join(
      resolveSubdirUnderRoot(root, '.nexus'),
      'skills-lock.json',
    );
    writeSkillsLock(lockPath, lock);
    return { ok: true, path: lockPath };
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubLoad, (event) => {
    requireFlag(FEATURE_FLAG_IDS.mcpHub, 'feature.mcp.hub');
    const root = workspaceRoot(event.sender);
    const config = loadMcpHub(root);
    return {
      path: mcpHubPath(root),
      config: {
        ...config,
        servers: config.servers.map(maskServerForUi),
      },
      matrix: toolMatrix(config),
    };
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubSave, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.mcpHub, 'feature.mcp.hub');
    const root = workspaceRoot(event.sender);
    const input = z
      .object({
        config: mcpHubConfigSchema,
        dryRun: z.boolean().optional(),
      })
      .parse(raw);
    // mcpHubLoad masks secrets for the UI; saving that shape back verbatim
    // would replace real tokens with placeholders. Restore from stored config.
    const config = restoreMaskedSecrets(input.config, loadMcpHub(root));
    return writeConfigWithBackup(mcpHubPath(root), config, {
      dryRun: input.dryRun,
    });
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubDrift, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.mcpHub, 'feature.mcp.hub');
    const root = workspaceRoot(event.sender);
    const input = z
      .object({ observed: mcpHubConfigSchema })
      .parse(raw);
    return detectDrift(loadMcpHub(root), input.observed);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubHealth, (event) => {
    requireFlag(FEATURE_FLAG_IDS.mcpHub, 'feature.mcp.hub');
    const root = workspaceRoot(event.sender);
    return loadMcpHub(root).servers.map(healthForServer);
  });

  /**
   * Restore mcp-hub.json from a workspace-local `.bak` produced by save.
   * Fail-closed: backup must live under project `.nexus/` and end with `.bak`.
   */
  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubRollback, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.mcpHub, 'feature.mcp.hub');
    const root = workspaceRoot(event.sender);
    const { backupPath } = z
      .object({ backupPath: z.string().min(1).max(4096) })
      .parse(raw);
    const hubPath = mcpHubPath(root);
    const resolvedBak = assertWorkspaceMcpHubBackup(root, backupPath);
    rollbackFromBackup(hubPath, resolvedBak);
    const config = loadMcpHub(root);
    return {
      ok: true as const,
      path: hubPath,
      config: {
        ...config,
        servers: config.servers.map(maskServerForUi),
      },
    };
  });

  /**
   * Read-only Across Tools matrix. No write-back; no feature-flag gate —
   * discovery of on-disk MCP configs must work even when hub sync is off.
   */
  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubObserve, (event) => {
    let root: string | null = null;
    let hubServerIds: string[] = [];
    try {
      root = workspaceRoot(event.sender);
      hubServerIds = loadMcpHub(root).servers.map((server) => server.id);
    } catch {
      // No workspace bound — still probe Cursor/Claude/Codex/….
    }
    return observeAcrossTools({ hubServerIds, workspaceRoot: root });
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubSyncPlan, (event) => {
    requireFlag(FEATURE_FLAG_IDS.mcpHub, 'feature.mcp.hub');
    const root = workspaceRoot(event.sender);
    return planMcpSync({ hub: loadMcpHub(root) });
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubSyncApply, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.mcpHub, 'feature.mcp.hub');
    const root = workspaceRoot(event.sender);
    const input = z
      .object({
        dryRun: z.boolean().optional(),
        mode: z.enum(['both', 'import', 'export']).optional(),
        exportTools: z
          .array(z.enum(MCP_HUB_SYNC_EXPORT_TOOL_ENUM))
          .max(MCP_HUB_SYNC_EXPORT_TOOLS.length)
          .optional(),
      })
      .parse(raw ?? {});
    return applyMcpSync({
      hub: loadMcpHub(root),
      hubPath: mcpHubPath(root),
      dryRun: input.dryRun,
      mode: input.mode,
      exportTools: input.exportTools,
    });
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.autonomyDecide, (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.autonomyProfiles, 'feature.autonomy.profiles');
    const root = workspaceRoot(event.sender);
    const input = z
      .object({
        profile: autonomyProfileSchema,
        tool: z.string().min(1).max(128),
        action: z.string().min(1).max(128),
        missionId: z.string().max(128).optional(),
        reason: z.string().max(1024).optional(),
      })
      .parse(raw);
    // Renderer input cannot claim another workspace or self-attest worktree
    // isolation. The production effect gate must derive both in main.
    return decideAutonomy({
      ...input,
      scope: root,
      inIsolatedWorktree: false,
    });
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.searchQuery, async (event, raw) => {
    requireFlag(FEATURE_FLAG_IDS.searchMixer, 'feature.search.mixer');
    // Single SearchMixer path (same as search-mixer:search) — always bind root.
    const root = workspaceRoot(event.sender);
    const input = z
      .object({
        text: z.string().max(512),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(raw);
    return runSearchMixerQuery({
      text: input.text,
      limit: input.limit ?? 30,
      projectRoot: root,
    });
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.editorOpen, (event, raw) => {
    if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.codemirrorEditor)) {
      throw new Error('feature.editor.codemirror is disabled');
    }
    const { relativePath } = z
      .object({ relativePath: z.string().min(1).max(4096) })
      .parse(raw);
    // Open/read must realpath the leaf (resolveScopedPath). Lexical-only
    // resolveScopedPathCandidate would accept a workspace symlink to a
    // sibling/outside path and leak file contents.
    const full = resolveScopedPath(event.sender, relativePath);
    try {
      const st = fs.statSync(full);
      const bytes = readEditorBytesOrEmpty(full);
      const doc = openEditorDocument({
        path: full,
        bytes,
        mtimeMs: st.mtimeMs,
      });
      // Publish the live buffer so a hashline patch sees the open document.
      publishEditorDocumentOpen(event.sender, doc);
      return doc;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Missing file after a valid in-scope path → empty document.
      const doc = openEditorDocument({
        path: full,
        bytes: Buffer.from(''),
      });
      publishEditorDocumentOpen(event.sender, doc);
      return doc;
    }
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.editorApply, (event, raw) => {
    if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.codemirrorEditor)) {
      throw new Error('feature.editor.codemirror is disabled');
    }
    const input = z
      .object({
        path: z.string().min(1).max(4096),
        content: z.string().max(MAX_EDITOR_CHARS),
        write: z.boolean().default(false),
        expectedContentHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(raw);
    // Re-bind absolute or relative path to sender workspace (fail-closed).
    const full = resolveScopedPath(event.sender, input.path);
    const bytes = readEditorBytesOrEmpty(full);
    const doc = openEditorDocument({ path: full, bytes });
    if (input.write) {
      if (!input.expectedContentHash) {
        throw new Error('expectedContentHash is required when saving');
      }
      assertExpectedContentHash(doc, input.expectedContentHash);
    }
    const next = applyEdit(doc, input.content);
    if (input.write && !next.binary && !next.tooLarge) {
      // Parent must already be under workspace (resolveScopedPath). Create only
      // intermediate dirs under that containment.
      fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
      writeFileAtomic(full, next.content);
      const saved = markSaved(next);
      // Saved buffer is now clean and matches disk — refresh the registry.
      publishEditorDocumentApply(event.sender, saved);
      return saved;
    }
    // Edit without write: the buffer is (possibly) dirty — publish it so a
    // hashline patch validates against the unsaved content.
    publishEditorDocumentApply(event.sender, next);
    return next;
  });
}
