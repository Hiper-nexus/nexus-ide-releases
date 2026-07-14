/**
 * Product-wave IPC: memory, skills, MCP hub, autonomy, search, feature flags,
 * editor document model. All paths respect feature flags (now default ON).
 */
import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
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
  type SkillsLock,
} from './skills/skills-catalog';
import {
  detectDrift,
  maskServerForUi,
  mcpHubConfigSchema,
  toolMatrix,
  writeConfigWithBackup,
  healthForServer,
  type McpHubConfig,
} from './mcp-hub/mcp-hub-core';
import {
  openEditorDocument,
  applyEdit,
  markSaved,
  MAX_EDITOR_CHARS,
} from './editor/editor-document';
import { SearchMixer } from './search/search-mixer';
import type { SearchSourceProvider, SearchHit } from '../shared/search-mixer-types';
import {
  requireScopedRoot,
  resolveScopedPath,
  resolveScopedPathCandidate,
} from './security/scoped-workspace-fs';

export { PRODUCT_WAVE_CHANNELS };

function workspaceRoot(sender: Electron.WebContents): string {
  return requireScopedRoot(sender).root;
}

function mcpHubPath(root: string): string {
  return path.join(root, '.nexus', 'mcp-hub.json');
}

function skillsDirs(root: string): string[] {
  return [
    path.join(root, '.claude', 'skills'),
    path.join(root, '.nexus', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
  ];
}

function loadMcpHub(root: string): McpHubConfig {
  const file = mcpHubPath(root);
  if (!fs.existsSync(file)) {
    return mcpHubConfigSchema.parse({ schemaVersion: 1, servers: [] });
  }
  return mcpHubConfigSchema.parse(
    JSON.parse(fs.readFileSync(file, 'utf8') as string),
  );
}

function buildSearchMixer(root: string): SearchMixer {
  const mixer = new SearchMixer({ debounceMs: 0 });
  const missionsProvider: SearchSourceProvider = {
    source: 'missions',
    async search(query, signal) {
      if (signal.aborted) return [];
      // Lightweight path scan of mission titles from memory notes kind=mission
      const notes = listMemoryNotes(root).filter((n) => n.kind === 'mission');
      const q = query.text.toLowerCase();
      return notes
        .filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
        .slice(0, query.limit)
        .map(
          (n): SearchHit => ({
            id: `mission-note:${n.id}`,
            source: 'missions',
            title: n.title,
            subtitle: n.kind,
            score: 0.8,
            snippet: n.body.slice(0, 160),
            path: n.path,
          }),
        );
    },
  };
  const skillsProvider: SearchSourceProvider = {
    source: 'skills',
    async search(query, signal) {
      if (signal.aborted) return [];
      const q = query.text.toLowerCase();
      const skills = skillsDirs(root).flatMap((d) => scanSkillsDirectory(d));
      return skills
        .filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
        .slice(0, query.limit)
        .map(
          (s): SearchHit => ({
            id: `skill:${s.id}`,
            source: 'skills',
            title: s.name,
            subtitle: s.category,
            score: 0.75,
            snippet: s.description.slice(0, 160),
            path: s.path,
          }),
        );
    },
  };
  const filesProvider: SearchSourceProvider = {
    source: 'files',
    async search(query, signal) {
      if (signal.aborted) return [];
      // Shallow walk (non-recursive heavy) — top-level + common src
      const hits: SearchHit[] = [];
      const q = query.text.toLowerCase();
      const walk = (dir: string, depth: number) => {
        if (depth > 3 || hits.length >= query.limit) return;
        let names: string[] = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names) {
          if (name === 'node_modules' || name === '.git' || name.startsWith('.'))
            continue;
          const full = path.join(dir, name);
          if (name.toLowerCase().includes(q)) {
            hits.push({
              id: `file:${full}`,
              source: 'files',
              title: name,
              score: 0.6,
              path: full,
            });
          }
          try {
            if (fs.statSync(full).isDirectory()) walk(full, depth + 1);
          } catch {
            /* skip */
          }
          if (hits.length >= query.limit) return;
        }
      };
      walk(root, 0);
      return hits;
    },
  };
  mixer.register(missionsProvider);
  mixer.register(skillsProvider);
  mixer.register(filesProvider);
  return mixer;
}

