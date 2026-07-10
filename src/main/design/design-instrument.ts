import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as babelParse } from "@babel/parser";
import type * as t from "@babel/types";
import { isDynamicArrayTemplate } from "./design-instrument-dynamic";
import {
  deleteOwnershipLedger,
  fromLedgerRelativePath,
  hasLiveInstrumentation,
  markInstrumentationLive,
  readOwnershipLedgers,
  releaseInstrumentationLive,
  serializeInstrumentationRoot,
  writeOwnershipLedger,
} from "./design-instrument-ledger";

/**
 * L3 instrumentation (VISUAL-EDIT-001, F3) — RunManager blueprint from
 * Onlook's Electron era: ephemeral `data-nexus-id` attributes injected into
 * the project's JSX at session start, an in-memory id → file:line index, an
 * anti-echo hash set for our own writes, and a guaranteed cleanup on stop.
 * The ids NEVER belong in the user's repo — the web-era Onlook commits them
 * and leaks them to production; we deliberately do not.
 */

export const NEXUS_ID_ATTR = "data-nexus-id";
const MAX_UNIQUE_ID_ATTEMPTS = 100;

export interface InstrumentEntry {
  id: string;
  line: number;
  column: number;
  tagName: string;
}

export interface InstrumentIndexEntry extends InstrumentEntry {
  file: string;
}

interface OpeningTag {
  nameEnd: number;
  idAttributes: Array<{ start: number; end: number; id: string | null }>;
  hasId: boolean;
  line: number;
  column: number;
  tagName: string;
  existingId: string | null;
  isDynamicArrayTemplate: boolean;
}

function parseSafe(code: string): t.File | null {
  try {
    return babelParse(code, {
      sourceType: "module",
      allowImportExportEverywhere: true,
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return null;
  }
}

function walk(
  node: unknown,
  visit: (node: t.Node, ancestors: readonly t.Node[]) => void,
  ancestors: readonly t.Node[] = [],
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, ancestors);
    return;
  }
  const candidate = node as t.Node;
  if (typeof candidate.type === "string") visit(candidate, ancestors);
  for (const key of Object.keys(candidate)) {
    if (
      key === "loc" ||
      key === "leadingComments" ||
      key === "trailingComments"
    ) {
      continue;
    }
    walk((candidate as unknown as Record<string, unknown>)[key], visit, [
      ...ancestors,
      candidate,
    ]);
  }
}

function tagNameOf(name: t.JSXOpeningElement["name"]): string {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    const parts: string[] = [];
    let current: t.JSXMemberExpression | t.JSXIdentifier = name;
    while (current.type === "JSXMemberExpression") {
      parts.unshift(current.property.name);
      current = current.object as t.JSXMemberExpression | t.JSXIdentifier;
    }
    parts.unshift((current as t.JSXIdentifier).name);
    return parts.join(".");
  }
  return "unknown";
}

function collectOpeningTags(ast: t.File): OpeningTag[] {
  const tags: OpeningTag[] = [];
  walk(ast.program, (node, ancestors) => {
    if (node.type !== "JSXOpeningElement") return;
    const opening = node as t.JSXOpeningElement;
    const name = opening.name as t.Node & { end?: number | null };
    if (typeof name.end !== "number" || !opening.loc) return;
    let hasId = false;
    let existingId: string | null = null;
    const idAttributes: OpeningTag["idAttributes"] = [];
    for (const attribute of opening.attributes) {
      if (
        attribute.type === "JSXAttribute" &&
        attribute.name.type === "JSXIdentifier" &&
        attribute.name.name === NEXUS_ID_ATTR
      ) {
        hasId = true;
        if (attribute.value?.type === "StringLiteral") {
          existingId = attribute.value.value;
        }
        const range = attribute as t.Node & {
          start?: number | null;
          end?: number | null;
        };
        if (typeof range.start === "number" && typeof range.end === "number") {
          idAttributes.push({
            start: range.start,
            end: range.end,
            id:
              attribute.value?.type === "StringLiteral"
                ? attribute.value.value
                : null,
          });
        }
      }
    }
    tags.push({
      nameEnd: name.end,
      idAttributes,
      hasId,
      existingId,
      line: opening.loc.start.line,
      column: opening.loc.start.column,
      tagName: tagNameOf(opening.name),
      isDynamicArrayTemplate: isDynamicArrayTemplate(ancestors),
    });
  });
  return tags;
}

