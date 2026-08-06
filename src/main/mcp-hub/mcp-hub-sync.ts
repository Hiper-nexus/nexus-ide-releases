import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  normalizeMcpServerKey,
  type McpAcrossToolId,
} from '../../shared/mcp-across-tools';
import {
  MCP_HUB_SYNC_EXPORT_TOOLS,
  type McpHubSyncExportToolId,
} from '../../shared/mcp-hub-sync-api';
import {
  writeConfigWithBackup,
  type McpHubConfig,
  type McpHubServer,
} from './mcp-hub-core';
import {
  canonicalClineMcpSettingsPath,
  resolveClineMcpSettingsPath,
  resolveClaudeDesktopConfigPath,
} from './mcp-hub-observers';
import {
  writeFileAtomic,
  writeTimestampedBackup,
} from '../util/atomic-write';
import { scanInstalledPlugins } from '../orch/agent-plugin-scan';

/**
 * Fill-gaps sync between Nexus hub and on-disk coding-tool MCP configs.
 * Never deletes servers. Never invents secrets. Backups before every write.
 */

const MAX_BYTES = 2_000_000;

/** Tools we will write back to (fill gaps) — single source: mcp-hub-sync-api. */
export const MCP_SYNC_EXPORT_TOOLS = MCP_HUB_SYNC_EXPORT_TOOLS;

export type McpSyncExportToolId = McpHubSyncExportToolId;

export interface McpSyncPlan {
  readonly importIds: readonly string[];
  readonly exportByTool: Readonly<
    Partial<Record<McpSyncExportToolId, readonly string[]>>
  >;
  readonly skipped: readonly string[];
  readonly summary: string;
}

export interface McpSyncApplyResult {
  readonly ok: true;
  readonly dryRun: boolean;
  readonly hubWrote: boolean;
  readonly hubBackupPath: string | null;
  readonly toolWrites: readonly {
    tool: McpSyncExportToolId;
    path: string;
    backupPath: string | null;
    added: readonly string[];
  }[];
}

function readTextLimited(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string').slice(0, 64);
  return out.length > 0 ? out : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && k.length <= 128) out[k.slice(0, 128)] = v.slice(0, 4096);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function hubFromStdioLike(
  rawName: string,
  entry: Record<string, unknown>,
  source: McpHubServer['source'],
): McpHubServer | null {
  const id = normalizeMcpServerKey(rawName);
  if (!id) return null;
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const url =
    typeof entry.url === 'string'
      ? entry.url
      : typeof entry.serverUrl === 'string'
        ? entry.serverUrl
        : undefined;
  if (!command && !url) return null;
  const env =
    stringMap(entry.env) ??
    stringMap(entry.environment) ??
    undefined;
  const cwd = typeof entry.cwd === 'string' ? entry.cwd.slice(0, 4096) : undefined;
  const headers = stringMap(entry.headers);
  return {
    id,
    name: rawName.slice(0, 256),
    transport: url && !command ? 'streamable-http' : 'stdio',
    ...(command ? { command: command.slice(0, 4096) } : {}),
    ...(stringList(entry.args) ? { args: stringList(entry.args) } : {}),
    ...(cwd ? { cwd } : {}),
    ...(url ? { url: url.slice(0, 4096) } : {}),
    ...(headers ? { headers } : {}),
    ...(env ? { env } : {}),
    tools: [],
    source,
  };
}

function agentPluginMcpId(pluginName: string, serverName: string): string {
  const base = normalizeMcpServerKey(
    `agent-plugin-${pluginName}-${serverName}`,
  );
  if (base.length <= 128) return base;
  const digest = createHash('sha256')
    .update(`${pluginName}:${serverName}`)
    .digest('hex')
    .slice(0, 8);
  return `${base.slice(0, 119).replace(/-+$/g, '')}-${digest}`;
}

function collectFromAgentPlugins(home: string): McpHubServer[] {
  const servers: McpHubServer[] = [];
  for (const plugin of scanInstalledPlugins(home)) {
    if (!plugin.verdict.ok) continue;
    for (const server of plugin.mcpServers) {
      const common = {
        id: agentPluginMcpId(plugin.verdict.name, server.name),
        name: `${plugin.verdict.name}:${server.name}`.slice(0, 256),
        tools: [],
        source: 'other' as const,
      };
      servers.push(
        server.transport === 'stdio'
          ? {
              ...common,
              transport: 'stdio',
              command: server.command,
              ...(server.args ? { args: [...server.args] } : {}),
              cwd: server.cwd,
              env: { ...server.env },
            }
          : {
              ...common,
              transport:
                server.transport === 'sse'
                  ? 'sse-legacy'
                  : 'streamable-http',
              url: server.url,
              ...(server.headers ? { headers: { ...server.headers } } : {}),
            },
      );
    }
  }
  return servers;
}

