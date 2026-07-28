import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Transactional Nexus MCP injection into the REAL AGY profile.
 *
 * AGY 1.1 resolves `mcp_config.json` from its native path
 * (`~/.gemini/antigravity-cli/`) regardless of $HOME or GEMINI_CLI_HOME —
 * verified physically: neither env var relocates the config search. Governed
 * advisory sessions therefore cannot use the private HOME overlay; Nexus
 * injects its MCP server into the shared config temporarily, under strict
 * transaction guarantees:
 *
 * - exclusive per-native-profile lock (O_EXCL lock file + PID liveness);
 * - crash-recovery journal written BEFORE the mutation;
 * - exact byte backup of the previous content;
 * - atomic writes (tmp + fsync + rename, 0600);
 * - byte-for-byte restore on release — or removal of ONLY the injected entry
 *   when the user edited other servers during the session;
 * - the bearer token is never logged or printed.
 *
 * CONCURRENCY: one governed AGY session per native profile at a time. A
 * second spawn gets a clear lock-busy error instead of sharing the config —
 * sharing would expose one session's MCP authority to the other. Different
 * OS users/profiles operate independently (artifact root is HOME-scoped).
 */

export interface AgyNativeMcpLeaseOptions {
  /** Real user home (defaults to os.homedir()). */
  home?: string;
  /** Override for the ~/.gemini root (managed accounts). */
  geminiHome?: string;
  /** Override for the lease artifact root (~/.nexus/ephemeral/agy-native). */
  artifactRoot?: string;
}

export interface AgyNativeMcpLease {
  /** Session token holding the lease (never logged). */
  readonly token: string;
  /** The native config paths that received the injection. */
  readonly configPaths: readonly string[];
  /** Real user home — the child's processHome. */
  readonly realHome: string;
  /** ~/.gemini — read grant for the Seatbelt profile. */
  readonly geminiDir: string;
  /** ~/.gemini/antigravity-cli — read+write grant (CLI's own state). */
  readonly providerStateDir: string;
  /** Private writable runtime dir for the sandboxed process. */
  readonly runtimeDir: string;
}

interface LeaseRecord {
  readonly token: string;
  readonly sessionKey: string;
  readonly sessionDir: string;
  readonly lockPath: string;
  readonly configPaths: readonly string[];
}

interface JournalEntry {
  readonly phase: "pending" | "injected";
  readonly pid: number;
  readonly sessionKey: string;
  readonly acquiredAt: string;
  readonly configs: readonly {
    readonly configPath: string;
    readonly backupPath: string;
  }[];
}

const activeLeases = new Map<string, LeaseRecord>();

const NEXUS_SERVER_NAME = "nexus";
const LOCK_STALE_MS = 6 * 60 * 60 * 1000; // 6h absolute ceiling

function resolveDirs(options: AgyNativeMcpLeaseOptions): {
  realHome: string;
  geminiDir: string;
  artifactRoot: string;
  providerStateDir: string;
} {
  const realHome = path.resolve(options.home ?? os.homedir());
  const geminiDir = path.resolve(
    options.geminiHome ?? path.join(realHome, ".gemini"),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ??
      path.join(realHome, ".nexus", "ephemeral", "agy-native"),
  );
  const providerStateDir = path.join(geminiDir, "antigravity-cli");
  return { realHome, geminiDir, artifactRoot, providerStateDir };
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function sessionKeyFor(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockContent {
  pid: number;
  sessionKey: string;
  acquiredAt: string;
}

function readLock(lockPath: string): LockContent | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockContent>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.sessionKey !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }
    return parsed as LockContent;
  } catch {
    return null;
  }
}

function lockIsStale(lock: LockContent): boolean {
  const age = Date.now() - new Date(lock.acquiredAt).getTime();
  return !pidAlive(lock.pid) || age > LOCK_STALE_MS;
}

/**
 * Acquire the exclusive profile lock. Throws a clear error when another LIVE
 * session holds it — never shares the config between concurrent sessions.
 */
function acquireProfileLock(
  lockPath: string,
  sessionKey: string,
): void {
  ensurePrivateDirectory(path.dirname(lockPath));
  const content: LockContent = {
    pid: process.pid,
    sessionKey,
    acquiredAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(content), "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (existing && existing.sessionKey === sessionKey) {
        // Same session re-acquiring (retry after spawn failure) — take over.
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (existing && lockIsStale(existing)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      throw new Error(
        "another governed AGY session is already using this native profile; " +
          "wait for it to finish or close its pane, then retry",
      );
    }
  }
  throw new Error("failed to acquire the AGY native profile lock");
}

function releaseProfileLock(lockPath: string, sessionKey: string): void {
  const existing = readLock(lockPath);
  if (existing && existing.sessionKey === sessionKey) {
    fs.rmSync(lockPath, { force: true });
  }
}

function writeAtomic(target: string, data: string | Buffer): void {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort.
      }
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function journalPath(sessionDir: string): string {
  return path.join(sessionDir, "journal.json");
}

