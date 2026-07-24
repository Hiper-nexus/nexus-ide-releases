import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBackOverlayAuth } from "./overlay-auth-syncback";
import {
  hasNexusMcpCapability,
  type CliPtyAdapter,
} from "../../shared/adapter-types";
import {
  purgeOwnedSessionRoot,
  type ArtifactPurgeResult,
} from "./ephemeral-artifact-purge";

/**
 * Injeção REAL do servidor MCP embutido do Nexus nos CLIs não-Claude, para que
 * workers Codex/AGY/OpenCode/Kimi/Grok chamem as tools `nexus_*` e submetam handoff
 * — não só receba env vars de consciência (gap da auditoria 2026-07-06 §4).
 *
 * - Codex: overrides `-c mcp_servers.nexus_<random>.*` no argv (HTTP),
 *   referenciando o bearer somente pela env efêmera do processo.
 * - AGY/Antigravity: HOME-overlay privado por sessão com `mcp_config.json`
 *   nos layouts atual e legado. O bearer nunca entra no workspace nem no
 *   perfil compartilhado do usuário.
 * - OpenCode: config inline oficial, com bearer resolvido da env da sessão.
 * - Kimi/Grok: overlays privados dos respectivos homes de provider; os
 *   configs referenciam `NEXUS_MCP_TOKEN` sem persistir o segredo.
 *
 * Claude e família (mcpAutoload) continuam pelo `--mcp-config` existente.
 */

export type McpInjectionKind =
  | "codex"
  | "agy"
  | "opencode"
  | "kimi"
  | "grok"
  | "omp";
type NexusMcpAdapter = Pick<CliPtyAdapter, "quirks">;
type NexusMcpAdapterLike = {
  quirks: { mcpAutoload?: boolean; nexusMcp?: unknown };
};

/** Retorna o "sabor" de injeção não-autoload, ou null quando não se aplica. */
export function supportsMcpInjection(
  adapter: NexusMcpAdapter,
): McpInjectionKind | null {
  const integration = adapter.quirks.nexusMcp;
  return integration === "codex" ||
    integration === "agy" ||
    integration === "opencode" ||
    integration === "kimi" ||
    integration === "grok" ||
    integration === "omp"
    ? integration
    : null;
}

/** Source of truth shared by spawn contracts and renderer metadata. */
export function canUseNexusMcp(adapter: NexusMcpAdapterLike): boolean {
  return hasNexusMcpCapability(adapter.quirks);
}

const CODEX_MCP_SERVER_RANDOM_BYTES = 6;
const CODEX_MCP_TOKEN_ENV_VAR = "NEXUS_MCP_TOKEN";

/**
 * Overrides de config do Codex para um servidor MCP streamable-HTTP.
 *
 * O segundo argumento legado é intencionalmente ignorado para manter
 * compatibilidade com callers durante o rollout. O segredo nunca entra no
 * argv; o Codex lê o valor de `NEXUS_MCP_TOKEN` no ambiente do processo.
 */
/**
 * Bound MCP tool latency so a hung tools/call (e.g. concurrent Promise.all
 * from Codex `exec`) fails closed instead of parking the orchestrator forever
 * and starving handoff delivery / plan sealing.
 */
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 45;

export function codexMcpArgs(url: string, _legacyToken?: string): string[] {
  const serverName =
    `nexus_${randomBytes(CODEX_MCP_SERVER_RANDOM_BYTES).toString("hex")}`;
  return [
    "-c",
    `mcp_servers.${serverName}.url=${JSON.stringify(url)}`,
    "-c",
    `mcp_servers.${serverName}.bearer_token_env_var=${JSON.stringify(CODEX_MCP_TOKEN_ENV_VAR)}`,
    "-c",
    `mcp_servers.${serverName}.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`,
  ];
}

export interface GeminiMcpFragment {
  mcpServers: {
    nexus: {
      httpUrl: string;
      headers: { Authorization: string };
      trust: true;
    };
  };
}

export interface AgyMcpFragment {
  mcpServers: {
    nexus: {
      serverUrl: string;
      headers: { Authorization: string };
    };
  };
}

