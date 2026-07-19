import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  mergeArtifactPurgeResults,
  purgeOwnedSessionRoot,
  type ArtifactPurgeResult,
} from './ephemeral-artifact-purge';
import {
  GROK_STATUS_HOOKS_FILE,
  grokStatusHooksDocument,
  mergeKimiStatusHooks,
} from './hook-status-config';
import { syncBackOverlayAuth } from './overlay-auth-syncback';

/**
 * Per-session MCP configuration for CLIs that do not accept Nexus' native
 * `--mcp-config` shape. Nothing here writes into the workspace or mutates a
 * provider's real profile. Kimi/Grok overlays are removed on PTY exit.
 */

export interface CliMcpSessionOptions {
  home?: string;
  providerHome?: string;
  artifactRoot?: string;
}

export interface CliMcpSessionResult {
  env: Record<string, string>;
  extraArgs: string[];
  serverName: string;
  artifactDir: string | null;
}

export interface CliMcpPurgeOptions {
  home?: string;
  artifactRoot?: string;
}

interface ArtifactSession {
  artifactDir: string;
  /** Real provider home to persist a fresh in-pane login back into. */
  providerHome: string;
  /** Top-level overlay config files (token/marker-bearing) — never synced back. */
  configFiles: readonly string[];
  /** Basenames excluded from sync-back at ANY depth (e.g. Grok hooks/nexus.json). */
  syncBackExcludeAnywhere?: ReadonlySet<string>;
}

const activeArtifactDirs = new Map<string, ArtifactSession>();
const MAX_GROK_CONFIG_BYTES = 1_048_576;
const MAX_GROK_CONFIG_DEPTH = 64;

function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function runtimeServerName(token: string): string {
  return `nexus_${sessionHash(token).slice(0, 12)}`;
}

