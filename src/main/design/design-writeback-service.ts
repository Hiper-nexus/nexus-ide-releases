import fs from "node:fs";
import path from "node:path";
import {
  createDesignActionSession,
  DesignWriteConflictError,
  type DesignAction,
  type DesignActionResult,
  type DesignActionSession,
} from "./design-actions";
import { findSiblingPosition } from "./design-code-edit";
import { KeyedLock } from "../util/keyed-lock";
import {
  createDesignInstrumentation,
  type DesignInstrumentation,
  type InstrumentIndexEntry,
} from "./design-instrument";
import {
  loadDesignWritebackConfig,
  type DesignWritebackConfig,
} from "./design-writeback-config";

/**
 * Write-back session orchestration (VISUAL-EDIT-001, F3): one active project
 * at a time — instruments on start, executes invertible actions, watches the
 * instrumented files for external edits (anti-echo by hash), and ALWAYS
 * cleans the ephemeral ids on stop. Pure-node so the electron IPC layer is a
 * thin shell.
 *
 * Hardening: serialized start/stop, CAS writes, atomic rename, symlink
 * containment, watcher fail-closed lifecycle, partial-start rollback.
 */

/** UI-facing actions: `style.mode` and reorders are resolved service-side. */
export type DesignWritebackAction =
  | { kind: "style"; nexusId: string; styles: Record<string, string> }
  | { kind: "text"; nexusId: string; text: string }
  | { kind: "move"; nexusId: string; direction: "up" | "down" }
  | {
      kind: "reorder";
      parentNexusId: string;
      fromIndex: number;
      toIndex: number;
    }
  | { kind: "delete"; nexusId: string }
  | { kind: "duplicate"; nexusId: string };

export interface DesignWritebackStatus {
  enabled: boolean;
  active: boolean;
  styleMode: DesignWritebackConfig["styleMode"];
  canUndo: boolean;
  canRedo: boolean;
}

export interface DesignWritebackActionResult extends DesignActionResult {
  /** The source edit committed, but post-commit maintenance degraded. */
  maintenanceWarning?: string;
}

export interface DesignWritebackAuthority {
  /** Main-owned authority check, invoked at every filesystem commit boundary. */
  assertAuthorized(effect: {
    readonly tool: string;
    readonly path?: string;
  }): void;
}

interface ActiveWriteback {
  sessionKey: string;
  rootDir: string;
  rootReal: string;
  config: DesignWritebackConfig;
  instrumentation: DesignInstrumentation;
  session: DesignActionSession;
  watchers: Map<string, fs.FSWatcher>;
  debounces: Map<string, ReturnType<typeof setTimeout>>;
  closed: boolean;
  authority?: DesignWritebackAuthority;
}

const DEFAULT_SESSION_KEY = "default";
const activeBySession = new Map<string, ActiveWriteback>();
/** Serialize lifecycle/actions per project-owner session. */
// Era um Map de caudas que nunca apagava a chave: uma promessa por sessão para sempre.
const lifecycleLock = new KeyedLock();

const WATCH_DEBOUNCE_MS = 150;

function currentFor(sessionKey: string): ActiveWriteback | null {
  return activeBySession.get(sessionKey) ?? null;
}

function requireActive(sessionKey: string): ActiveWriteback {
  const current = currentFor(sessionKey);
  if (!current || current.closed)
    throw new Error("design write-back is not active");
  return current;
}

function serializeLifecycle<T>(
  sessionKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  return lifecycleLock.run(sessionKey, operation);
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const root = rootReal.endsWith(path.sep)
    ? rootReal
    : `${rootReal}${path.sep}`;
  return candidateReal === rootReal || candidateReal.startsWith(root);
}

/**
 * Resolve a project-relative path and refuse symlinks (or parents) that escape
 * the project root — closes the classic TOCTOU/symlink swap.
 */