let searchMixer: SearchMixer | null = null;

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
    const root = workspaceRoot(event.sender);
    return listMemoryNotes(root);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.memoryRemember, (event, raw) => {
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
    const root = workspaceRoot(event.sender);
    const { query } = z.object({ query: z.string().max(512) }).parse(raw);
    return searchMemory(root, query);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.memoryBacklinks, (event, raw) => {
    const root = workspaceRoot(event.sender);
    const { title } = z.object({ title: z.string().min(1).max(256) }).parse(raw);
    return backlinks(root, title);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.memoryComplete, (event, raw) => {
    const root = workspaceRoot(event.sender);
    const { prefix } = z.object({ prefix: z.string().max(128) }).parse(raw);
    return wikilinkCompletions(root, prefix);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.skillsList, (event) => {
    const root = workspaceRoot(event.sender);
    return skillsDirs(root).flatMap((d) => scanSkillsDirectory(d));
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.skillsLockRead, (event) => {
    const root = workspaceRoot(event.sender);
    const lockPath = path.join(root, '.nexus', 'skills-lock.json');
    if (!fs.existsSync(lockPath)) {
      return skillsLockSchema.parse({ schemaVersion: 1, skills: [] });
    }
    return skillsLockSchema.parse(
      JSON.parse(fs.readFileSync(lockPath, 'utf8')),
    );
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.skillsLockWrite, (event, raw) => {
    if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.skillsCatalog)) {
      throw new Error('feature.skills.catalog is disabled');
    }
    const root = workspaceRoot(event.sender);
    const lock = skillsLockSchema.parse(raw) as SkillsLock;
    const lockPath = path.join(root, '.nexus', 'skills-lock.json');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
      mode: 0o600,
    });
    return { ok: true, path: lockPath };
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubLoad, (event) => {
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
    const root = workspaceRoot(event.sender);
    const input = z
      .object({ observed: mcpHubConfigSchema })
      .parse(raw);
    return detectDrift(loadMcpHub(root), input.observed);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.mcpHubHealth, (event) => {
    const root = workspaceRoot(event.sender);
    return loadMcpHub(root).servers.map(healthForServer);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.autonomyDecide, (_event, raw) => {
    const input = z
      .object({
        profile: autonomyProfileSchema,
        tool: z.string().min(1).max(128),
        action: z.string().min(1).max(128),
        scope: z.string().min(1).max(512),
        missionId: z.string().max(128).optional(),
        reason: z.string().max(1024).optional(),
        inIsolatedWorktree: z.boolean().optional(),
      })
      .parse(raw);
    return decideAutonomy(input);
  });

  ipcMain.handle(PRODUCT_WAVE_CHANNELS.searchQuery, (event, raw) => {
    if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.searchMixer)) {
      return { generation: 0, query: '', hits: [], partial: false, completedSources: [], cancelled: false, elapsedMs: 0 };
    }
    const root = workspaceRoot(event.sender);
    const input = z
      .object({
        text: z.string().max(512),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(raw);
    searchMixer ??= buildSearchMixer(root);
    // Rebuild mixer root when workspace changes — simple: always rebuild for correctness
    searchMixer = buildSearchMixer(root);
    return searchMixer.searchNow({
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
    // Containment via shared adapter — never path.resolve + startsWith.
    const full = resolveScopedPathCandidate(event.sender, relativePath);
    try {
      const st = fs.statSync(full);
      const bytes = fs.readFileSync(full);
      return openEditorDocument({
        path: full,
        bytes,
        mtimeMs: st.mtimeMs,
      });
    } catch {
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
      fs.writeFileSync(full, next.content, { mode: 0o600 });
      return markSaved(next);
    }
    return next;
  });
}
