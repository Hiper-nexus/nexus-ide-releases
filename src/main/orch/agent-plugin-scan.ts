import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CatalogEntry } from './catalog-contract';
import {
  readPluginManifest,
  type AcceptedPlugin,
  type PluginManifestVerdict,
} from './agent-plugin-manifest';
import {
  readAgentPluginMcp,
  type AgentPluginMcpServer,
} from './agent-plugin-mcp';
import {
  readAgentPluginSkill,
  reduceAgentPluginAllowedTools,
  type AgentPluginSkill,
  type AgentPluginToolReduction,
} from './agent-plugin-skill';
import { scanComponentFiles } from './skill-threat-scan';
import { inspectAgentPluginSkillTree } from './agent-plugin-skill-tree';

const PLUGIN_ROOTS = ['.nexus/plugins', '.claude/plugins'] as const;
const MAX_PLUGINS = 200;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MCP_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_SKILLS = 256;

export const AGENT_PLUGIN_LIMITATIONS = Object.freeze([
  {
    capability: 'agents',
    why: 'Agent Plugins v1.0.0 has no agent component; Nexus agent profiles are not imported or exported',
  },
  {
    capability: 'registry',
    why: 'v1.0.0 defines a directory package, not a registry or installer',
  },
  {
    capability: 'delegation-handoff',
    why: 'v1.0.0 cannot represent Nexus delegation, missions, or handoffs',
  },
  {
    capability: 'permission-model',
    why: 'package metadata is never authority; Nexus PreToolUse and server-side gates remain authoritative',
  },
] as const);

export interface AgentPluginNotice {
  readonly component: string;
  readonly entry?: string;
  readonly disposition: 'ignored' | 'skipped' | 'reduced' | 'warning';
  readonly why: string;
}

export interface DiscoveredPluginSkill {
  readonly name: string;
  readonly qualifiedName: string;
  readonly providerName: string;
  readonly directory: string;
  readonly skillFile: string;
  readonly metadata: AgentPluginSkill;
  readonly toolReduction: AgentPluginToolReduction;
  readonly catalogEntry: CatalogEntry;
}

export type DiscoveredPluginMcpServer = AgentPluginMcpServer & {
  readonly nexusConcept: 'mcp-hub-server';
};

export interface DiscoveredPlugin {
  readonly source: string;
  /** Internal absolute root; inventory projections must never expose it. */
  readonly rootDir?: string;
  readonly verdict: PluginManifestVerdict;
  readonly status: 'accepted' | 'degraded' | 'rejected' | 'quarantined';
  readonly skills: readonly DiscoveredPluginSkill[];
  readonly mcpServers: readonly DiscoveredPluginMcpServer[];
  readonly notices: readonly AgentPluginNotice[];
  readonly mappings: Readonly<{
    skills: {
      source: 'skills/*/SKILL.md';
      nexusConcept: 'catalog.skill';
      loaded: number;
      skipped: number;
    };
    mcpServers: {
      source: 'mcp.json';
      nexusConcept: 'mcp-hub.server';
      loaded: number;
      skipped: number;
    };
  }>;
  readonly limitations: typeof AGENT_PLUGIN_LIMITATIONS;
  readonly summary: string;
}

export interface ScanInstalledPluginsOptions {
  /** Main-owned agent policy. Omitted is deny-all for package pre-approvals. */
  readonly allowedTools?: readonly string[] | null;
}

type FileRead =
  | { ok: true; buffer: Buffer; realPath: string }
  | { ok: false; kind: 'missing' | 'invalid' | 'unsafe'; reason: string };

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readContainedFile(root: string, file: string, maxBytes: number): FileRead {
  let realPath: string;
  try {
    realPath = fs.realpathSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: false, kind: 'missing', reason: 'arquivo ausente' }
      : { ok: false, kind: 'invalid', reason: 'arquivo ilegível' };
  }
  if (!isInside(root, realPath)) {
    return {
      ok: false,
      kind: 'unsafe',
      reason: `caminho resolve fora da raiz do plugin: ${path.basename(file)}`,
    };
  }
  try {
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      return { ok: false, kind: 'invalid', reason: 'não é arquivo regular' };
    }
    if (stat.size > maxBytes) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `arquivo excede o limite de ${maxBytes} bytes`,
      };
    }
    return { ok: true, buffer: fs.readFileSync(realPath), realPath };
  } catch {
    return { ok: false, kind: 'invalid', reason: 'arquivo ilegível' };
  }
}