function nextUniqueId(
  makeId: () => string,
  reservedIds: Set<string>,
): string | null {
  for (let attempt = 0; attempt < MAX_UNIQUE_ID_ATTEMPTS; attempt += 1) {
    const id = makeId();
    if (id && !reservedIds.has(id)) return id;
  }
  return null;
}

export function instrumentSource(
  code: string,
  makeId: () => string,
  externallyReservedIds: ReadonlySet<string> = new Set(),
): {
  code: string;
  entries: InstrumentEntry[];
  insertedIds: string[];
  changed: boolean;
} {
  const ast = parseSafe(code);
  if (!ast) return { code, entries: [], insertedIds: [], changed: false };
  const tags = collectOpeningTags(ast);
  const entries: InstrumentEntry[] = [];
  const insertions: Array<{ at: number; id: string }> = [];
  const existingIds = new Set(
    tags.flatMap((tag) => (tag.existingId ? [tag.existingId] : [])),
  );
  const reservedIds = new Set([...externallyReservedIds, ...existingIds]);

  for (const tag of tags) {
    if (tag.isDynamicArrayTemplate) continue;
    if (tag.hasId) {
      if (tag.existingId) {
        entries.push({
          id: tag.existingId,
          line: tag.line,
          column: tag.column,
          tagName: tag.tagName,
        });
      }
      continue;
    }
    const id = nextUniqueId(makeId, reservedIds);
    if (!id) {
      return {
        code,
        entries: entries.filter((entry) => existingIds.has(entry.id)),
        insertedIds: [],
        changed: false,
      };
    }
    reservedIds.add(id);
    entries.push({
      id,
      line: tag.line,
      column: tag.column,
      tagName: tag.tagName,
    });
    insertions.push({ at: tag.nameEnd, id });
  }

  if (!insertions.length)
    return { code, entries, insertedIds: [], changed: false };
  let result = code;
  for (const { at, id } of [...insertions].sort((a, b) => b.at - a.at)) {
    result = `${result.slice(0, at)} ${NEXUS_ID_ATTR}="${id}"${result.slice(at)}`;
  }
  return {
    code: result,
    entries,
    insertedIds: insertions.map(({ id }) => id),
    changed: true,
  };
}

/** Remove only ids registered as owned by this instrumentation session. */
export function cleanupSource(
  code: string,
  ownedIds: Iterable<string> = [],
): string {
  const owned = new Set(ownedIds);
  if (!owned.size) return code;
  const ast = parseSafe(code);
  if (!ast) return code;
  const removals: Array<[number, number]> = [];
  for (const tag of collectOpeningTags(ast)) {
    for (const { start, end, id } of tag.idAttributes) {
      if (!id || !owned.has(id)) continue;
      let removalStart = start;
      while (removalStart > 0 && /[ \t]/.test(code[removalStart - 1])) {
        removalStart -= 1;
      }
      removals.push([removalStart, end]);
    }
  }
  if (!removals.length) return code;
  let result = code;
  for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

// ------------------------------------------------------------- file manager

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vite",
  ".nexus",
  ".claude",
  ".codex",
  ".agents",
  "vendor",
]);
const JSX_EXTENSIONS = new Set([".jsx", ".tsx"]);
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 512 * 1024;

interface FileSnapshot {
  content: string;
  mode: number;
}

export interface DesignInstrumentationOptions {
  idFactory?: () => string;
  /** Stable only for this process session; persisted for crash recovery. */
  sessionId?: string;
}

export interface DesignInstrumentation {
  readonly active: boolean;
  start(): Promise<{ files: number; elements: number }>;
  stop(): Promise<void>;
  lookup(nexusId: string): InstrumentIndexEntry | null;
  refreshFile(relPath: string): Promise<void>;
  isSelfWrite(relPath: string, content: string): boolean;
  /** Register a write-back edit so the watcher ignores its own echo. */
  noteSelfWrite(relPath: string, content: string): void;
  instrumentedFiles(): string[];
}

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function defaultIdFactory(): () => string {
  return () => crypto.randomBytes(5).toString("hex");
}