async function resolveContainedPath(
  state: ActiveWriteback,
  relPath: string,
): Promise<string> {
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
    throw new Error(`path escapes project containment: ${relPath}`);
  }
  const absPath = path.resolve(state.rootDir, relPath);
  if (
    !absPath.startsWith(state.rootDir + path.sep) &&
    absPath !== state.rootDir
  ) {
    throw new Error(`path escapes project containment: ${relPath}`);
  }

  const segments = path.relative(state.rootDir, absPath).split(path.sep);
  let cursor = state.rootDir;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const metadata = await fs.promises.lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`symlink outside containment refused: ${relPath}`);
    }
  }

  let lstat: fs.Stats;
  try {
    lstat = await fs.promises.lstat(absPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`design target missing: ${relPath}`);
    }
    throw error;
  }

  if (lstat.isSymbolicLink()) {
    throw new Error(`symlink outside containment refused: ${relPath}`);
  }
  if (!lstat.isFile()) {
    throw new Error(`design target is not a regular file: ${relPath}`);
  }

  const realPath = await fs.promises.realpath(absPath);
  if (!isInsideRoot(state.rootReal, realPath)) {
    throw new Error(`path escapes project containment: ${relPath}`);
  }
  return realPath;
}

async function readContainedFile(
  state: ActiveWriteback,
  relPath: string,
): Promise<string> {
  const absPath = await resolveContainedPath(state, relPath);
  const handle = await fs.promises.open(
    absPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`design target is not a regular file: ${relPath}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function syncWritebackTemp(tempPath: string): Promise<void> {
  const metadata = await fs.promises.lstat(tempPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("design write-back temp is not a regular file");
  }
  const handle = await fs.promises.open(
    tempPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertStableWritebackPaths(
  state: ActiveWriteback,
  relPath: string,
  expectedTarget: string,
  tempPath: string,
): Promise<void> {
  const parent = path.dirname(expectedTarget);
  const parentMetadata = await fs.promises.lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`design write-back parent changed: ${relPath}`);
  }
  const parentReal = await fs.promises.realpath(parent);
  if (!isInsideRoot(state.rootReal, parentReal)) {
    throw new Error(`design write-back parent escaped containment: ${relPath}`);
  }
  const tempReal = await fs.promises.realpath(tempPath);
  if (!isInsideRoot(state.rootReal, tempReal)) {
    throw new Error(`design write-back temp escaped containment: ${relPath}`);
  }
  const targetReal = await resolveContainedPath(state, relPath);
  if (targetReal !== expectedTarget) {
    throw new Error(
      `design write-back target changed before commit: ${relPath}`,
    );
  }
}

/**
 * CAS + atomic write: only replace the file if its on-disk bytes still match
 * `expectedContent`. Uses a same-directory temp file + rename; cleans the temp
 * if rename fails so the original is left intact.
 */
async function writeContainedFileAtomic(
  state: ActiveWriteback,
  relPath: string,
  content: string,
  expectedContent: string,
): Promise<void> {
  state.authority?.assertAuthorized({
    tool: "nexus_design_writeback_commit",
    path: relPath,
  });
  const absPath = await resolveContainedPath(state, relPath);
  const targetMetadata = await fs.promises.lstat(absPath);
  const currentContent = await readContainedFile(state, relPath);
  if (currentContent !== expectedContent) {
    throw new DesignWriteConflictError(
      `design write conflict: ${relPath} changed externally`,
    );
  }

  const dir = path.dirname(absPath);
  const tempPath = path.join(
    dir,
    `.nexus-writeback-${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`,
  );

  const watcher = state.watchers.get(relPath);
  if (watcher) {
    state.watchers.delete(relPath);
    try {
      watcher.close();
    } catch {
      // Replaced below after the atomic commit.
    }
  }

  try {
    await fs.promises.writeFile(tempPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: targetMetadata.mode & 0o777,
    });
    await syncWritebackTemp(tempPath);
    const contentBeforeRename = await readContainedFile(state, relPath);
    if (contentBeforeRename !== expectedContent) {
      throw new DesignWriteConflictError(
        `design write conflict: ${relPath} changed before commit`,
      );
    }
    state.authority?.assertAuthorized({
      tool: "nexus_design_writeback_commit",
      path: relPath,
    });
    await assertStableWritebackPaths(state, relPath, absPath, tempPath);
    await fs.promises.rename(tempPath, absPath);
  } catch (error) {
    await fs.promises.unlink(tempPath).catch(() => undefined);
    if (watcher && currentFor(state.sessionKey) === state && !state.closed) {
      try {
        watchInstrumentedFile(state, relPath);
      } catch (watchError) {
        return failClosedAndRethrow(state, watchError);
      }
    }
    throw error;
  }

  state.instrumentation.noteSelfWrite(relPath, content);
}

function clearWatchers(state: ActiveWriteback): void {
  for (const debounce of state.debounces.values()) clearTimeout(debounce);
  state.debounces.clear();
  for (const watcher of state.watchers.values()) {
    try {
      watcher.close();
    } catch {
      // already closed
    }
  }
  state.watchers.clear();
}

async function failClosed(state: ActiveWriteback): Promise<void> {
  if (currentFor(state.sessionKey) !== state || state.closed) return;
  await stopDesignWritebackInternal(state.sessionKey);
}

async function failClosedAndRethrow(
  state: ActiveWriteback,
  error: unknown,
): Promise<never> {
  const original =
    error instanceof Error
      ? error
      : new Error("design write-back operation failed");
  try {
    await failClosed(state);
  } catch (cleanupError) {
    const cleanup =
      cleanupError instanceof Error
        ? cleanupError
        : new Error("design write-back cleanup failed");
    throw new AggregateError(
      [original, cleanup],
      `${original.message}; cleanup also failed: ${cleanup.message}`,
    );
  }
  throw original;
}

function watchInstrumentedFile(state: ActiveWriteback, relPath: string): void {
  if (state.watchers.has(relPath)) return;
  const absPath = path.join(state.rootDir, relPath);
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(absPath, () => {
      if (state.closed || currentFor(state.sessionKey) !== state) return;
      const pending = state.debounces.get(relPath);
      if (pending) clearTimeout(pending);
      state.debounces.set(
        relPath,
        setTimeout(() => {
          state.debounces.delete(relPath);
          void serializeLifecycle(state.sessionKey, () =>
            reconcileExternalChange(state, relPath),
          ).catch(() => failClosed(state));
        }, WATCH_DEBOUNCE_MS),
      );
    });
  } catch (error) {
    // Fail start/refresh — do not leave an unwatched instrumented tree.
    throw error instanceof Error
      ? error
      : new Error(`watch unavailable for ${relPath}`);
  }

  watcher.on("error", () => {
    // Must not throw from the EventEmitter handler.
    void serializeLifecycle(state.sessionKey, () => failClosed(state)).catch(
      () => undefined,
    );
  });
  state.watchers.set(relPath, watcher);
}

/** External edit (agent/HMR/user): re-instrument unless it is our own echo. */
async function reconcileExternalChange(
  state: ActiveWriteback,
  relPath: string,
): Promise<void> {
  if (currentFor(state.sessionKey) !== state || state.closed) return;
  let content: string;
  try {
    content = await readContainedFile(state, relPath);
  } catch {
    // Vanished, swapped to symlink, or left the tree — fail closed.
    await failClosed(state);
    return;
  }
  if (state.instrumentation.isSelfWrite(relPath, content)) return;
  try {
    await state.instrumentation.refreshFile(relPath);
  } catch {
    await failClosed(state);
  }
}

export function designWritebackStatus(
  rootDir?: string,
  sessionKey = DEFAULT_SESSION_KEY,
): DesignWritebackStatus {
  const current = currentFor(sessionKey);
  const config = rootDir
    ? loadDesignWritebackConfig(rootDir)
    : current
      ? current.config
      : { enabled: false, styleMode: "tailwind" as const };
  return {
    enabled: config.enabled,
    // Stay "active" until instrumentation cleanup finishes so callers waiting
    // on status do not race a partial fail-closed.
    active: current !== null,
    styleMode: config.styleMode,
    canUndo: current?.session.canUndo() ?? false,
    canRedo: current?.session.canRedo() ?? false,
  };
}

async function startDesignWritebackInternal(
  sessionKey: string,
  rootDir: string,
  authority?: DesignWritebackAuthority,
): Promise<{ ok: true; files: number; elements: number }> {
  const config = loadDesignWritebackConfig(rootDir);
  if (!config.enabled) {
    throw new Error(
      "deterministic write-back is opt-in: enable it in .nexus/design.json " +
        '({"writeBack":{"enabled":true}})',
    );
  }
  if (currentFor(sessionKey)) await stopDesignWritebackInternal(sessionKey);

  const rootReal = await fs.promises.realpath(rootDir);
  const instrumentation = createDesignInstrumentation(rootReal);
  const state: ActiveWriteback = {
    sessionKey,
    rootDir: rootReal,
    rootReal,
    config,
    instrumentation,
    session: null as unknown as DesignActionSession,
    watchers: new Map(),
    debounces: new Map(),
    closed: false,
    authority,
  };
  state.session = createDesignActionSession({
    lookup: (nexusId): InstrumentIndexEntry | null =>
      instrumentation.lookup(nexusId),
    readFile: (relPath) => readContainedFile(state, relPath),
    writeFile: (relPath, content, expectedContent) =>
      writeContainedFileAtomic(state, relPath, content, expectedContent),
  });

  let summary: { files: number; elements: number };
  try {
    authority?.assertAuthorized({ tool: "nexus_design_writeback_start" });
    summary = await instrumentation.start();
    authority?.assertAuthorized({ tool: "nexus_design_writeback_start" });
    for (const relPath of instrumentation.instrumentedFiles()) {
      watchInstrumentedFile(state, relPath);
    }
  } catch (error) {
    clearWatchers(state);
    state.session.reset();
    try {
      await instrumentation.stop();
    } catch (cleanupError) {
      const original =
        error instanceof Error
          ? error
          : new Error("design write-back start failed");
      const cleanup =
        cleanupError instanceof Error
          ? cleanupError
          : new Error("partial instrumentation cleanup failed");
      throw new AggregateError(
        [original, cleanup],
        `${original.message}; rollback also failed: ${cleanup.message}`,
      );
    }
    throw error;
  }

  activeBySession.set(sessionKey, state);
  return { ok: true, ...summary };
}

export async function startDesignWriteback(
  rootDir: string,
  sessionKey = DEFAULT_SESSION_KEY,
  authority?: DesignWritebackAuthority,
): Promise<{ ok: true; files: number; elements: number }> {
  return serializeLifecycle(sessionKey, () =>
    startDesignWritebackInternal(sessionKey, rootDir, authority),
  );
}

async function stopDesignWritebackInternal(
  sessionKey: string,
): Promise<{ ok: true }> {
  const state = currentFor(sessionKey);
  if (!state) return { ok: true };
  if (!state.closed) {
    state.closed = true;
    clearWatchers(state);
    state.session.reset();
  }
  await state.instrumentation.stop();
  if (currentFor(sessionKey) === state) activeBySession.delete(sessionKey);
  return { ok: true };
}

export async function stopDesignWriteback(
  sessionKey = DEFAULT_SESSION_KEY,
): Promise<{ ok: true }> {
  return serializeLifecycle(sessionKey, () =>
    stopDesignWritebackInternal(sessionKey),
  );
}

export function applyDesignAction(
  action: DesignWritebackAction,
  sessionKey = DEFAULT_SESSION_KEY,
): Promise<DesignWritebackActionResult> {
  return serializeLifecycle(sessionKey, async () => {
    const state = requireActive(sessionKey);
    const targetPath = designActionTargetPath(action, sessionKey);
    state.authority?.assertAuthorized({
      tool: `nexus_design_writeback_${action.kind}`,
      ...(targetPath ? { path: targetPath } : {}),
    });
    const resolved = await resolveAction(state, action);
    const result = await state.session.apply(resolved);
    const maintenanceWarning = await afterMutation(
      state,
      result.file,
      action.kind,
    );
    return maintenanceWarning ? { ...result, maintenanceWarning } : result;
  });
}

export function undoDesignAction(
  sessionKey = DEFAULT_SESSION_KEY,
): Promise<DesignWritebackActionResult | null> {
  return serializeLifecycle(sessionKey, async () => {
    const state = requireActive(sessionKey);
    state.authority?.assertAuthorized({ tool: "nexus_design_writeback_undo" });
    const result = await state.session.undo();
    if (!result) return null;
    const maintenanceWarning = await afterMutation(state, result.file, "undo");
    return maintenanceWarning ? { ...result, maintenanceWarning } : result;
  });
}

export function redoDesignAction(
  sessionKey = DEFAULT_SESSION_KEY,
): Promise<DesignWritebackActionResult | null> {
  return serializeLifecycle(sessionKey, async () => {
    const state = requireActive(sessionKey);
    state.authority?.assertAuthorized({ tool: "nexus_design_writeback_redo" });
    const result = await state.session.redo();
    if (!result) return null;
    const maintenanceWarning = await afterMutation(state, result.file, "redo");
    return maintenanceWarning ? { ...result, maintenanceWarning } : result;
  });
}

export function lookupDesignElement(
  nexusId: string,
  sessionKey = DEFAULT_SESSION_KEY,
): InstrumentIndexEntry | null {
  return currentFor(sessionKey)?.instrumentation.lookup(nexusId) ?? null;
}

export function designActionTargetPath(
  action: DesignWritebackAction,
  sessionKey = DEFAULT_SESSION_KEY,
): string | undefined {
  const state = currentFor(sessionKey);
  if (!state || state.closed) return undefined;
  const nexusId = "nexusId" in action ? action.nexusId : action.parentNexusId;
  return state.instrumentation.lookup(nexusId)?.file;
}

async function resolveAction(
  state: ActiveWriteback,
  action: DesignWritebackAction,
): Promise<DesignAction> {
  if (action.kind === "style") {
    return { ...action, mode: state.config.styleMode };
  }
  if (action.kind === "move") {
    const entry = state.instrumentation.lookup(action.nexusId);
    if (!entry) throw new Error(`unknown design element: ${action.nexusId}`);
    const code = await readContainedFile(state, entry.file);
    const position = findSiblingPosition(code, action.nexusId);
    const toIndex =
      action.direction === "up" ? position.index - 1 : position.index + 1;
    if (toIndex < 0 || toIndex >= position.count) {
      throw new Error("element is already at the edge of its siblings");
    }
    return {
      kind: "reorder",
      parentNexusId: position.parentNexusId,
      fromIndex: position.index,
      toIndex,
    };
  }
  return action;
}

/** Structural edits may add untagged elements (duplicate/restore): re-tag and
 * re-index, then make sure the file is being watched. Sync CAS hash after. */
async function afterMutation(
  state: ActiveWriteback,
  relPath: string,
  kind: string,
): Promise<string | undefined> {
  if (state.closed || currentFor(state.sessionKey) !== state) return undefined;
  try {
    state.authority?.assertAuthorized({
      tool: "nexus_design_writeback_refresh",
      path: relPath,
    });
    if (kind !== "style" && kind !== "text") {
      await resolveContainedPath(state, relPath);
      await state.instrumentation.refreshFile(relPath);
      const content = await readContainedFile(state, relPath);
      state.session.acknowledgeWrittenContent(relPath, content);
      state.instrumentation.noteSelfWrite(relPath, content);
    }
    watchInstrumentedFile(state, relPath);
    return undefined;
  } catch (error) {
    const original =
      error instanceof Error
        ? error
        : new Error("design post-commit maintenance failed");
    try {
      await failClosed(state);
      return `${original.message}; source edit committed and write-back was stopped`;
    } catch (cleanupError) {
      const cleanup =
        cleanupError instanceof Error
          ? cleanupError
          : new Error("design cleanup failed");
      return `${original.message}; source edit committed; cleanup is pending retry: ${cleanup.message}`;
    }
  }
}
