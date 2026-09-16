import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import {
  mergeArtifactPurgeResults,
  purgeOwnedSessionRoot,
  type ArtifactPurgeResult,
} from './ephemeral-artifact-purge';
import { syncBackOverlayAuth } from './overlay-auth-syncback';
import type {
  CliMcpPurgeOptions,
  CliMcpSessionOptions,
} from './cli-mcp-session-types';

type ArtifactProvider = 'codex' | 'opencode' | 'kimi' | 'grok';

export interface ArtifactSession {
  artifactDir: string;
  /** Real provider home to persist a fresh in-pane login back into. */
  providerHome: string | null;
  /** Top-level config and isolated conversation entries — never synced to the real home. */
  configFiles: readonly string[];
  /** Basenames excluded from sync-back at ANY depth (e.g. Grok hooks/nexus.json). */
  syncBackExcludeAnywhere?: ReadonlySet<string>;
  /** Direct-pane overlays may persist a newly completed login; governed ones do not. */
  syncBack: boolean;
}

const activeArtifactDirs = new Map<string, ArtifactSession>();
export const MAX_CLI_TOML_CONFIG_BYTES = 1_048_576;
export const MAX_CLI_TOML_CONFIG_DEPTH = 64;

export function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function runtimeServerName(token: string): string {
  return `nexus_${sessionHash(token).slice(0, 12)}`;
}

export function validateCliMcpInputs(url: string, token: string): void {
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

export function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function writePrivateFileAtomic(file: string, value: string): void {
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

export function readJsonObject(file: string): Record<string, unknown> {
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

export function readTomlObject(file: string): Record<string, unknown> {
  let raw: string;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_CLI_TOML_CONFIG_BYTES) {
      throw new Error('Grok config.toml exceeds the safe overlay size');
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parse(raw, {
    maxDepth: MAX_CLI_TOML_CONFIG_DEPTH,
  }) as Record<string, unknown>;
}

export function objectValue(value: unknown): Record<string, unknown> {
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
    entry.isDirectory() ||
    (!entry.isSymbolicLink() && fs.statSync(source).isDirectory());
  if (isDirectory) {
    fs.symlinkSync(source, target, 'junction');
    return;
  }
  linkFile(source, target);
}

/** Single-file link with the Windows hardlink/copy fallback (see linkEntry). */
export function linkFile(source: string, target: string): void {
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

export function linkDirectoryEntries(
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

export function linkSelectedEntries(
  sourceDir: string,
  targetDir: string,
  allowed: ReadonlySet<string>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!allowed.has(entry.name)) continue;
    linkEntry(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
      entry,
    );
  }
}

/** Conversation state survives overlay purge and never comes from the native profile. */
export function linkProviderSessionState(
  kind: string,
  artifactDir: string,
  options: CliMcpSessionOptions,
  directories: readonly string[],
  files: Readonly<Record<string, string>>,
  subdirectory?: 'claude',
): string {
  const home = path.resolve(options.home ?? os.homedir());
  // Standalone callers use a stable path identity; production passes Main's checkoutId.
  const root = path.resolve(options.workspaceRoot ?? options.cwd ?? process.cwd());
  const checkoutId = options.checkoutId ??
    `checkout-${sessionHash(fs.existsSync(root) ? fs.realpathSync(root) : root).slice(0, 32)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(checkoutId)) {
    throw new Error('Invalid provider-state checkout identity');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(kind)) {
    throw new Error('Invalid provider-state adapter identity');
  }
  let stateHome = path.resolve(options.userDataPath ?? path.join(home, '.nexus'));
  for (const segment of ['provider-state', kind, checkoutId, ...(subdirectory ? [subdirectory] : [])]) {
    stateHome = path.join(stateHome, segment);
    if (fs.lstatSync(stateHome, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Provider session state must not be a symlink');
    }
    ensurePrivateDirectory(stateHome);
  }
  for (const name of [...directories, ...Object.keys(files)]) {
    if (fs.lstatSync(path.join(stateHome, name), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Provider session entry must not be a symlink');
    }
  }
  for (const name of directories) {
    ensurePrivateDirectory(path.join(stateHome, name));
  }
  for (const [name, initial] of Object.entries(files)) {
    try {
      fs.writeFileSync(path.join(stateHome, name), initial, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  linkSelectedEntries(
    stateHome,
    artifactDir,
    new Set([...directories, ...Object.keys(files)]),
  );
  return stateHome;
}

function prepareArtifactDir(
  kind: ArtifactProvider,
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

/**
 * Own the complete pre-activation lifecycle of one provider overlay.
 *
 * Provider strategies must put every operation after directory creation in
 * this callback. If validation, policy compilation, realpath resolution or
 * activation-adjacent construction fails, the exact token-derived directory
 * and any partial active registration are rolled back together.
 */
export function withCliMcpArtifactTransaction<T>(
  kind: ArtifactProvider,
  token: string,
  root: string,
  construct: (artifactDir: string) => T,
): T {
  const artifactDir = path.join(root, kind, sessionHash(token).slice(0, 32));
  try {
    prepareArtifactDir(kind, token, root);
    return construct(artifactDir);
  } catch (error) {
    // prepareArtifactDir clears any prior session for this token before it
    // creates the new directory, so an entry here can only be partial state
    // from the failed construction and must never sync back.
    activeArtifactDirs.delete(token);
    fs.rmSync(artifactDir, { recursive: true, force: true });
    throw error;
  }
}

export function activateArtifact(
  token: string,
  session: ArtifactSession,
): void {
  activeArtifactDirs.set(token, session);
}

export function purgeStaleCliMcpSessions(
  options: CliMcpPurgeOptions = {},
): ArtifactPurgeResult {
  const home = path.resolve(options.home ?? os.homedir());
  const artifactRoot = path.resolve(
    options.artifactRoot ??
      path.join(home, '.nexus', 'ephemeral', 'mcp-clients'),
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
    purgeOwnedSessionRoot(
      path.join(artifactRoot, 'codex'),
      active,
      trustedBoundary,
    ),
    purgeOwnedSessionRoot(
      path.join(artifactRoot, 'opencode'),
      active,
      trustedBoundary,
    ),
  );
}

/** Remove only the private overlay minted for this session token. */
export function cleanupCliMcpSession(token: string): void {
  const session = activeArtifactDirs.get(token);
  if (!session) return;
  activeArtifactDirs.delete(token);
  // Persist a fresh in-pane login before the overlay is removed, otherwise the
  // provider stays "login-needed" even though the user just authenticated in
  // the pane (the overlay is ephemeral and would take the new auth with it).
  if (session.syncBack && session.providerHome) {
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
  }
  try {
    fs.rmSync(session.artifactDir, { recursive: true, force: true });
  } catch {
    // Best effort during process/session teardown.
  }
}
