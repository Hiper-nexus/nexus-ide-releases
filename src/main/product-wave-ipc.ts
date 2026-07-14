/**
 * Product-wave IPC: memory, skills, MCP hub, autonomy, search, feature flags,
 * editor document model. All paths respect feature flags (now default ON).
 */
import { ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PRODUCT_WAVE_CHANNELS } from '../shared/channels';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';
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
  toolMatrix,
  writeConfigWithBackup,
  rollbackFromBackup,
  healthForServer,
  type McpHubConfig,
} from './mcp-hub/mcp-hub-core';
import { isInsidePath } from './orch/workspace-path';
import {
  openEditorDocument,
  applyEdit,
  markSaved,
  MAX_EDITOR_CHARS,
} from './editor/editor-document';
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

export function registerProductWaveIpc(): void {
  ipcMain.handle(PRODUCT_WAVE_CHANNELS.flagsList, () => {
    const reg = getFeatureFlagRegistry();
    return reg.list().map((f) => ({
      id: f.id,
      enabled: reg.isEnabled(f.id),
      reason: reg.resolve(f.id).reason,
      definition: f,
    }));
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
    return writeConfigWithBackup(mcpHubPath(root), input.config, {
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
      const bytes = fs.readFileSync(full);
      return openEditorDocument({
        path: full,
        bytes,
        mtimeMs: st.mtimeMs,
      });
    } catch (err) {
      // If path escaped (symlink out), resolveScopedPath already threw.
      // Missing file after a valid in-scope path → empty document.
      if (err instanceof Error && /escapes workspace/i.test(err.message)) {
        throw err;
      }
      return openEditorDocument({
        path: full,
        bytes: Buffer.from(''),
      });
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
      })
      .parse(raw);
    // Re-bind absolute or relative path to sender workspace (fail-closed).
    const full = resolveScopedPath(event.sender, input.path);
    let bytes = Buffer.from('');
    try {
      bytes = fs.readFileSync(full);
    } catch {
      /* new file — still must be under scoped path */
    }
    const doc = openEditorDocument({ path: full, bytes });
    const next = applyEdit(doc, input.content);
    if (input.write && !next.binary && !next.tooLarge) {
      // Parent must already be under workspace (resolveScopedPath). Create only
      // intermediate dirs under that containment.
      fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
      fs.writeFileSync(full, next.content, { mode: 0o600 });
      return markSaved(next);
    }
    return next;
  });
}
