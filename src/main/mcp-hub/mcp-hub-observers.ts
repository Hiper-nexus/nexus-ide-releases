import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  MCP_ACROSS_TOOL_IDS,
  MCP_ACROSS_TOOL_LABELS,
  acrossToolsBanner,
  countAcrossDrift,
  normalizeMcpServerKey,
  type McpAcrossColumn,
  type McpAcrossRow,
  type McpAcrossToolId,
  type McpAcrossToolsReport,
  type McpCellState,
  type McpToolProbeStatus,
} from '../../shared/mcp-across-tools';

/**
 * Read-only probes of third-party MCP configs on disk.
 * Never writes HOME. Secrets are not returned — only server ids.
 */

const MAX_BYTES = 2_000_000;

export interface ObserveAcrossToolsInput {
  readonly home?: string;
  /** Servers from .nexus/mcp-hub.json (canonical). */
  readonly hubServerIds?: readonly string[];
  readonly workspaceRoot?: string | null;
}

interface ToolProbe {
  id: McpAcrossToolId;
  label: string;
  path: string | null;
  status: McpToolProbeStatus;
  servers: Set<string>;
  labels: Map<string, string>;
  error?: string;
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

function keysFromMcpServersObject(
  value: unknown,
): { keys: string[]; labels: Map<string, string> } {
  const labels = new Map<string, string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { keys: [], labels };
  }
  const keys: string[] = [];
  for (const raw of Object.keys(value as Record<string, unknown>)) {
    const key = normalizeMcpServerKey(raw);
    if (!key) continue;
    keys.push(key);
    labels.set(key, raw);
  }
  return { keys, labels };
}

/** Cursor / Claude Desktop / Gemini: `{ mcpServers: { id: {...} } }`. */
export function parseMcpServersJson(raw: string): {
  keys: string[];
  labels: Map<string, string>;
} {
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== 'object') return { keys: [], labels: new Map() };
  const root = data as Record<string, unknown>;
  if (root.mcpServers !== undefined) {
    return keysFromMcpServersObject(root.mcpServers);
  }
  return { keys: [], labels: new Map() };
}

/** OpenCode: `{ mcp: { id: {...} } }`. */
export function parseOpenCodeMcpJson(raw: string): {
  keys: string[];
  labels: Map<string, string>;
} {
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== 'object') return { keys: [], labels: new Map() };
  return keysFromMcpServersObject((data as Record<string, unknown>).mcp);
}

/**
 * Codex TOML: `[mcp_servers.name]` (+ optional `.env` subtables).
 * Server id is the first path segment after mcp_servers.
 */
export function parseCodexMcpToml(raw: string): {
  keys: string[];
  labels: Map<string, string>;
} {
  const labels = new Map<string, string>();
  const data = parseToml(raw) as Record<string, unknown>;
  const block = data.mcp_servers;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return { keys: [], labels };
  }
  const keys: string[] = [];
  for (const rawName of Object.keys(block as Record<string, unknown>)) {
    const key = normalizeMcpServerKey(rawName);
    if (!key) continue;
    keys.push(key);
    labels.set(key, rawName);
  }
  return { keys, labels };
}