function validateInputs(url: string, token: string): void {
  if (!token) throw new Error('Nexus MCP token is required');
  const parsed = new URL(url);
  const isLoopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'http:' || !isLoopback) {
    throw new Error('Nexus MCP endpoint must be loopback HTTP');
  }
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writePrivateFileAtomic(file: string, value: string): void {
  ensurePrivateDirectory(path.dirname(file));
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, value, 'utf8');
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
        // Preserve the original failure.
      }
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path.basename(file)}`);
  }
  return parsed as Record<string, unknown>;
}

function readTomlObject(file: string): Record<string, unknown> {
  let raw: string;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_GROK_CONFIG_BYTES) {
      throw new Error('Grok config.toml exceeds the safe overlay size');
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parse(raw, { maxDepth: MAX_GROK_CONFIG_DEPTH }) as Record<
    string,
    unknown
  >;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function linkEntry(source: string, target: string, entry: fs.Dirent): void {
  if (process.platform !== 'win32') {
    fs.symlinkSync(source, target);
    return;
  }
  const isDirectory =
    entry.isDirectory() || (!entry.isSymbolicLink() && fs.statSync(source).isDirectory());
  if (isDirectory) {
    fs.symlinkSync(source, target, 'junction');
    return;
  }
  linkFile(source, target);
}

/** Single-file link with the Windows hardlink/copy fallback (see linkEntry). */
function linkFile(source: string, target: string): void {
  if (process.platform !== 'win32') {
    fs.symlinkSync(source, target);
    return;
  }
  try {
    fs.linkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
  }
}

function linkDirectoryEntries(
  sourceDir: string,
  targetDir: string,
  excluded: ReadonlySet<string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    linkEntry(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
      entry,
    );
  }
}

function prepareArtifactDir(
  kind: 'kimi' | 'grok',
  token: string,
  root: string,
): string {
  cleanupCliMcpSession(token);
  ensurePrivateDirectory(root);
  const dir = path.join(root, kind, sessionHash(token).slice(0, 32));
  fs.rmSync(dir, { recursive: true, force: true });
  ensurePrivateDirectory(path.dirname(dir));
  ensurePrivateDirectory(dir);
  return dir;
}

function activateArtifact(token: string, session: ArtifactSession): void {
  activeArtifactDirs.set(token, session);
}

export function purgeStaleCliMcpSessions(
  options: CliMcpPurgeOptions = {},
): ArtifactPurgeResult {
  const home = path.resolve(options.home ?? os.homedir());
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
  );
  const active = Array.from(activeArtifactDirs.values(), (s) => s.artifactDir);
  const trustedBoundary = options.artifactRoot
    ? path.dirname(artifactRoot)
    : home;
  return mergeArtifactPurgeResults(
    purgeOwnedSessionRoot(
      path.join(artifactRoot, 'kimi'),
      active,
      trustedBoundary,
    ),
    purgeOwnedSessionRoot(
      path.join(artifactRoot, 'grok'),
      active,
      trustedBoundary,
    ),
  );
}

/** OpenCode's official highest-priority runtime config; no token reaches disk. */
export function prepareOpenCodeMcpSession(
  url: string,
  token: string,
): CliMcpSessionResult {
  validateInputs(url, token);
  const serverName = runtimeServerName(token);
  const content = {
    mcp: {
      [serverName]: {
        type: 'remote',
        url,
        enabled: true,
        headers: {
          Authorization: 'Bearer {env:NEXUS_MCP_TOKEN}',
        },
      },
    },
  };
  return {
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(content) },
    extraArgs: [],
    serverName,
    artifactDir: null,
  };
}

/**
 * Kimi officially resolves MCP from $KIMI_CODE_HOME/mcp.json. The overlay
 * symlinks all real data and adds only a private, token-free MCP declaration;
 * `bearerTokenEnvVar` reads the already session-scoped Nexus token at runtime.
 * config.toml is overlaid the same way to carry the additive semantic-status
 * hooks (emdash wave 1: flat `hooks = [{event, command}]`, marker-separated);
 * both files stay out of the auth sync-back so they never reach the real
 * profile.
 */
export function prepareKimiMcpSession(
  url: string,
  token: string,
  options: CliMcpSessionOptions = {},
): CliMcpSessionResult {
  validateInputs(url, token);
  const home = path.resolve(options.home ?? os.homedir());
  const providerHome = path.resolve(
    options.providerHome ??
      process.env.KIMI_CODE_HOME ??
      path.join(home, '.kimi-code'),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
  );
  const artifactDir = prepareArtifactDir('kimi', token, artifactRoot);
  const serverName = runtimeServerName(token);

  try {
    linkDirectoryEntries(providerHome, artifactDir, new Set(['mcp.json', 'config.toml']));
    const source = readJsonObject(path.join(providerHome, 'mcp.json'));
    const servers = objectValue(source.mcpServers);
    const merged = {
      ...source,
      mcpServers: {
        ...servers,
        [serverName]: {
          url,
          bearerTokenEnvVar: 'NEXUS_MCP_TOKEN',
          enabled: true,
        },
      },
    };
    writePrivateFileAtomic(
      path.join(artifactDir, 'mcp.json'),
      `${JSON.stringify(merged, null, 2)}\n`,
    );
    // config.toml carries the additive status hooks. A malformed user config
    // must not break the spawn: degrade to a plain link (hooks off, MCP on).
    let tomlMerged: string | null = null;
    try {
      const tomlSource = readTomlObject(path.join(providerHome, 'config.toml'));
      tomlMerged = stringify(mergeKimiStatusHooks(tomlSource), {
        maxDepth: MAX_GROK_CONFIG_DEPTH,
      });
    } catch {
      const realToml = path.join(providerHome, 'config.toml');
      if (fs.existsSync(realToml)) {
        try {
          linkFile(realToml, path.join(artifactDir, 'config.toml'));
        } catch {
          // Best effort — MCP still works without the user config linked in.
        }
      }
    }
    if (tomlMerged !== null) {
      writePrivateFileAtomic(path.join(artifactDir, 'config.toml'), tomlMerged);
    }
    activateArtifact(token, {
      artifactDir,
      providerHome,
      configFiles: ['mcp.json', 'config.toml'],
    });
    return {
      env: { KIMI_CODE_HOME: artifactDir },
      extraArgs: [],
      serverName,
      artifactDir,
    };
  } catch (error) {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Grok 0.2.93 resolves native configuration from $GROK_HOME/config.toml.
 * The private provider-home overlay symlinks auth, sessions, skills and the
 * rest of the real profile, replacing only config.toml. The config references
 * NEXUS_MCP_TOKEN, already scoped to the spawned process, so no bearer is
 * persisted in either the real profile or the ephemeral overlay.
 * The additive semantic-status hooks (emdash wave 1) ship as a Nexus-owned
 * `hooks/nexus.json` inside the overlay — the user's own hooks/ entries are
 * linked through, and nexus.json never syncs back into the real profile.
 */
export function prepareGrokMcpSession(
  url: string,
  token: string,
  options: CliMcpSessionOptions = {},
): CliMcpSessionResult {
  validateInputs(url, token);
  const home = path.resolve(options.home ?? os.homedir());
  const providerHome = path.resolve(
    options.providerHome ?? process.env.GROK_HOME ?? path.join(home, '.grok'),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
  );
  const artifactDir = prepareArtifactDir('grok', token, artifactRoot);
  const serverName = runtimeServerName(token);

  try {
    linkDirectoryEntries(
      providerHome,
      artifactDir,
      new Set(['config.toml', 'hooks']),
    );
    const source = readTomlObject(path.join(providerHome, 'config.toml'));
    const servers = objectValue(source.mcp_servers);
    const merged = {
      ...source,
      mcp_servers: {
        ...servers,
        [serverName]: {
          url,
          enabled: true,
          bearer_token_env_var: 'NEXUS_MCP_TOKEN',
        },
      },
    };
    writePrivateFileAtomic(
      path.join(artifactDir, 'config.toml'),
      stringify(merged, { maxDepth: MAX_GROK_CONFIG_DEPTH }),
    );
    // Status hooks: user entries linked through, Nexus doc written fresh.
    const overlayHooks = path.join(artifactDir, 'hooks');
    ensurePrivateDirectory(overlayHooks);
    linkDirectoryEntries(
      path.join(providerHome, 'hooks'),
      overlayHooks,
      new Set([GROK_STATUS_HOOKS_FILE]),
    );
    writePrivateFileAtomic(
      path.join(overlayHooks, GROK_STATUS_HOOKS_FILE),
      `${JSON.stringify(grokStatusHooksDocument(), null, 2)}\n`,
    );
    activateArtifact(token, {
      artifactDir,
      providerHome,
      configFiles: ['config.toml'],
      syncBackExcludeAnywhere: new Set([GROK_STATUS_HOOKS_FILE]),
    });
    return {
      env: { GROK_HOME: artifactDir },
      extraArgs: [],
      serverName,
      artifactDir,
    };
  } catch (error) {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    throw error;
  }
}

/** Remove only the private overlay minted for this session token. */
export function cleanupCliMcpSession(token: string): void {
  const session = activeArtifactDirs.get(token);
  if (!session) return;
  activeArtifactDirs.delete(token);
  // Persist a fresh in-pane login before the overlay is removed, otherwise the
  // provider stays "login-needed" even though the user just authenticated in
  // the pane (the overlay is ephemeral and would take the new auth with it).
  try {
    syncBackOverlayAuth(
      session.artifactDir,
      session.providerHome,
      new Set(session.configFiles),
      session.syncBackExcludeAnywhere,
    );
  } catch {
    // Never let a sync-back failure block teardown.
  }
  try {
    fs.rmSync(session.artifactDir, { recursive: true, force: true });
  } catch {
    // Best effort during process/session teardown.
  }
}
