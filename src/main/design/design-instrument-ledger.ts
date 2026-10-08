import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KeyedLock } from "../util/keyed-lock";

const LEDGER_SCHEMA_VERSION = 1;
const MAX_LEDGER_BYTES = 256 * 1024;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DESIGN_INSTRUMENTATION_LEDGER_DIR = path.join(
  ".nexus",
  "design-instrumentation",
);

export interface InstrumentationOwnershipLedger {
  schemaVersion: 1;
  sessionId: string;
  files: Record<string, string[]>;
}

const rootOperationLock = new KeyedLock();
const liveSessionsByRoot = new Map<string, Set<string>>();

export function serializeInstrumentationRoot<T>(
  rootReal: string,
  operation: () => Promise<T>,
): Promise<T> {
  return rootOperationLock.run(rootReal, operation);
}

export function hasLiveInstrumentation(rootReal: string): boolean {
  return (liveSessionsByRoot.get(rootReal)?.size ?? 0) > 0;
}

export function markInstrumentationLive(
  rootReal: string,
  sessionId: string,
): void {
  const sessions = liveSessionsByRoot.get(rootReal) ?? new Set<string>();
  sessions.add(sessionId);
  liveSessionsByRoot.set(rootReal, sessions);
}

export function releaseInstrumentationLive(
  rootReal: string,
  sessionId: string,
): void {
  const sessions = liveSessionsByRoot.get(rootReal);
  sessions?.delete(sessionId);
  if (sessions?.size === 0) liveSessionsByRoot.delete(rootReal);
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("invalid design instrumentation session id");
  }
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function ensureRegularDirectory(
  rootReal: string,
  directory: string,
): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await fs.promises.lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      `design instrumentation ledger directory is a symlink or not a directory: ${directory}`,
    );
  }
  const directoryReal = await fs.promises.realpath(directory);
  if (!isInsideRoot(rootReal, directoryReal)) {
    throw new Error(
      "design instrumentation ledger escaped project containment",
    );
  }
}

export async function ensureLedgerDirectory(rootReal: string): Promise<string> {
  const nexusDir = path.join(rootReal, ".nexus");
  await ensureRegularDirectory(rootReal, nexusDir);
  const ledgerDir = path.join(rootReal, DESIGN_INSTRUMENTATION_LEDGER_DIR);
  await ensureRegularDirectory(rootReal, ledgerDir);
  return ledgerDir;
}

function normalizeRelativeFile(relPath: string): string {
  const portable = relPath.replaceAll("\\", "/");
  if (
    !portable ||
    portable.startsWith("/") ||
    /^[A-Za-z]:\//.test(portable) ||
    portable.split("/").includes("..")
  ) {
    throw new Error(`invalid design instrumentation ledger path: ${relPath}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === "." || normalized.startsWith("../")) {
    throw new Error(`invalid design instrumentation ledger path: ${relPath}`);
  }
  return normalized;
}

export function fromLedgerRelativePath(relPath: string): string {
  return normalizeRelativeFile(relPath).split("/").join(path.sep);
}

function validateLedger(
  value: unknown,
  expectedSessionId: string,
): InstrumentationOwnershipLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid design instrumentation ledger");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== LEDGER_SCHEMA_VERSION ||
    candidate.sessionId !== expectedSessionId ||
    !candidate.files ||
    typeof candidate.files !== "object" ||
    Array.isArray(candidate.files) ||
    Object.keys(candidate).some(
      (key) => !["schemaVersion", "sessionId", "files"].includes(key),
    )
  ) {
    throw new Error("invalid design instrumentation ledger");
  }
  const files: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  for (const [rawPath, rawIds] of Object.entries(
    candidate.files as Record<string, unknown>,
  )) {
    const relPath = normalizeRelativeFile(rawPath);
    if (
      !Array.isArray(rawIds) ||
      rawIds.length === 0 ||
      rawIds.length > 100_000 ||
      rawIds.some(
        (id) =>
          typeof id !== "string" ||
          id.length === 0 ||
          id.length > 128 ||
          /[\u0000-\u001f\u007f]/.test(id),
      )
    ) {
      throw new Error(
        `invalid design instrumentation ownership for ${relPath}`,
      );
    }
    files[relPath] = [...new Set(rawIds as string[])];
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sessionId: expectedSessionId,
    files,
  };
}

async function readRegularLedger(
  ledgerDir: string,
  fileName: string,
): Promise<InstrumentationOwnershipLedger> {
  const sessionId = fileName.slice(0, -".json".length);
  assertSessionId(sessionId);
  const filePath = path.join(ledgerDir, fileName);
  const metadata = await fs.promises.lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `design instrumentation ledger is not a regular file: ${fileName}`,
    );
  }
  if (metadata.size > MAX_LEDGER_BYTES) {
    throw new Error(`design instrumentation ledger is too large: ${fileName}`);
  }
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const raw = await handle.readFile("utf8");
    return validateLedger(JSON.parse(raw) as unknown, sessionId);
  } catch (error) {
    throw new Error(
      `invalid design instrumentation ledger ${fileName}: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  } finally {
    await handle.close();
  }
}

export async function readOwnershipLedgers(
  rootReal: string,
): Promise<InstrumentationOwnershipLedger[]> {
  const ledgerDir = await ensureLedgerDirectory(rootReal);
  const entries = await fs.promises.readdir(ledgerDir, { withFileTypes: true });
  const ledgers: InstrumentationOwnershipLedger[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        `design instrumentation ledger is not a regular file: ${entry.name}`,
      );
    }
    ledgers.push(await readRegularLedger(ledgerDir, entry.name));
  }
  return ledgers;
}

function canonicalLedger(
  sessionId: string,
  files: ReadonlyMap<string, ReadonlySet<string>>,
): InstrumentationOwnershipLedger {
  assertSessionId(sessionId);
  const serialized: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  for (const [relPath, ids] of [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!ids.size) continue;
    serialized[normalizeRelativeFile(relPath)] = [...ids].sort();
  }
  return validateLedger(
    { schemaVersion: LEDGER_SCHEMA_VERSION, sessionId, files: serialized },
    sessionId,
  );
}

export async function writeOwnershipLedger(
  rootReal: string,
  sessionId: string,
  files: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<void> {
  const ledger = canonicalLedger(sessionId, files);
  if (Object.keys(ledger.files).length === 0) {
    await deleteOwnershipLedger(rootReal, sessionId);
    return;
  }
  const ledgerDir = await ensureLedgerDirectory(rootReal);
  const target = path.join(ledgerDir, `${sessionId}.json`);
  const temp = path.join(ledgerDir, `.${sessionId}.${crypto.randomUUID()}.tmp`);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      temp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(ledger)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await ensureRegularDirectory(rootReal, ledgerDir);
    try {
      const targetMetadata = await fs.promises.lstat(target);
      if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) {
        throw new Error("design instrumentation ledger target is not regular");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.promises.rename(temp, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function deleteOwnershipLedger(
  rootReal: string,
  sessionId: string,
): Promise<void> {
  assertSessionId(sessionId);
  const ledgerDir = await ensureLedgerDirectory(rootReal);
  const target = path.join(ledgerDir, `${sessionId}.json`);
  try {
    const metadata = await fs.promises.lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("design instrumentation ledger target is not regular");
    }
    await fs.promises.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