function isContained(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function readRegularFile(
  canonicalRoot: string,
  absPath: string,
): Promise<FileSnapshot> {
  const metadata = await fs.promises.lstat(absPath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`design instrumentation refuses symlink: ${absPath}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`design instrumentation target is not a file: ${absPath}`);
  }
  const realPath = await fs.promises.realpath(absPath);
  if (!isContained(canonicalRoot, realPath)) {
    throw new Error(
      `design instrumentation escaped project containment: ${absPath}`,
    );
  }
  const handle = await fs.promises.open(
    absPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    return { content: await handle.readFile("utf8"), mode: metadata.mode };
  } finally {
    await handle.close();
  }
}

type AtomicWriteKind = "instrument" | "deinstrument";

async function syncRegularTempFile(tempPath: string): Promise<void> {
  const metadata = await fs.promises.lstat(tempPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`design instrumentation temp is not regular: ${tempPath}`);
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

async function assertStableAtomicPaths(
  canonicalRoot: string,
  absPath: string,
  tempPath: string,
): Promise<void> {
  const parent = path.dirname(absPath);
  const parentMetadata = await fs.promises.lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`design instrumentation parent changed: ${parent}`);
  }
  const parentReal = await fs.promises.realpath(parent);
  if (parentReal !== canonicalRoot && !isContained(canonicalRoot, parentReal)) {
    throw new Error("design instrumentation parent escaped containment");
  }
  const tempReal = await fs.promises.realpath(tempPath);
  if (!isContained(canonicalRoot, tempReal)) {
    throw new Error("design instrumentation temp escaped containment");
  }
  await readRegularFile(canonicalRoot, absPath);
}

async function replaceFileAtomically(
  canonicalRoot: string,
  absPath: string,
  expectedContent: string,
  nextContent: string,
  kind: AtomicWriteKind = "instrument",
): Promise<void> {
  const before = await readRegularFile(canonicalRoot, absPath);
  if (before.content !== expectedContent) {
    throw new Error(
      `design instrumentation conflict: ${absPath} changed externally`,
    );
  }
  // Distinct temp prefixes so fail-closed cleanup can still de-instrument when
  // a refresh/instrument commit path is broken or mocked.
  const tempTag =
    kind === "deinstrument" ? "nexus-deinstrument" : "nexus-instrument";
  const tempPath = path.join(
    path.dirname(absPath),
    `.${path.basename(absPath)}.${tempTag}-${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.promises.writeFile(tempPath, nextContent, {
      encoding: "utf8",
      flag: "wx",
      mode: before.mode & 0o777,
    });
    await syncRegularTempFile(tempPath);
    const beforeRename = await readRegularFile(canonicalRoot, absPath);
    if (beforeRename.content !== expectedContent) {
      throw new Error(
        `design instrumentation conflict: ${absPath} changed before commit`,
      );
    }
    await assertStableAtomicPaths(canonicalRoot, absPath, tempPath);
    await fs.promises.rename(tempPath, absPath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function collectJsxFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [rootDir];
  while (queue.length && files.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git"))
          continue;
        const childDir = path.join(dir, entry.name);
        try {
          // A .git file (linked worktree) or directory marks another checkout.
          // Never instrument across that project boundary.
          await fs.promises.lstat(path.join(childDir, ".git"));
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        }
        queue.push(childDir);
      } else if (
        entry.isFile() &&
        JSX_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

export function createDesignInstrumentation(
  rootDir: string,
  options: DesignInstrumentationOptions = {},
): DesignInstrumentation {
  const canonicalRoot = fs.realpathSync(rootDir);
  const makeId = options.idFactory ?? defaultIdFactory();
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const index = new Map<string, InstrumentIndexEntry>();
  /** relPath → hash of the content WE last wrote (anti-echo, spec §7.3). */
  const selfWrites = new Map<string, string>();
  const touched = new Set<string>();
  /** relPath → ids inserted by this session; user-owned ids are never recorded. */
  const ownedIdsByFile = new Map<string, Set<string>>();
  /** All ids observed/issued in this session, including files not yet written. */
  const sessionReservedIds = new Set<string>();
  let active = false;
  let quarantined = false;

  async function persistOwnership(
    files: ReadonlyMap<string, ReadonlySet<string>> = ownedIdsByFile,
  ): Promise<void> {
    await writeOwnershipLedger(canonicalRoot, sessionId, files);
  }

  function containsOwnedId(
    code: string,
    ownedIds: ReadonlySet<string>,
  ): boolean {
    for (const id of ownedIds) {
      if (code.includes(`${NEXUS_ID_ATTR}="${id}"`)) return true;
    }
    return false;
  }

  async function cleanOwnedFile(
    relPath: string,
    ownedIds: ReadonlySet<string>,
  ): Promise<void> {
    const absPath = path.join(canonicalRoot, relPath);
    let content: string;
    try {
      content = (await readRegularFile(canonicalRoot, absPath)).content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cleaned = cleanupSource(content, ownedIds);
    if (cleaned === content && containsOwnedId(content, ownedIds)) {
      throw new Error(
        `design instrumentation cannot safely clean owned ids from ${relPath}`,
      );
    }
    if (cleaned !== content) {
      await replaceFileAtomically(
        canonicalRoot,
        absPath,
        content,
        cleaned,
        "deinstrument",
      );
    }
  }

  async function recoverStaleOwnership(): Promise<void> {
    const ledgers = await readOwnershipLedgers(canonicalRoot);
    const cleanupErrors: Error[] = [];
    for (const ledger of ledgers) {
      const pending = new Map<string, Set<string>>(
        Object.entries(ledger.files).map(([relPath, ids]) => [
          fromLedgerRelativePath(relPath),
          new Set(ids),
        ]),
      );
      for (const [relPath, ownedIds] of [...pending]) {
        try {
          await cleanOwnedFile(relPath, ownedIds);
          const nextPending = new Map(pending);
          nextPending.delete(relPath);
          await writeOwnershipLedger(
            canonicalRoot,
            ledger.sessionId,
            nextPending,
          );
          pending.delete(relPath);
        } catch (error) {
          cleanupErrors.push(
            error instanceof Error
              ? error
              : new Error(`stale cleanup failed: ${relPath}`),
          );
        }
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(
        cleanupErrors,
        `stale design instrumentation cleanup failed: ${cleanupErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
  }

  function quarantine(message: string): never {
    quarantined = true;
    active = false;
    index.clear();
    throw new Error(message);
  }

  function validateEntries(
    relPath: string,
    entries: readonly InstrumentEntry[],
  ): void {
    const idsInCandidate = new Set<string>();
    for (const entry of entries) {
      if (idsInCandidate.has(entry.id)) {
        quarantine(`duplicate data-nexus-id within ${relPath}`);
      }
      idsInCandidate.add(entry.id);
      const existing = index.get(entry.id);
      if (existing && existing.file !== relPath) {
        quarantine(
          `duplicate data-nexus-id across ${existing.file} and ${relPath}`,
        );
      }
    }
  }

  async function preflightUserOwnedIds(
    files: readonly string[],
  ): Promise<void> {
    const owners = new Map<string, string>();
    for (const absPath of files) {
      const relPath = path.relative(canonicalRoot, absPath);
      let snapshot: FileSnapshot;
      try {
        snapshot = await readRegularFile(canonicalRoot, absPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Buffer.byteLength(snapshot.content, "utf8") > MAX_FILE_BYTES)
        continue;
      const ast = parseSafe(snapshot.content);
      if (!ast) continue;
      for (const tag of collectOpeningTags(ast)) {
        if (!tag.hasId) continue;
        if (!tag.existingId) {
          quarantine(`non-literal data-nexus-id in ${relPath}`);
        }
        const existingOwner = owners.get(tag.existingId);
        if (existingOwner) {
          quarantine(
            `duplicate data-nexus-id across ${existingOwner} and ${relPath}`,
          );
        }
        owners.set(tag.existingId, relPath);
        sessionReservedIds.add(tag.existingId);
      }
    }
  }

  function dropFileFromIndex(relPath: string): void {
    for (const [id, entry] of [...index]) {
      if (entry.file === relPath) index.delete(id);
    }
  }

  async function instrumentFile(relPath: string): Promise<number> {
    if (quarantined) {
      throw new Error("design instrumentation is quarantined");
    }
    const absPath = path.join(canonicalRoot, relPath);
    let content: string;
    try {
      const snapshot = await readRegularFile(canonicalRoot, absPath);
      if (Buffer.byteLength(snapshot.content, "utf8") > MAX_FILE_BYTES)
        return 0;
      content = snapshot.content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const result = instrumentSource(content, makeId, sessionReservedIds);
    validateEntries(relPath, result.entries);
    const ast = parseSafe(content);
    if (
      ast &&
      collectOpeningTags(ast).some(
        (tag) => !tag.hasId && !tag.isDynamicArrayTemplate,
      ) &&
      result.insertedIds.length === 0
    ) {
      quarantine(`could not allocate a unique data-nexus-id for ${relPath}`);
    }
    const idsInFile = new Set(result.entries.map(({ id }) => id));
    const ownedIds = new Set(
      [...(ownedIdsByFile.get(relPath) ?? [])].filter((id) =>
        idsInFile.has(id),
      ),
    );
    for (const id of result.insertedIds) ownedIds.add(id);
    for (const { id } of result.entries) sessionReservedIds.add(id);
    dropFileFromIndex(relPath);
    for (const entry of result.entries) {
      index.set(entry.id, { ...entry, file: relPath });
    }
    const nextOwnership = new Map(ownedIdsByFile);
    if (ownedIds.size) nextOwnership.set(relPath, ownedIds);
    else nextOwnership.delete(relPath);
    // The journal is the authority after a crash and must reach disk before
    // any source can contain a newly issued id.
    await persistOwnership(nextOwnership);
    if (ownedIds.size) ownedIdsByFile.set(relPath, ownedIds);
    else ownedIdsByFile.delete(relPath);
    if (result.changed) {
      await replaceFileAtomically(canonicalRoot, absPath, content, result.code);
      selfWrites.set(relPath, contentHash(result.code));
      touched.add(relPath);
    }
    return result.entries.length;
  }

  return {
    get active() {
      return active;
    },

    async start() {
      return serializeInstrumentationRoot(canonicalRoot, async () => {
        if (active) throw new Error("design instrumentation is already active");
        if (quarantined)
          throw new Error("design instrumentation is quarantined");
        if (hasLiveInstrumentation(canonicalRoot)) {
          throw new Error(
            "design instrumentation is already active for this project",
          );
        }
        await recoverStaleOwnership();
        const files = await collectJsxFiles(canonicalRoot);
        await preflightUserOwnedIds(files);
        let elements = 0;
        for (const absPath of files) {
          elements += await instrumentFile(
            path.relative(canonicalRoot, absPath),
          );
        }
        active = true;
        markInstrumentationLive(canonicalRoot, sessionId);
        return { files: files.length, elements };
      });
    },

    async stop() {
      return serializeInstrumentationRoot(canonicalRoot, async () => {
        const cleanupErrors: Error[] = [];
        for (const [relPath, ownedIds] of [...ownedIdsByFile]) {
          try {
            await cleanOwnedFile(relPath, ownedIds);
            const nextOwnership = new Map(ownedIdsByFile);
            nextOwnership.delete(relPath);
            await persistOwnership(nextOwnership);
            ownedIdsByFile.delete(relPath);
            touched.delete(relPath);
            selfWrites.delete(relPath);
            dropFileFromIndex(relPath);
          } catch (error) {
            cleanupErrors.push(
              error instanceof Error
                ? error
                : new Error(`cleanup failed: ${relPath}`),
            );
          }
        }
        if (cleanupErrors.length) {
          // Keep the session live and its remaining ownership/index so a
          // later stop can retry without treating ids as user-owned.
          active = ownedIdsByFile.size > 0;
          throw new AggregateError(
            cleanupErrors,
            `design instrumentation cleanup failed: ${cleanupErrors
              .map((error) => error.message)
              .join("; ")}`,
          );
        }
        await deleteOwnershipLedger(canonicalRoot, sessionId);
        touched.clear();
        ownedIdsByFile.clear();
        selfWrites.clear();
        index.clear();
        sessionReservedIds.clear();
        active = false;
        releaseInstrumentationLive(canonicalRoot, sessionId);
      });
    },

    lookup(nexusId) {
      return index.get(nexusId) ?? null;
    },

    async refreshFile(relPath) {
      await serializeInstrumentationRoot(canonicalRoot, () =>
        instrumentFile(relPath),
      );
    },

    isSelfWrite(relPath, content) {
      return selfWrites.get(relPath) === contentHash(content);
    },

    noteSelfWrite(relPath, content) {
      selfWrites.set(relPath, contentHash(content));
      touched.add(relPath);
    },

    instrumentedFiles() {
      return [...touched];
    },
  };
}
