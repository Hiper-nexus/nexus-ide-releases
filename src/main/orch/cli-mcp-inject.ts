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
import {
  resolveGovernedCliProfile,
  stripExecutableProfileConfig,
  type GovernedCliProfileOptions,
} from "./governed-cli-profile";
import { ensureSkillsForCli } from "./skill-mirror";
import { removeTreeSync } from '../util/remove-tree';

/**
 * Injeção REAL do servidor MCP embutido do Nexus nos CLIs não-Claude, para que
 * workers Codex/OpenCode/Kimi/Grok chamem as tools `nexus_*` e submetam handoff
 * — não só receba env vars de consciência (gap da auditoria 2026-07-06 §4).
 *
 * - Codex: overrides `-c mcp_servers.nexus_<random>.*` no argv (HTTP),
 *   referenciando o bearer somente pela env efêmera do processo.
 * - AGY/Antigravity 1.1: intentionally absent. It ignores private HOME
 *   projections for MCP and completes mission tasks through PTY stream.
 * - OpenCode: config inline oficial, com bearer resolvido da env da sessão.
 * - Kimi/Grok: overlays privados dos respectivos homes de provider; os
 *   configs referenciam `NEXUS_MCP_TOKEN` sem persistir o segredo.
 *
 * Claude e família (mcpAutoload) continuam pelo `--mcp-config` existente.
 */

export type McpInjectionKind =
  "codex" | "opencode" | "kimi" | "grok" | "mimo-code" | "minimax-code";
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
    integration === "opencode" ||
    integration === "mimo-code" ||
    integration === "minimax-code" ||
    integration === "kimi" ||
    integration === "grok"
    ? integration
    : null;
}