export interface AgyMcpConfigOptions {
  home?: string;
  artifactRoot?: string;
  /**
   * Managed Gemini/AGY home (GEMINI_CLI_HOME from account materialize).
   * When set, auth/config are overlaid from this tree instead of ~/.gemini.
   */
  geminiHome?: string;
}

export interface AgyMcpConfigResult {
  homeDir: string;
  geminiHomeDir: string;
  configPaths: [string, string];
}

const activeAgyHomes = new Map<string, { homeDir: string; realHome: string }>();

export function purgeStaleAgyMcpConfigs(
  options: AgyMcpConfigOptions = {},
): ArtifactPurgeResult {
  const home = path.resolve(options.home ?? os.homedir());
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(home, ".nexus", "ephemeral", "agy"),
  );
  return purgeOwnedSessionRoot(
    artifactRoot,
    Array.from(activeAgyHomes.values(), (s) => s.homeDir),
    options.artifactRoot ? path.dirname(artifactRoot) : home,
  );
}

export function geminiMcpFragment(
  url: string,
  token: string,
): GeminiMcpFragment {
  return {
    mcpServers: {
      nexus: {
        httpUrl: url,
        headers: { Authorization: `Bearer ${token}` },
        trust: true,
      },
    },
  };
}

export function agyMcpFragment(url: string, token: string): AgyMcpFragment {
  return {
    mcpServers: {
      nexus: {
        serverUrl: url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

/** Merge puro: preserva o settings existente e injeta/atualiza mcpServers.nexus. */
export function mergeGeminiSettings(
  existing: unknown,
  fragment: GeminiMcpFragment,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const prevServers =
    base.mcpServers && typeof base.mcpServers === "object"
      ? (base.mcpServers as Record<string, unknown>)
      : {};
  base.mcpServers = { ...prevServers, nexus: fragment.mcpServers.nexus };
  return base;
}

function mergeAgyMcpConfig(
  existing: unknown,
  fragment: AgyMcpFragment,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const previous =
    base.mcpServers && typeof base.mcpServers === "object"
      ? (base.mcpServers as Record<string, unknown>)
      : {};
  return {
    ...base,
    mcpServers: { ...previous, nexus: fragment.mcpServers.nexus },
  };
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort; the original error remains authoritative.
      }
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function linkDirectoryEntry(
  entry: fs.Dirent,
  sourcePath: string,
  targetPath: string,
): void {
  if (process.platform !== "win32") {
    fs.symlinkSync(sourcePath, targetPath);
    return;
  }
  const isDirectory =
    entry.isDirectory() || fs.statSync(sourcePath).isDirectory();
  if (isDirectory) {
    fs.symlinkSync(sourcePath, targetPath, "junction");
    return;
  }
  try {
    fs.linkSync(sourcePath, targetPath);
  } catch {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function linkDirectoryEntries(
  source: string,
  target: string,
  excluded: Set<string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    linkDirectoryEntry(entry, sourcePath, targetPath);
  }
}

function buildAgyHomeOverlay(
  realHome: string,
  homeDir: string,
  geminiSource?: string,
): void {
  ensurePrivateDirectory(homeDir);
  linkDirectoryEntries(realHome, homeDir, new Set([".gemini", ".nexus"]));

  const realGemini = path.resolve(
    geminiSource ?? path.join(realHome, ".gemini"),
  );
  const privateGemini = path.join(homeDir, ".gemini");
  ensurePrivateDirectory(privateGemini);
  linkDirectoryEntries(
    realGemini,
    privateGemini,
    new Set(["config", "antigravity-cli"]),
  );
}

function writeAgyConfigOverlay(
  realHome: string,
  homeDir: string,
  relativeDir: string,
  fragment: AgyMcpFragment,
  geminiSource?: string,
): string {
  const geminiRoot = path.resolve(
    geminiSource ?? path.join(realHome, ".gemini"),
  );
  const sourceDir = path.join(geminiRoot, relativeDir);
  const targetDir = path.join(homeDir, ".gemini", relativeDir);
  ensurePrivateDirectory(targetDir);
  linkDirectoryEntries(sourceDir, targetDir, new Set(["mcp_config.json"]));

  const sourceConfig = path.join(sourceDir, "mcp_config.json");
  const targetConfig = path.join(targetDir, "mcp_config.json");
  writeJsonAtomic(
    targetConfig,
    mergeAgyMcpConfig(readJson(sourceConfig), fragment),
  );
  return targetConfig;
}

/**
 * Prepara um HOME-overlay exclusivo para um processo AGY. O restante do HOME
 * continua visível por symlink para preservar login, git, skills e histórico;
 * somente os MCP configs são cópias privadas contendo o bearer desta sessão.
 */
export function prepareAgyMcpConfig(
  url: string,
  token: string,
  options: AgyMcpConfigOptions = {},
): AgyMcpConfigResult {
  const realHome = path.resolve(options.home ?? os.homedir());
  const geminiSource = options.geminiHome
    ? path.resolve(options.geminiHome)
    : undefined;
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(realHome, ".nexus", "ephemeral", "agy"),
  );
  const sessionKey = createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 32);
  const homeDir = path.join(artifactRoot, sessionKey);
  cleanupAgyMcpConfig(token);
  ensurePrivateDirectory(artifactRoot);
  fs.rmSync(homeDir, { recursive: true, force: true });

  try {
    buildAgyHomeOverlay(realHome, homeDir, geminiSource);
    const fragment = agyMcpFragment(url, token);
    const modern = writeAgyConfigOverlay(
      realHome,
      homeDir,
      "config",
      fragment,
      geminiSource,
    );
    const cli = writeAgyConfigOverlay(
      realHome,
      homeDir,
      "antigravity-cli",
      fragment,
      geminiSource,
    );
    activeAgyHomes.set(token, { homeDir, realHome });
    return {
      homeDir,
      geminiHomeDir: path.join(homeDir, ".gemini"),
      configPaths: [modern, cli],
    };
  } catch (error) {
    fs.rmSync(homeDir, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Oh My Pi (omp) — HOME-overlay privado por sessão, no mesmo desenho do AGY.
//
// O omp resolve config de usuário em `~/.omp/agent/` (mcp.json, agent.db,
// sessions/, blobs/). Profiles (`OMP_PROFILE`) relocariam TAMBÉM `agent.db`
// e as sessões — quebrando o login/OAuth do usuário — e o schema de MCP
// deles não interpola env vars em headers. Portanto: HOME privado com
// symlinks preservando login/histórico, e somente `agent/mcp.json` como
// cópia privada contendo o bearer desta sessão (0600, purgado no teardown).
// ---------------------------------------------------------------------------

export interface OmpMcpFragment {
  mcpServers: {
    nexus: {
      type: "http";
      url: string;
      headers: { Authorization: string };
    };
  };
}

export interface OmpMcpConfigOptions {
  home?: string;
  artifactRoot?: string;
}

export interface OmpMcpConfigResult {
  homeDir: string;
  configPath: string;
}

const activeOmpHomes = new Map<string, { homeDir: string; realHome: string }>();

export function ompMcpFragment(url: string, token: string): OmpMcpFragment {
  return {
    mcpServers: {
      nexus: {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

/** Merge puro: preserva o mcp.json existente e injeta/atualiza mcpServers.nexus. */
export function mergeOmpMcpConfig(
  existing: unknown,
  fragment: OmpMcpFragment,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const previous =
    base.mcpServers && typeof base.mcpServers === "object"
      ? (base.mcpServers as Record<string, unknown>)
      : {};
  return {
    ...base,
    mcpServers: { ...previous, nexus: fragment.mcpServers.nexus },
  };
}

export function purgeStaleOmpMcpConfigs(
  options: OmpMcpConfigOptions = {},
): ArtifactPurgeResult {
  const home = path.resolve(options.home ?? os.homedir());
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(home, ".nexus", "ephemeral", "omp"),
  );
  return purgeOwnedSessionRoot(
    artifactRoot,
    Array.from(activeOmpHomes.values(), (s) => s.homeDir),
    options.artifactRoot ? path.dirname(artifactRoot) : home,
  );
}

function buildOmpHomeOverlay(realHome: string, homeDir: string): void {
  ensurePrivateDirectory(homeDir);
  linkDirectoryEntries(realHome, homeDir, new Set([".omp", ".nexus"]));

  const realOmp = path.join(realHome, ".omp");
  const privateOmp = path.join(homeDir, ".omp");
  ensurePrivateDirectory(privateOmp);
  linkDirectoryEntries(realOmp, privateOmp, new Set(["agent"]));

  // Garante que a árvore REAL exista antes do overlay: assim `agent.db`,
  // `sessions/` e `blobs/` viram symlinks e toda escrita do pane persiste
  // no perfil verdadeiro do usuário (login feito dentro do pane incluído).
  const realAgent = path.join(realOmp, "agent");
  fs.mkdirSync(path.join(realAgent, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(realAgent, "blobs"), { recursive: true });
  const privateAgent = path.join(privateOmp, "agent");
  ensurePrivateDirectory(privateAgent);
  linkDirectoryEntries(realAgent, privateAgent, new Set(["mcp.json"]));
}

/**
 * Prepara um HOME-overlay exclusivo para um processo omp. O restante do HOME
 * continua visível por symlink para preservar login (agent.db), sessões e
 * skills; somente `~/.omp/agent/mcp.json` é cópia privada contendo o bearer
 * desta sessão.
 */
export function prepareOmpMcpConfig(
  url: string,
  token: string,
  options: OmpMcpConfigOptions = {},
): OmpMcpConfigResult {
  const realHome = path.resolve(options.home ?? os.homedir());
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(realHome, ".nexus", "ephemeral", "omp"),
  );
  const sessionKey = createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 32);
  const homeDir = path.join(artifactRoot, sessionKey);
  cleanupOmpMcpConfig(token);
  ensurePrivateDirectory(artifactRoot);
  fs.rmSync(homeDir, { recursive: true, force: true });

  try {
    buildOmpHomeOverlay(realHome, homeDir);
    const configPath = path.join(homeDir, ".omp", "agent", "mcp.json");
    const realConfig = path.join(realHome, ".omp", "agent", "mcp.json");
    writeJsonAtomic(
      configPath,
      mergeOmpMcpConfig(readJson(realConfig), ompMcpFragment(url, token)),
    );
    activeOmpHomes.set(token, { homeDir, realHome });
    return { homeDir, configPath };
  } catch (error) {
    fs.rmSync(homeDir, { recursive: true, force: true });
    throw error;
  }
}

/** Remove somente os artefatos privados associados ao token informado. */
export function cleanupOmpMcpConfig(token: string): void {
  const session = activeOmpHomes.get(token);
  if (!session) return;
  activeOmpHomes.delete(token);
  // Arquivos NOVOS que o omp tenha criado direto em `agent/` do overlay
  // (primeiro uso sem `agent.db` real, caches novos) voltam para o perfil
  // verdadeiro antes do purge — o mcp.json com o bearer nunca.
  try {
    syncBackOverlayAuth(
      path.join(session.homeDir, ".omp", "agent"),
      path.join(session.realHome, ".omp", "agent"),
      new Set(),
      new Set(["mcp.json"]),
    );
  } catch {
    // Never let a sync-back failure block teardown.
  }
  try {
    fs.rmSync(session.homeDir, { recursive: true, force: true });
  } catch {
    // Best effort on process/session teardown.
  }
}

/** Remove somente os artefatos privados associados ao token informado. */
export function cleanupAgyMcpConfig(token: string): void {
  const session = activeAgyHomes.get(token);
  if (!session) return;
  activeAgyHomes.delete(token);
  // Persist a fresh in-pane AGY login (.gemini/antigravity[-cli]) before the
  // overlay is removed, skipping the token-bearing mcp_config.json at any depth.
  try {
    syncBackOverlayAuth(
      path.join(session.homeDir, ".gemini"),
      path.join(session.realHome, ".gemini"),
      new Set(),
      new Set(["mcp_config.json"]),
    );
  } catch {
    // Never let a sync-back failure block teardown.
  }
  try {
    fs.rmSync(session.homeDir, { recursive: true, force: true });
  } catch {
    // Best effort on process/session teardown.
  }
}