function probeJsonMcpServers(
  id: McpAcrossToolId,
  filePath: string,
): ToolProbe {
  const label = MCP_ACROSS_TOOL_LABELS[id];
  try {
    const raw = readTextLimited(filePath);
    if (raw === null) {
      return {
        id,
        label,
        path: filePath,
        status: 'missing',
        servers: new Set(),
        labels: new Map(),
      };
    }
    const parsed =
      id === 'opencode' ? parseOpenCodeMcpJson(raw) : parseMcpServersJson(raw);
    return {
      id,
      label,
      path: filePath,
      status: 'ok',
      servers: new Set(parsed.keys),
      labels: parsed.labels,
    };
  } catch (error) {
    return {
      id,
      label,
      path: filePath,
      status: 'error',
      servers: new Set(),
      labels: new Map(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function probeCodex(filePath: string): ToolProbe {
  const id: McpAcrossToolId = 'codex';
  const label = MCP_ACROSS_TOOL_LABELS[id];
  try {
    const raw = readTextLimited(filePath);
    if (raw === null) {
      return {
        id,
        label,
        path: filePath,
        status: 'missing',
        servers: new Set(),
        labels: new Map(),
      };
    }
    const parsed = parseCodexMcpToml(raw);
    return {
      id,
      label,
      path: filePath,
      status: 'ok',
      servers: new Set(parsed.keys),
      labels: parsed.labels,
    };
  } catch (error) {
    return {
      id,
      label,
      path: filePath,
      status: 'error',
      servers: new Set(),
      labels: new Map(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function probeNexus(hubServerIds: readonly string[]): ToolProbe {
  const servers = new Set(
    hubServerIds.map(normalizeMcpServerKey).filter(Boolean),
  );
  return {
    id: 'nexus',
    label: MCP_ACROSS_TOOL_LABELS.nexus,
    path: null,
    status: 'ok',
    servers,
    labels: new Map([...servers].map((k) => [k, k])),
  };
}

const CLINE_MCP_RELATIVE = path.join(
  'User',
  'globalStorage',
  'saoudrizwan.claude-dev',
  'settings',
  'cline_mcp_settings.json',
);

function ideHostConfigRoots(home: string): string[] {
  const roots: string[] = [];
  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support'));
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    roots.push(process.env.APPDATA);
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  for (const host of ['Code', 'Cursor', 'Code - Insiders']) {
    roots.push(path.join(xdg, host));
  }
  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    for (const host of ['Code', 'Cursor', 'Code - Insiders']) {
      roots.push(path.join(appSupport, host));
    }
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    for (const host of ['Code', 'Cursor', 'Code - Insiders']) {
      roots.push(path.join(process.env.APPDATA, host));
    }
  }
  return [...new Set(roots)];
}

/**
 * Cline MCP settings candidates (VS Code / Cursor / Insiders / ~/.cline).
 * Prefer writing/observing the first file that already exists — never invent.
 */
export function clineMcpSettingsCandidates(home: string): string[] {
  const candidates = ideHostConfigRoots(home).map((root) =>
    path.join(root, CLINE_MCP_RELATIVE),
  );
  candidates.push(
    path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
  );
  return [...new Set(candidates)];
}

/** Claude Desktop config paths (macOS / Windows / XDG). */
export function claudeDesktopConfigCandidates(home: string): string[] {
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push(
      path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
    );
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(
      path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json'),
    );
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  candidates.push(path.join(xdg, 'Claude', 'claude_desktop_config.json'));
  return candidates;
}

export function resolveClaudeDesktopConfigPath(home: string): string | null {
  for (const candidate of claudeDesktopConfigCandidates(home)) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // missing / unreadable — try next host
    }
  }
  return null;
}

/** First existing `cline_mcp_settings.json`, or null if none. */
export function resolveClineMcpSettingsPath(home: string): string | null {
  for (const candidate of clineMcpSettingsCandidates(home)) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // missing / unreadable — try next host
    }
  }
  return null;
}

/** Canonical VS Code host path (used when missing for column path display). */
export function canonicalClineMcpSettingsPath(home: string): string {
  return clineMcpSettingsCandidates(home)[0]!;
}

function mergeProjectCursor(
  homeProbe: ToolProbe,
  workspaceRoot: string | null | undefined,
): ToolProbe {
  if (!workspaceRoot) return homeProbe;
  const projectPath = path.join(workspaceRoot, '.cursor', 'mcp.json');
  const project = probeJsonMcpServers('cursor', projectPath);
  if (project.status !== 'ok') return homeProbe;
  const servers = new Set([...homeProbe.servers, ...project.servers]);
  const labels = new Map(homeProbe.labels);
  for (const [k, v] of project.labels) labels.set(k, v);
  return {
    ...homeProbe,
    status: homeProbe.status === 'missing' && project.status === 'ok'
      ? 'ok'
      : homeProbe.status === 'error'
        ? homeProbe.status
        : 'ok',
    servers,
    labels,
    path: homeProbe.path ?? project.path,
  };
}

export function observeAcrossTools(
  input: ObserveAcrossToolsInput = {},
): McpAcrossToolsReport {
  const home = input.home ?? os.homedir();

  const probes: ToolProbe[] = [
    probeNexus(input.hubServerIds ?? []),
    mergeProjectCursor(
      probeJsonMcpServers('cursor', path.join(home, '.cursor', 'mcp.json')),
      input.workspaceRoot,
    ),
    probeJsonMcpServers('claude-code', path.join(home, '.claude.json')),
    probeCodex(path.join(home, '.codex', 'config.toml')),
    probeJsonMcpServers(
      'opencode',
      path.join(home, '.config', 'opencode', 'opencode.json'),
    ),
    probeJsonMcpServers(
      'cline',
      resolveClineMcpSettingsPath(home) ??
        canonicalClineMcpSettingsPath(home),
    ),
  ];

  // Claude Desktop supplements Claude Code column when present (union of ids).
  const desktopPath = resolveClaudeDesktopConfigPath(home);
  const desktop = desktopPath
    ? probeJsonMcpServers('claude-code', desktopPath)
    : null;
  if (desktop?.status === 'ok') {
    const claude = probes.find((p) => p.id === 'claude-code');
    if (claude) {
      for (const k of desktop.servers) claude.servers.add(k);
      for (const [k, v] of desktop.labels) claude.labels.set(k, v);
      if (claude.status === 'missing') {
        claude.status = 'ok';
        claude.path = desktop.path;
      }
    }
  }

  const allKeys = new Set<string>();
  for (const p of probes) {
    for (const k of p.servers) allKeys.add(k);
  }

  const rows: McpAcrossRow[] = [...allKeys].sort().map((serverKey) => {
    const cells = {} as Record<McpAcrossToolId, McpCellState>;
    let label = serverKey;
    for (const id of MCP_ACROSS_TOOL_IDS) {
      const probe = probes.find((p) => p.id === id)!;
      if (probe.status === 'missing' || probe.status === 'error') {
        cells[id] = 'unknown';
      } else if (probe.servers.has(serverKey)) {
        cells[id] = 'present';
        label = probe.labels.get(serverKey) ?? label;
      } else {
        cells[id] = 'absent';
      }
    }
    return { serverKey, label, cells };
  });

  const columns: McpAcrossColumn[] = probes.map((p) => ({
    id: p.id,
    label: p.label,
    path: p.path,
    status: p.status,
    serverCount: p.servers.size,
    ...(p.error ? { error: p.error } : {}),
  }));

  const driftCount = countAcrossDrift(rows);
  const toolOkCount = columns.filter(
    (c) => c.id !== 'nexus' && c.status === 'ok',
  ).length;
  const banner = acrossToolsBanner(driftCount, toolOkCount);

  return {
    columns,
    rows,
    driftCount,
    bannerKicker: banner.kicker,
    bannerLine: banner.line,
    observedAt: Date.now(),
  };
}