/** Source of truth shared by spawn contracts and renderer metadata. */
export function canUseNexusMcp(adapter: NexusMcpAdapterLike): boolean {
  // AGY 1.1 resolves MCP config from the real native profile and ignores the
  // private HOME/GEMINI_CLI_HOME projection. Advertising it as MCP-capable
  // makes workers wait forever. Its physical completion route is PTY stream.
  if (adapter.quirks.nexusMcp === "agy") return false;
  if (hasNexusMcpCapability(adapter.quirks)) return true;
  // Lei física do binário (bug E, 2026-08-17): adapter de usuário que roda o
  // binário `claude` contra endpoint terceiro (deepseek/qwen/sakana…) podia
  // declarar nexusMcp none/mcpAutoload false — o worker nascia SEM o MCP do
  // Nexus (só o bloco NEXUS_HANDOFF de texto). O Claude Code aceita
  // --mcp-config/--settings em QUALQUER endpoint; a família é do binário.
  return (adapter as { bin?: string }).bin === "claude";
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
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 120;

export interface CodexMcpArgsOptions {
  /**
   * The native mission approval already authorized this exact main-owned,
   * bearer-bound server. Pre-approve only its tools; ambient/user MCP servers
   * remain outside this random namespace and keep their provider policy.
   */
  readonly approveBoundTools?: boolean;
}

export function codexMcpArgs(
  url: string,
  _legacyToken?: string,
  options: CodexMcpArgsOptions = {},
): string[] {
  const serverName = `nexus_${randomBytes(CODEX_MCP_SERVER_RANDOM_BYTES).toString("hex")}`;
  const args = [
    "-c",
    `mcp_servers.${serverName}.url=${JSON.stringify(url)}`,
    "-c",
    `mcp_servers.${serverName}.bearer_token_env_var=${JSON.stringify(CODEX_MCP_TOKEN_ENV_VAR)}`,
    "-c",
    `mcp_servers.${serverName}.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`,
  ];
  if (options.approveBoundTools) {
    args.push(
      "-c",
      `mcp_servers.${serverName}.default_tools_approval_mode="approve"`,
    );
  }
  return args;
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

export interface AgyMcpConfigOptions extends GovernedCliProfileOptions {
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

const activeAgyHomes = new Map<
  string,
  { homeDir: string; realHome: string; syncBack: boolean }
>();

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
  strict = false,
): Record<string, unknown> {
  const original =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const base = strict ? stripExecutableProfileConfig(original) : original;
  const previous =
    !strict && base.mcpServers && typeof base.mcpServers === "object"
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

function linkSelectedEntries(
  source: string,
  target: string,
  allowed: ReadonlySet<string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!allowed.has(entry.name)) continue;
    linkDirectoryEntry(
      entry,
      path.join(source, entry.name),
      path.join(target, entry.name),
    );
  }
}

function buildAgyHomeOverlay(
  realHome: string,
  homeDir: string,
  geminiSource?: string,
  governed = false,
): void {
  ensurePrivateDirectory(homeDir);
  if (governed) {
    linkSelectedEntries(realHome, homeDir, new Set([".gitconfig"]));
  } else {
    linkDirectoryEntries(realHome, homeDir, new Set([".gemini", ".nexus"]));
  }

  const realGemini = path.resolve(
    geminiSource ?? path.join(realHome, ".gemini"),
  );
  const privateGemini = path.join(homeDir, ".gemini");
  ensurePrivateDirectory(privateGemini);
  if (governed) {
    linkSelectedEntries(
      realGemini,
      privateGemini,
      new Set([
        "google_accounts.json",
        "history",
        "installation_id",
        "oauth_creds.json",
        "projects.json",
        "state.json",
      ]),
    );
  } else {
    linkDirectoryEntries(
      realGemini,
      privateGemini,
      new Set(["config", "antigravity-cli"]),
    );
  }
}

function writeAgyConfigOverlay(
  realHome: string,
  homeDir: string,
  relativeDir: string,
  fragment: AgyMcpFragment,
  geminiSource?: string,
  governed = false,
): string {
  const geminiRoot = path.resolve(
    geminiSource ?? path.join(realHome, ".gemini"),
  );
  const sourceDir = path.join(geminiRoot, relativeDir);
  const targetDir = path.join(homeDir, ".gemini", relativeDir);
  ensurePrivateDirectory(targetDir);
  linkDirectoryEntries(
    sourceDir,
    targetDir,
    governed
      ? new Set([
          "agents",
          "commands",
          "extensions",
          "hooks",
          "mcp_config.json",
          "plugins",
          "sidecars",
          "skills",
        ])
      : new Set(["mcp_config.json"]),
  );

  const sourceConfig = path.join(sourceDir, "mcp_config.json");
  const targetConfig = path.join(targetDir, "mcp_config.json");
  writeJsonAtomic(
    targetConfig,
    mergeAgyMcpConfig(readJson(sourceConfig), fragment, governed),
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
  removeTreeSync(homeDir, { recursive: true, force: true });
  const policy = resolveGovernedCliProfile(token, options);

  try {
    buildAgyHomeOverlay(realHome, homeDir, geminiSource, policy.governed);
    const fragment = agyMcpFragment(url, token);
    const modern = writeAgyConfigOverlay(
      realHome,
      homeDir,
      "config",
      fragment,
      geminiSource,
      policy.governed,
    );
    const cli = writeAgyConfigOverlay(
      realHome,
      homeDir,
      "antigravity-cli",
      fragment,
      geminiSource,
      policy.governed,
    );
    if (policy.governed) {
      const skillDirs = [
        path.join(homeDir, ".gemini", "config", "skills"),
        path.join(homeDir, ".gemini", "antigravity", "skills"),
        path.join(homeDir, ".gemini", "antigravity-cli", "skills"),
        path.join(homeDir, ".gemini", "antigravity-ide", "skills"),
      ];
      for (const skillDir of skillDirs) ensurePrivateDirectory(skillDir);
      ensureSkillsForCli("agy", {
        home: realHome,
        allowedSkills: [...policy.allowedSkills],
        allowedTools:
          policy.allowedTools === null ? null : [...policy.allowedTools],
        targetDirs: skillDirs,
        includeCliTarget: false,
      });
    }
    activeAgyHomes.set(token, {
      homeDir,
      realHome,
      syncBack: !policy.governed,
    });
    return {
      homeDir,
      geminiHomeDir: path.join(homeDir, ".gemini"),
      configPaths: [modern, cli],
    };
  } catch (error) {
    removeTreeSync(homeDir, { recursive: true, force: true });
    throw error;
  }
}

/** Remove somente os artefatos privados associados ao token informado. */
export function cleanupAgyMcpConfig(token: string): void {
  const session = activeAgyHomes.get(token);
  if (!session) return;
  activeAgyHomes.delete(token);
  // Persist a fresh in-pane AGY login (.gemini/antigravity[-cli]) before the
  // overlay is removed, skipping the token-bearing mcp_config.json at any depth.
  if (session.syncBack) {
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
  }
  try {
    removeTreeSync(session.homeDir, { recursive: true, force: true });
  } catch {
    // Best effort on process/session teardown.
  }
}