function collectFromMcpServersJson(
  filePath: string,
  source: McpHubServer['source'],
): McpHubServer[] {
  const raw = readTextLimited(filePath);
  if (raw === null) return [];
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(raw));
  } catch {
    return [];
  }
  const block = asRecord(root?.mcpServers);
  if (!block) return [];
  const out: McpHubServer[] = [];
  for (const [rawName, value] of Object.entries(block)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const server = hubFromStdioLike(rawName, entry, source);
    if (server) out.push(server);
  }
  return out;
}

function collectFromOpenCode(filePath: string): McpHubServer[] {
  const raw = readTextLimited(filePath);
  if (raw === null) return [];
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(raw));
  } catch {
    return [];
  }
  const block = asRecord(root?.mcp);
  if (!block) return [];
  const out: McpHubServer[] = [];
  for (const [rawName, value] of Object.entries(block)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const server = hubFromStdioLike(rawName, entry, 'opencode');
    if (server) out.push(server);
  }
  return out;
}

function collectFromCodex(filePath: string): McpHubServer[] {
  const raw = readTextLimited(filePath);
  if (raw === null) return [];
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(parseToml(raw));
  } catch {
    return [];
  }
  const block = asRecord(root?.mcp_servers);
  if (!block) return [];
  const out: McpHubServer[] = [];
  for (const [rawName, value] of Object.entries(block)) {
    const entry = asRecord(value);
    if (!entry) continue;
    // Nested env table lives under entry.env
    const server = hubFromStdioLike(rawName, entry, 'codex');
    if (server) out.push(server);
  }
  return out;
}

export function collectObservedHubServers(home = os.homedir()): McpHubServer[] {
  const clinePath = resolveClineMcpSettingsPath(home);
  const claudeDesktop = resolveClaudeDesktopConfigPath(home);
  const buckets: McpHubServer[][] = [
    collectFromAgentPlugins(home),
    collectFromMcpServersJson(path.join(home, '.cursor', 'mcp.json'), 'cursor'),
    collectFromMcpServersJson(path.join(home, '.claude.json'), 'claude-code'),
    ...(claudeDesktop
      ? [collectFromMcpServersJson(claudeDesktop, 'claude-code')]
      : []),
    collectFromCodex(path.join(home, '.codex', 'config.toml')),
    collectFromOpenCode(path.join(home, '.config', 'opencode', 'opencode.json')),
    // Source enum has no 'cline' — import as 'other' (ids only; no secrets invented).
    ...(clinePath
      ? [collectFromMcpServersJson(clinePath, 'other')]
      : []),
  ];
  // Preference: first rich hit wins (cursor → claude → desktop → codex → opencode → cline).
  const byId = new Map<string, McpHubServer>();
  for (const list of buckets) {
    for (const server of list) {
      if (!byId.has(server.id)) byId.set(server.id, server);
    }
  }
  return [...byId.values()];
}