function parseJson(read: FileRead):
  | { ok: true; value: unknown }
  | { ok: false; kind: 'missing' | 'invalid' | 'unsafe'; reason: string } {
  if (!read.ok) return read;
  try {
    return { ok: true, value: JSON.parse(read.buffer.toString('utf8')) };
  } catch {
    return { ok: false, kind: 'invalid', reason: 'JSON inválido' };
  }
}

function homeRelative(absolute: string, home: string): string {
  const relative = path.relative(home, absolute);
  return relative.startsWith('..') ? path.basename(absolute) : `~/${relative}`;
}

function providerSkillName(plugin: string, skill: string): string {
  const base = `${plugin}-${skill}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (base.length <= 64) return base;
  const digest = createHash('sha256').update(`${plugin}:${skill}`).digest('hex').slice(0, 8);
  return `${base.slice(0, 55).replace(/-+$/g, '')}-${digest}`;
}

function rejectedPlugin(
  source: string,
  status: 'rejected' | 'quarantined',
  reason: string,
): DiscoveredPlugin {
  const verdict: PluginManifestVerdict = { ok: false, reason };
  return Object.freeze({
    source,
    verdict,
    status,
    skills: Object.freeze([]),
    mcpServers: Object.freeze([]),
    notices: Object.freeze([]),
    mappings: Object.freeze({
      skills: {
        source: 'skills/*/SKILL.md' as const,
        nexusConcept: 'catalog.skill' as const,
        loaded: 0,
        skipped: 0,
      },
      mcpServers: {
        source: 'mcp.json' as const,
        nexusConcept: 'mcp-hub.server' as const,
        loaded: 0,
        skipped: 0,
      },
    }),
    limitations: AGENT_PLUGIN_LIMITATIONS,
    summary: `Plugin ${status === 'quarantined' ? 'em quarentena' : 'recusado'}: ${reason}`,
  });
}

interface SkillScanResult {
  skills: DiscoveredPluginSkill[];
  notices: AgentPluginNotice[];
  skipped: number;
  unsafeReason?: string;
}

function scanSkills(
  pluginRoot: string,
  manifest: AcceptedPlugin,
  allowedTools: readonly string[] | null,
): SkillScanResult {
  const skillsRoot = path.join(pluginRoot, 'skills');
  let realSkillsRoot: string;
  try {
    realSkillsRoot = fs.realpathSync(skillsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { skills: [], notices: [], skipped: 0 };
    }
    return {
      skills: [],
      notices: [{ component: 'skills', disposition: 'skipped', why: 'diretório ilegível' }],
      skipped: 1,
    };
  }
  if (!isInside(pluginRoot, realSkillsRoot)) {
    return {
      skills: [],
      notices: [],
      skipped: 0,
      unsafeReason: 'skills resolve fora da raiz do plugin',
    };
  }
  try {
    if (!fs.statSync(realSkillsRoot).isDirectory()) {
      return {
        skills: [],
        notices: [{ component: 'skills', disposition: 'skipped', why: 'local fixo não é diretório' }],
        skipped: 1,
      };
    }
  } catch {
    return {
      skills: [],
      notices: [{ component: 'skills', disposition: 'skipped', why: 'diretório ilegível' }],
      skipped: 1,
    };
  }

  const skills: DiscoveredPluginSkill[] = [];
  const notices: AgentPluginNotice[] = [];
  let skipped = 0;
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(realSkillsRoot, { withFileTypes: true });
  } catch {
    return {
      skills: [],
      notices: [{ component: 'skills', disposition: 'skipped', why: 'diretório ilegível' }],
      skipped: 1,
    };
  }

  for (const child of children.slice(0, MAX_SKILLS)) {
    const childDir = path.join(realSkillsRoot, child.name);
    let realChild: string;
    try {
      realChild = fs.realpathSync(childDir);
    } catch {
      continue;
    }
    if (!isInside(pluginRoot, realChild)) {
      return { skills: [], notices: [], skipped, unsafeReason: `skill ${child.name} resolve fora da raiz do plugin` };
    }
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(realChild).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    const skillFile = path.join(realChild, 'SKILL.md');
    const read = readContainedFile(pluginRoot, skillFile, MAX_SKILL_BYTES);
    if (!read.ok) {
      if (read.kind === 'missing') continue;
      if (read.kind === 'unsafe') {
        return { skills: [], notices: [], skipped, unsafeReason: read.reason };
      }
      skipped += 1;
      notices.push({
        component: 'skills',
        entry: child.name,
        disposition: 'skipped',
        why: read.reason,
      });
      continue;
    }
    const content = read.buffer.toString('utf8');
    const parsed = readAgentPluginSkill({ directoryName: child.name, content });
    if (!parsed.ok) {
      skipped += 1;
      notices.push({
        component: 'skills',
        entry: child.name,
        disposition: 'skipped',
        why: parsed.reason,
      });
      continue;
    }
    const tree = inspectAgentPluginSkillTree(pluginRoot, realChild);
    if (!tree.ok) {
      if (tree.kind === 'unsafe') {
        return { skills: [], notices: [], skipped, unsafeReason: tree.reason };
      }
      skipped += 1;
      notices.push({
        component: 'skills',
        entry: child.name,
        disposition: 'skipped',
        why: tree.reason,
      });
      continue;
    }
    const threat = scanComponentFiles(
      tree.files.map((file) => ({
        name: `skills/${child.name}/${file.name}`,
        buffer: file.buffer,
      })),
    );
    if (threat.blocked) {
      return {
        skills: [],
        notices: [],
        skipped,
        unsafeReason: `conteúdo hostil em ${threat.blockReason ?? child.name}`,
      };
    }
    for (const warning of threat.warnings) {
      notices.push({
        component: 'skills',
        entry: child.name,
        disposition: 'warning',
        why: warning,
      });
    }
    const toolReduction = reduceAgentPluginAllowedTools(
      parsed.skill.declaredAllowedTools,
      allowedTools,
    );
    if (toolReduction.wasReduced) {
      notices.push({
        component: 'skills',
        entry: child.name,
        disposition: 'reduced',
        why: toolReduction.notice ?? 'allowed-tools reduzido pelo gate Nexus',
      });
    }
    const qualifiedName = `${manifest.name}:${parsed.skill.name}`;
    skills.push(Object.freeze({
      name: parsed.skill.name,
      qualifiedName,
      providerName: providerSkillName(manifest.name, parsed.skill.name),
      directory: realChild,
      skillFile: read.realPath,
      metadata: parsed.skill,
      toolReduction,
      catalogEntry: Object.freeze({
        kind: 'skill' as const,
        slug: `agent-plugin/${manifest.name}/${parsed.skill.name}`,
        name: qualifiedName,
        category: 'agent-plugin',
      }),
    }));
  }
  if (children.length > MAX_SKILLS) {
    const omitted = children.length - MAX_SKILLS;
    skipped += omitted;
    notices.push({
      component: 'skills',
      disposition: 'skipped',
      why: `${omitted} entrada(s) além do limite Nexus de ${MAX_SKILLS}`,
    });
  }
  return { skills, notices, skipped };
}

interface McpScanResult {
  servers: DiscoveredPluginMcpServer[];
  notices: AgentPluginNotice[];
  skipped: number;
  unsafeReason?: string;
}

function scanMcp(
  pluginRoot: string,
  pluginDataRoot: string,
): McpScanResult {
  const file = path.join(pluginRoot, 'mcp.json');
  const read = readContainedFile(pluginRoot, file, MAX_MCP_BYTES);
  if (!read.ok) {
    if (read.kind === 'missing') return { servers: [], notices: [], skipped: 0 };
    if (read.kind === 'unsafe') {
      return { servers: [], notices: [], skipped: 0, unsafeReason: read.reason };
    }
    return {
      servers: [],
      notices: [{ component: 'mcpServers', disposition: 'skipped', why: read.reason }],
      skipped: 1,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.buffer.toString('utf8'));
  } catch {
    return {
      servers: [],
      notices: [{ component: 'mcpServers', disposition: 'skipped', why: 'mcp.json contém JSON inválido' }],
      skipped: 1,
    };
  }
  const parsed = readAgentPluginMcp(raw, { pluginRoot, pluginDataRoot });
  if (!parsed.ok) {
    return {
      servers: [],
      notices: [{ component: 'mcpServers', disposition: 'skipped', why: parsed.reason }],
      skipped: 1,
    };
  }
  for (const server of parsed.servers) {
    if (server.transport !== 'stdio' || !path.isAbsolute(server.command)) continue;
    if (!isInside(pluginRoot, server.command)) continue;
    try {
      const realCommand = fs.realpathSync(server.command);
      if (!isInside(pluginRoot, realCommand)) {
        return {
          servers: [],
          notices: [],
          skipped: parsed.degraded.length,
          unsafeReason: `comando MCP ${server.name} resolve fora da raiz do plugin`,
        };
      }
    } catch {
      // Start/connect failure is a runtime component failure, not ingestion.
    }
  }
  return {
    servers: parsed.servers.map((server) =>
      Object.freeze({ ...server, nexusConcept: 'mcp-hub-server' as const }),
    ),
    notices: parsed.degraded.map((notice) => ({
      component: notice.component,
      entry: notice.entry,
      disposition: 'skipped' as const,
      why: notice.why,
    })),
    skipped: parsed.degraded.length,
  };
}

function scanPluginDirectory(
  pluginDir: string,
  home: string,
  options: ScanInstalledPluginsOptions,
  claudeInstall = false,
): DiscoveredPlugin {
  const source = homeRelative(pluginDir, home);
  let pluginRoot: string;
  try {
    const lstat = fs.lstatSync(pluginDir);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
      return rejectedPlugin(source, 'quarantined', 'raiz do plugin não é diretório real');
    }
    pluginRoot = fs.realpathSync(pluginDir);
  } catch {
    return rejectedPlugin(source, 'rejected', 'diretório do plugin ilegível');
  }

  let manifestRead = parseJson(
    readContainedFile(pluginRoot, path.join(pluginRoot, 'plugin.json'), MAX_MANIFEST_BYTES),
  );
  // F-1333: instalação do Claude Code guarda o manifesto em .claude-plugin/.
  if (claudeInstall && !manifestRead.ok && manifestRead.kind === 'missing') {
    manifestRead = parseJson(
      readContainedFile(
        pluginRoot,
        path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
        MAX_MANIFEST_BYTES,
      ),
    );
  }
  if (!manifestRead.ok) {
    const status = manifestRead.kind === 'unsafe' ? 'quarantined' : 'rejected';
    return rejectedPlugin(source, status, `plugin.json: ${manifestRead.reason}`);
  }
  const manifest = readPluginManifest(manifestRead.value);
  if (!manifest.ok) return rejectedPlugin(source, 'rejected', manifest.reason);

  const allowedTools = options.allowedTools === undefined ? [] : options.allowedTools;
  const skills = scanSkills(pluginRoot, manifest, allowedTools);
  if (skills.unsafeReason) {
    return rejectedPlugin(source, 'quarantined', skills.unsafeReason);
  }
  const pluginDataRoot = path.join(home, '.nexus', 'plugin-data', manifest.name);
  const mcp = scanMcp(pluginRoot, pluginDataRoot);
  if (mcp.unsafeReason) {
    return rejectedPlugin(source, 'quarantined', mcp.unsafeReason);
  }

  const notices: AgentPluginNotice[] = [
    ...manifest.degraded.map((notice) => ({
      component: notice.component,
      disposition: 'ignored' as const,
      why: notice.why,
    })),
    ...skills.notices,
    ...mcp.notices,
  ];
  const status = notices.length > 0 ? 'degraded' : 'accepted';
  const summaryBase =
    `${manifest.name} ${manifest.version || 'sem versão'}: ` +
    `${skills.skills.length} skill(s), ${mcp.servers.length} servidor(es) MCP`;
  const summary =
    notices.length === 0
      ? summaryBase
      : `${summaryBase} — reduzido/ignorado: ${notices
          .map((notice) => `${notice.component}${notice.entry ? `.${notice.entry}` : ''}: ${notice.why}`)
          .join('; ')}`;

  return Object.freeze({
    source,
    rootDir: pluginRoot,
    verdict: manifest,
    status,
    skills: Object.freeze(skills.skills),
    mcpServers: Object.freeze(mcp.servers),
    notices: Object.freeze(notices),
    mappings: Object.freeze({
      skills: Object.freeze({
        source: 'skills/*/SKILL.md' as const,
        nexusConcept: 'catalog.skill' as const,
        loaded: skills.skills.length,
        skipped: skills.skipped,
      }),
      mcpServers: Object.freeze({
        source: 'mcp.json' as const,
        nexusConcept: 'mcp-hub.server' as const,
        loaded: mcp.servers.length,
        skipped: mcp.skipped,
      }),
    }),
    limitations: AGENT_PLUGIN_LIMITATIONS,
    summary,
  });
}

// A6 (perf spawn): ensureSkillsForCli roda em TODO spawn e o scan de plugins
// (readdir + manifests) era refeito a cada chamada. TTL 60s no padrão do
// jev-skill-suggestion — instalar um plugin aparece no spawn seguinte.
const SCAN_CACHE_TTL_MS = 60_000;
const scanCache = new Map<
  string,
  { at: number; found: readonly DiscoveredPlugin[] }
>();

/** Uma entrada por (home, lista de tools); listas distintas não crescem sem fim. */
const SCAN_CACHE_MAX_ENTRIES = 32;

function rememberScan(key: string, now: number, found: readonly DiscoveredPlugin[]): void {
  for (const [held, entry] of scanCache) {
    if (now - entry.at >= SCAN_CACHE_TTL_MS) scanCache.delete(held);
  }
  scanCache.delete(key);
  // Map preserva a ordem de inserção: o primeiro é o mais antigo.
  while (scanCache.size >= SCAN_CACHE_MAX_ENTRIES) {
    const oldest = scanCache.keys().next().value;
    if (oldest === undefined) break;
    scanCache.delete(oldest);
  }
  scanCache.set(key, { at: now, found });
}

/** Test hook. */
export function __resetScanInstalledPluginsCacheForTests(): void {
  scanCache.clear();
}

/** Test hook. */
export function __scanInstalledPluginsCacheSizeForTests(): number {
  return scanCache.size;
}

export function scanInstalledPlugins(
  home: string = os.homedir(),
  options: ScanInstalledPluginsOptions = {},
): readonly DiscoveredPlugin[] {
  // #22: com lista explícita (inventário MCP, espelho de skills no spawn) o
  // scan síncrono custava ~10 ms por chamada. Uma entrada por lista EFETIVA:
  // sem lista vale [] (scanPluginDirectory), diferente de null; a ordem não
  // muda o filtro.
  const effective = options.allowedTools === undefined ? [] : options.allowedTools;
  const cacheKey = `${home}\0${JSON.stringify(effective === null ? null : [...effective].sort())}`;
  const now = Date.now();
  const hit = scanCache.get(cacheKey);
  if (hit && now - hit.at < SCAN_CACHE_TTL_MS) return hit.found;
  const found: DiscoveredPlugin[] = [];
  for (const root of PLUGIN_ROOTS) {
    const rootDir = path.join(home, root);
    const installs =
      root === '.claude/plugins' ? claudeCodeInstalls(rootDir, home, options) : null;
    if (installs) {
      for (const plugin of installs) {
        if (found.length >= MAX_PLUGINS) {
          const frozen = Object.freeze(found);
          rememberScan(cacheKey, now, frozen);
          return frozen;
        }
        found.push(plugin);
      }
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= MAX_PLUGINS) {
        const frozen = Object.freeze(found);
        rememberScan(cacheKey, now, frozen);
        return frozen;
      }
      // F-1333: .trash e afins nunca são raiz de plugin.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      found.push(scanPluginDirectory(path.join(rootDir, entry.name), home, options));
    }
  }
  const frozen = Object.freeze(found);
  rememberScan(cacheKey, now, frozen);
  return frozen;
}

/**
 * F-1333: no layout do Claude Code, ~/.claude/plugins guarda cache/, data/,
 * marketplaces/… — pastas internas, não plugins. Os plugins de verdade são os
 * `installPath` do installed_plugins.json. Sem esse arquivo → null (varredura
 * por filho direto, o layout antigo).
 */
function claudeCodeInstalls(
  rootDir: string,
  home: string,
  options: ScanInstalledPluginsOptions,
): DiscoveredPlugin[] | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    return null;
  }
  const indexFile = path.join(realRoot, 'installed_plugins.json');
  const read = parseJson(readContainedFile(realRoot, indexFile, MAX_MANIFEST_BYTES));
  if (!read.ok && read.kind === 'missing') return null;
  const source = homeRelative(indexFile, home);
  if (!read.ok) return [rejectedPlugin(source, 'rejected', `installed_plugins.json: ${read.reason}`)];
  const plugins = (read.value as { plugins?: unknown } | null)?.plugins;
  if (!plugins || typeof plugins !== 'object') {
    return [rejectedPlugin(source, 'rejected', 'installed_plugins.json: sem objeto "plugins"')];
  }
  const dirs = new Set<string>();
  for (const value of Object.values(plugins)) {
    for (const install of Array.isArray(value) ? value : [value]) {
      const installPath = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath === 'string' && installPath) dirs.add(path.resolve(installPath));
    }
  }
  const realOrSelf = (dir: string): string => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  };
  return [...dirs].map((dir) => {
    const real = realOrSelf(dir);
    // Mostrado pela raiz vista do HOME (o ~/.claude/plugins pode ser symlink).
    return isInside(realRoot, real)
      ? scanPluginDirectory(path.join(rootDir, path.relative(realRoot, real)), home, options, true)
      : rejectedPlugin(
          homeRelative(dir, home),
          'quarantined',
          'installPath fora de ~/.claude/plugins',
        );
  });
}