/**
 * Remove the private runtime dirs minted for a session key. They carry a
 * random mkdtemp suffix, so purge by prefix.
 */
function purgeRuntimeDirs(artifactRoot: string, sessionKey: string): void {
  const prefix = `runtime-${sessionKey}-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(artifactRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    fs.rmSync(path.join(artifactRoot, entry), { recursive: true, force: true });
  }
}

function writeJournal(sessionDir: string, entry: JournalEntry): void {
  writeAtomic(journalPath(sessionDir), JSON.stringify(entry, null, 2));
}

function readJournal(sessionDir: string): JournalEntry | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(journalPath(sessionDir), "utf8"),
    ) as JournalEntry;
    if (!parsed || !Array.isArray(parsed.configs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Candidate native config paths, in AGY's resolution order. */
function nativeConfigCandidates(geminiDir: string): string[] {
  return [
    path.join(geminiDir, "antigravity-cli", "mcp_config.json"),
    path.join(geminiDir, "config", "mcp_config.json"),
  ];
}

/**
 * Inject the Nexus MCP server into the real AGY profile config(s),
 * transactionally. Returns the lease; release it on session exit/teardown.
 */
export function acquireAgyNativeMcpLease(
  url: string,
  token: string,
  options: AgyNativeMcpLeaseOptions = {},
): AgyNativeMcpLease {
  if (!url.trim() || !token.trim()) {
    throw new Error("AGY native MCP lease requires url and token");
  }
  const { realHome, geminiDir, artifactRoot, providerStateDir } = resolveDirs(options);
  const sessionKey = sessionKeyFor(token);
  const sessionDir = path.join(artifactRoot, sessionKey);
  const lockPath = path.join(artifactRoot, "profile.lock");

  // A previous failed attempt for this token must not block the retry.
  releaseAgyNativeMcpLease(token, options);

  acquireProfileLock(lockPath, sessionKey);
  ensurePrivateDirectory(sessionDir);

  const configPaths = nativeConfigCandidates(geminiDir).filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (configPaths.length === 0) {
    releaseProfileLock(lockPath, sessionKey);
    throw new Error(
      "AGY native profile has no mcp_config.json to lease — is the CLI installed?",
    );
  }

  const configs: { configPath: string; backupPath: string }[] = [];
  const journal: JournalEntry = {
    phase: "pending",
    pid: process.pid,
    sessionKey,
    acquiredAt: new Date().toISOString(),
    configs,
  };

  try {
    // Phase 1: journal intent + exact byte backups BEFORE any mutation.
    for (const configPath of configPaths) {
      const backupPath = path.join(
        sessionDir,
        `${path.basename(path.dirname(configPath))}.backup.json`,
      );
      fs.copyFileSync(configPath, backupPath);
      fs.chmodSync(backupPath, 0o600);
      configs.push({ configPath, backupPath });
    }
    writeJournal(sessionDir, journal);

    // Phase 2: inject (atomic per file). Only the `nexus` entry is added;
    // every other server in the user's config is preserved untouched.
    const fragment = {
      serverUrl: url,
      headers: { Authorization: `Bearer ${token}` },
    };
    for (const { configPath } of configs) {
      let parsed: Record<string, unknown>;
      try {
        const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
        parsed =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? { ...(existing as Record<string, unknown>) }
            : {};
      } catch {
        parsed = {};
      }
      const servers =
        parsed.mcpServers && typeof parsed.mcpServers === "object"
          ? { ...(parsed.mcpServers as Record<string, unknown>) }
          : {};
      servers[NEXUS_SERVER_NAME] = fragment;
      parsed.mcpServers = servers;
      writeAtomic(configPath, JSON.stringify(parsed, null, 2));
    }

    // Phase 3: mark injected (recovery knows the mutation happened).
    writeJournal(sessionDir, { ...journal, phase: "injected" });
  } catch (error) {
    // Mutation failed mid-way: restore whatever was backed up, then release.
    for (const { configPath, backupPath } of configs) {
      try {
        fs.copyFileSync(backupPath, configPath);
      } catch {
        // Best effort — the journal still guides startup recovery.
      }
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
    releaseProfileLock(lockPath, sessionKey);
    throw error;
  }

  const runtimeDir = fs.mkdtempSync(
    path.join(artifactRoot, `runtime-${sessionKey}-`),
  );
  fs.chmodSync(runtimeDir, 0o700);

  activeLeases.set(token, {
    token,
    sessionKey,
    sessionDir,
    lockPath,
    configPaths,
  });

  return {
    token,
    configPaths,
    realHome,
    geminiDir,
    providerStateDir,
    runtimeDir,
  };
}

/**
 * Release the lease: remove ONLY the injected entry. When nothing else
 * changed during the session the backup is restored byte-for-byte; external
 * edits to other servers are preserved.
 */
export function releaseAgyNativeMcpLease(
  token: string,
  options: AgyNativeMcpLeaseOptions = {},
): void {
  const { artifactRoot } = resolveDirs(options);
  const sessionKey = sessionKeyFor(token);
  const active = activeLeases.get(token);
  const sessionDir = active?.sessionDir ?? path.join(artifactRoot, sessionKey);
  const lockPath = active?.lockPath ?? path.join(artifactRoot, "profile.lock");

  const journal = readJournal(sessionDir);
  let restoreFailed = false;
  if (journal && journal.phase === "injected") {
    for (const { configPath, backupPath } of journal.configs) {
      try {
        restoreConfig(configPath, backupPath);
      } catch {
        // Leave the journal in place: startup recovery will retry.
        restoreFailed = true;
        continue;
      }
    }
  }
  // Only purge the session directory when every config was restored. If a
  // restore failed the journal and backups must survive on disk so that
  // recoverStaleAgyNativeLeases can retry at the next startup.
  if (!restoreFailed) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  purgeRuntimeDirs(artifactRoot, sessionKey);
  releaseProfileLock(lockPath, sessionKey);
  activeLeases.delete(token);
}

/**
 * Restore one config from its backup. Byte-for-byte when the current content
 * is exactly "backup + nexus entry"; otherwise re-parse and drop only the
 * injected entry, preserving concurrent user edits to other servers.
 */
function restoreConfig(configPath: string, backupPath: string): void {
  let backupBytes: Buffer;
  try {
    backupBytes = fs.readFileSync(backupPath);
  } catch {
    // No backup: the config did not exist before us? Impossible (we only
    // lease existing files) — remove our entry and move on.
    removeNexusEntry(configPath);
    return;
  }
  const currentBytes = fs.readFileSync(configPath);

  // Fast path: strip our entry and compare with backup parse.
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(currentBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    // Corrupted during the session: the backup is the last known-good state.
    fs.writeFileSync(configPath, backupBytes);
    fs.chmodSync(configPath, 0o600);
    return;
  }
  const servers =
    current.mcpServers && typeof current.mcpServers === "object"
      ? (current.mcpServers as Record<string, unknown>)
      : undefined;
  if (servers && NEXUS_SERVER_NAME in servers) {
    const { [NEXUS_SERVER_NAME]: _removed, ...rest } = servers;
    current = { ...current, mcpServers: rest };
  }
  let backupParsed: unknown;
  try {
    backupParsed = JSON.parse(backupBytes.toString("utf8"));
  } catch {
    backupParsed = undefined;
  }
  const stripped = JSON.stringify(current, null, 2);
  const backupNormalized =
    backupParsed !== undefined
      ? JSON.stringify(backupParsed, null, 2)
      : undefined;
  if (stripped === backupNormalized) {
    // Nothing else changed: byte-for-byte restore.
    fs.writeFileSync(configPath, backupBytes);
    fs.chmodSync(configPath, 0o600);
  } else {
    // The user edited other servers mid-session: keep their edits, drop only
    // our entry.
    writeAtomic(configPath, stripped);
  }
}

function removeNexusEntry(configPath: string): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const servers =
      parsed.mcpServers && typeof parsed.mcpServers === "object"
        ? (parsed.mcpServers as Record<string, unknown>)
        : undefined;
    if (!servers || !(NEXUS_SERVER_NAME in servers)) return;
    const { [NEXUS_SERVER_NAME]: _removed, ...rest } = servers;
    writeAtomic(
      configPath,
      JSON.stringify({ ...parsed, mcpServers: rest }, null, 2),
    );
  } catch {
    // Unreadable config is not ours to fix.
  }
}

/**
 * Startup crash recovery: journals left in phase 'injected' whose owning
 * process is gone get their configs restored and artifacts purged. Orphaned
 * locks from dead processes are removed.
 */
export function recoverStaleAgyNativeLeases(
  options: AgyNativeMcpLeaseOptions = {},
): { recovered: number; failed: number } {
  const { artifactRoot } = resolveDirs(options);
  let recovered = 0;
  let failed = 0;

  let entries: string[];
  try {
    entries = fs.readdirSync(artifactRoot);
  } catch {
    return { recovered: 0, failed: 0 };
  }

  for (const entry of entries) {
    const sessionDir = path.join(artifactRoot, entry);
    try {
      if (!fs.statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }
    // Runtime dirs carry no journal; skip quietly.
    if (entry.startsWith("runtime-")) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      continue;
    }
    const journal = readJournal(sessionDir);
    if (!journal) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      continue;
    }
    if (pidAlive(journal.pid)) continue; // Owner still running (another Nexus).
    if (journal.phase === "injected") {
      let allRestored = true;
      for (const { configPath, backupPath } of journal.configs) {
        try {
          restoreConfig(configPath, backupPath);
        } catch {
          allRestored = false;
        }
      }
      if (!allRestored) {
        failed++;
        continue;
      }
    }
    fs.rmSync(sessionDir, { recursive: true, force: true });
    recovered++;
  }

  // Orphaned lock from a dead process.
  const lockPath = path.join(artifactRoot, "profile.lock");
  const lock = readLock(lockPath);
  if (lock && lockIsStale(lock)) {
    fs.rmSync(lockPath, { force: true });
  }

  return { recovered, failed };
}