function toolPaths(home: string): Record<McpSyncExportToolId, string> {
  return {
    cursor: path.join(home, '.cursor', 'mcp.json'),
    'claude-code': path.join(home, '.claude.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    opencode: path.join(home, '.config', 'opencode', 'opencode.json'),
    cline:
      resolveClineMcpSettingsPath(home) ?? canonicalClineMcpSettingsPath(home),
  };
}

function requiresExistingConfig(tool: McpSyncExportToolId): boolean {
  return tool === 'claude-code' || tool === 'codex' || tool === 'cline';
}

function existingIdsInTool(
  tool: McpSyncExportToolId,
  filePath: string,
): Set<string> | null {
  const raw = readTextLimited(filePath);
  if (raw === null) return new Set(); // missing file = empty (we may create JSON tools)
  try {
    if (tool === 'codex') {
      const root = asRecord(parseToml(raw));
      const block = asRecord(root?.mcp_servers);
      return new Set(
        Object.keys(block ?? {}).map(normalizeMcpServerKey).filter(Boolean),
      );
    }
    const root = asRecord(JSON.parse(raw));
    const block =
      tool === 'opencode' ? asRecord(root?.mcp) : asRecord(root?.mcpServers);
    return new Set(
      Object.keys(block ?? {}).map(normalizeMcpServerKey).filter(Boolean),
    );
  } catch {
    return null;
  }
}

export function planMcpSync(options: {
  hub: McpHubConfig;
  home?: string;
}): McpSyncPlan {
  const home = options.home ?? os.homedir();
  const observed = collectObservedHubServers(home);
  const hubIds = new Set(options.hub.servers.map((s) => s.id));
  const toImport = observed.filter((s) => !hubIds.has(s.id));
  const importIds = toImport.map((s) => s.id);
  // Plan export against post-import hub so Sync 0→N shows real fan-out.
  const virtualHubServers = [...options.hub.servers, ...toImport].slice(0, 64);

  const paths = toolPaths(home);
  const exportByTool: Partial<Record<McpSyncExportToolId, string[]>> = {};
  const skipped: string[] = [];

  for (const tool of MCP_SYNC_EXPORT_TOOLS) {
    const ids = existingIdsInTool(tool, paths[tool]);
    if (ids === null) {
      skipped.push(`${tool}: parse error`);
      continue;
    }
    // Don't create brand-new configs from scratch when host-specific /
    // extension paths are ambiguous. Cursor/opencode empty OK; claude/codex/cline require file.
    if (requiresExistingConfig(tool) && readTextLimited(paths[tool]) === null) {
      skipped.push(`${tool}: config missing`);
      continue;
    }
    const add = virtualHubServers
      .map((s) => s.id)
      .filter((id) => !ids.has(id));
    if (add.length > 0) exportByTool[tool] = add;
  }

  const exportCount = Object.values(exportByTool).reduce(
    (n, ids) => n + (ids?.length ?? 0),
    0,
  );
  const summary =
    importIds.length === 0 && exportCount === 0
      ? 'Nada a sincronizar — hub e tools já cobrem os mesmos servers (fill-gaps).'
      : `Importar ${importIds.length} → hub; espelhar ${exportCount} gap(s) → tools.`;

  return { importIds, exportByTool, skipped, summary };
}

function toCursorEntry(server: McpHubServer): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (server.command) entry.command = server.command;
  if (server.args?.length) entry.args = server.args;
  if (server.cwd) entry.cwd = server.cwd;
  if (server.url) entry.url = server.url;
  if (server.headers) entry.headers = server.headers;
  if (server.env) entry.env = server.env;
  return entry;
}

function toOpenCodeEntry(server: McpHubServer): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: server.url && !server.command ? 'remote' : 'local',
    enabled: true,
  };
  if (server.command) entry.command = server.command;
  if (server.args?.length) entry.args = server.args;
  if (server.cwd) entry.cwd = server.cwd;
  if (server.url) entry.url = server.url;
  if (server.headers) entry.headers = server.headers;
  if (server.env) entry.environment = server.env;
  return entry;
}

/** Cline: mcpServers + disabled/autoApprove (same shape observer reads). */
function toClineEntry(server: McpHubServer): Record<string, unknown> {
  return {
    ...toCursorEntry(server),
    disabled: false,
    autoApprove: [],
  };
}

function mergeJsonToolFile(
  filePath: string,
  field: 'mcpServers' | 'mcp',
  additions: Record<string, Record<string, unknown>>,
  dryRun: boolean,
): { backupPath: string | null; added: string[] } {
  const raw = readTextLimited(filePath);
  let root: Record<string, unknown>;
  try {
    root = raw ? (asRecord(JSON.parse(raw)) ?? {}) : {};
  } catch {
    return { backupPath: null, added: [] };
  }
  const block = { ...(asRecord(root[field]) ?? {}) };
  const added: string[] = [];
  for (const [id, entry] of Object.entries(additions)) {
    // Preserve original key casing if present; else use id.
    const existingKey = Object.keys(block).find(
      (k) => normalizeMcpServerKey(k) === id,
    );
    if (existingKey) continue;
    block[id] = entry;
    added.push(id);
  }
  if (added.length === 0) return { backupPath: null, added };
  const next = { ...root, [field]: block };
  const body = `${JSON.stringify(next, null, 2)}\n`;
  if (dryRun) return { backupPath: null, added };
  let backupPath: string | null = null;
  if (raw !== null) backupPath = writeTimestampedBackup(filePath, raw);
  writeFileAtomic(filePath, body);
  return { backupPath, added };
}

function mergeCodexToml(
  filePath: string,
  servers: McpHubServer[],
  dryRun: boolean,
): { backupPath: string | null; added: string[] } {
  const raw = readTextLimited(filePath);
  if (raw === null) throw new Error('codex config missing');
  const root = asRecord(parseToml(raw)) ?? {};
  const block = { ...(asRecord(root.mcp_servers) ?? {}) };
  const added: string[] = [];
  for (const server of servers) {
    if (Object.keys(block).some((k) => normalizeMcpServerKey(k) === server.id)) {
      continue;
    }
    if (!server.command && !server.url) continue;
    const entry: Record<string, unknown> = {};
    if (server.command) entry.command = server.command;
    if (server.args?.length) entry.args = server.args;
    if (server.cwd) entry.cwd = server.cwd;
    if (server.url) entry.url = server.url;
    if (server.headers) entry.headers = server.headers;
    if (server.env) entry.env = server.env;
    block[server.id] = entry;
    added.push(server.id);
  }
  if (added.length === 0) return { backupPath: null, added };
  const next = { ...root, mcp_servers: block };
  const body = `${stringifyToml(next)}\n`;
  if (dryRun) return { backupPath: null, added };
  const backupPath = writeTimestampedBackup(filePath, raw);
  writeFileAtomic(filePath, body);
  return { backupPath, added };
}

export function applyMcpSync(options: {
  hub: McpHubConfig;
  hubPath: string;
  home?: string;
  dryRun?: boolean;
  /** Default: import + export fill-gaps. */
  mode?: 'both' | 'import' | 'export';
  /** When set, only these tools receive export fill-gaps (opt-in). */
  exportTools?: readonly McpSyncExportToolId[];
}): McpSyncApplyResult {
  const home = options.home ?? os.homedir();
  const dryRun = options.dryRun === true;
  const mode = options.mode ?? 'both';
  const exportAllow =
    options.exportTools === undefined
      ? null
      : new Set(options.exportTools);
  const plan = planMcpSync({ hub: options.hub, home });
  const observed = collectObservedHubServers(home);
  const observedById = new Map(observed.map((s) => [s.id, s]));

  let hubWrote = false;
  let hubBackupPath: string | null = null;
  let hub = options.hub;

  if (mode !== 'export' && plan.importIds.length > 0) {
    const additions = plan.importIds
      .map((id) => observedById.get(id))
      .filter((s): s is McpHubServer => Boolean(s));
    const next: McpHubConfig = {
      schemaVersion: 1,
      servers: [...hub.servers, ...additions].slice(0, 64),
    };
    const result = writeConfigWithBackup(options.hubPath, next, { dryRun });
    hubBackupPath = result.backupPath;
    hubWrote = result.wrote;
    hub = next;
  }

  const toolWrites: Array<{
    tool: (typeof MCP_SYNC_EXPORT_TOOLS)[number];
    path: string;
    backupPath: string | null;
    added: readonly string[];
  }> = [];
  if (mode !== 'import') {
    const paths = toolPaths(home);
    const hubById = new Map(hub.servers.map((s) => [s.id, s]));
    for (const tool of MCP_SYNC_EXPORT_TOOLS) {
      if (exportAllow && !exportAllow.has(tool)) continue;
      // Fail-closed: never invent claude.json / config.toml / cline settings from nothing.
      if (requiresExistingConfig(tool) && readTextLimited(paths[tool]) === null) {
        continue;
      }
      // Recompute against possibly updated hub for import+export both.
      const liveIds = hub.servers.map((s) => s.id);
      const existing = existingIdsInTool(tool, paths[tool]);
      if (existing === null) continue;
      const gaps = liveIds.filter((id) => !existing.has(id));
      if (gaps.length === 0) continue;
      const servers = gaps
        .map((id) => hubById.get(id))
        .filter((s): s is McpHubServer => Boolean(s));
      if (servers.length === 0) continue;

      if (tool === 'codex') {
        const w = mergeCodexToml(paths[tool], servers, dryRun);
        toolWrites.push({
          tool,
          path: paths[tool],
          backupPath: w.backupPath,
          added: w.added,
        });
      } else if (tool === 'opencode') {
        const additions: Record<string, Record<string, unknown>> = {};
        for (const s of servers) additions[s.id] = toOpenCodeEntry(s);
        const w = mergeJsonToolFile(paths[tool], 'mcp', additions, dryRun);
        toolWrites.push({
          tool,
          path: paths[tool],
          backupPath: w.backupPath,
          added: w.added,
        });
      } else {
        // cursor + claude-code + cline (mcpServers)
        const additions: Record<string, Record<string, unknown>> = {};
        for (const s of servers) {
          additions[s.id] =
            tool === 'cline' ? toClineEntry(s) : toCursorEntry(s);
        }
        const w = mergeJsonToolFile(
          paths[tool],
          'mcpServers',
          additions,
          dryRun,
        );
        toolWrites.push({
          tool,
          path: paths[tool],
          backupPath: w.backupPath,
          added: w.added,
        });
      }
    }
  }

  return {
    ok: true,
    dryRun,
    hubWrote,
    hubBackupPath,
    toolWrites,
  };
}

/** @internal test helper */
export function __testOnly_hubFromStdioLike(
  rawName: string,
  entry: Record<string, unknown>,
  source: McpHubServer['source'],
): McpHubServer | null {
  return hubFromStdioLike(rawName, entry, source);
}

export type { McpAcrossToolId };
