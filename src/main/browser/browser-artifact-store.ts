import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

const ARTIFACT_DIRECTORY = 'browser-artifacts';
const SCREENSHOT_TYPE = 'screenshot';
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 200;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

const metadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    paneId: z.string().min(1).max(128),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    url: z.string().max(4096),
    title: z.string().max(512),
    capturedAt: z.number().int().nonnegative().safe(),
  })
  .strict();
const missionIdSchema = z.string().min(1).max(256).nullable();
const rowSchema = z
  .object({
    id: z.string().min(1).max(256),
    mission_id: z.string().min(1).max(256).nullable(),
    session_id: z.string().min(1).max(128),
    storage_key: z.string().min(1).max(4096),
    metadata_json: z.string(),
    created_at: z.number().int().nonnegative().safe(),
  })
  .strict();

export interface BrowserScreenshotArtifact {
  readonly id: string;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId: string | null;
  readonly paneId: string;
  readonly storageKey: string;
  readonly path: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly title: string;
  readonly capturedAt: number;
}

export interface RecordBrowserScreenshotInput {
  readonly paneId: string;
  readonly missionId?: string | null;
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly title: string;
  readonly capturedAt?: number;
}

export interface BrowserArtifactStoreOptions {
  readonly now?: () => number;
  readonly maxArtifacts?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
}

export interface BrowserArtifactPruneResult {
  readonly removed: number;
  readonly freedBytes: number;
}

interface RetentionRow {
  readonly id: string;
  readonly storage_key: string;
  readonly created_at: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function ensureArtifactDirectory(runtimeDirectory: string): string {
  const candidate = path.join(runtimeDirectory, ARTIFACT_DIRECTORY);
  try {
    fs.mkdirSync(candidate, { mode: 0o700 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error as NodeJS.ErrnoException).code !== 'EEXIST'
    ) {
      throw error;
    }
  }
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('browser artifact directory is unsafe');
  }
  const real = fs.realpathSync(candidate);
  if (!isInside(runtimeDirectory, real) || real !== candidate) {
    throw new Error('browser artifact directory escapes project runtime');
  }
  fs.chmodSync(real, 0o700);
  return real;
}

function safeStorageKey(raw: string): string {
  const value = raw.replaceAll('\\', '/');
  const normalized = path.posix.normalize(value);
  if (
    value !== raw ||
    normalized !== value ||
    path.posix.isAbsolute(value) ||
    value === '..' ||
    value.startsWith('../')
  ) {
    throw new Error('invalid browser artifact storage key');
  }
  return value;
}

function unlinkVerifiedArtifact(filePath: string, expected: fs.Stats): void {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  let isClosed = false;
  try {
    const descriptor = fs.fstatSync(fd);
    if (
      descriptor.dev !== expected.dev ||
      descriptor.ino !== expected.ino ||
      !descriptor.isFile() ||
      descriptor.nlink !== 1
    ) {
      throw new Error('browser artifact changed before retention removal');
    }
    const current = fs.lstatSync(filePath);
    if (
      current.isSymbolicLink() ||
      current.dev !== descriptor.dev ||
      current.ino !== descriptor.ino
    ) {
      throw new Error('browser artifact path changed before retention removal');
    }
    if (process.platform === 'win32') {
      fs.closeSync(fd);
      isClosed = true;
    }
    fs.unlinkSync(filePath);
  } finally {
    if (!isClosed) fs.closeSync(fd);
  }
}

export class ScopedBrowserArtifactStore {
  readonly scope: ProjectExecutionScope;
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #now: () => number;
  readonly #maxArtifacts: number;
  readonly #maxTotalBytes: number;
  readonly #maxAgeMs: number;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: BrowserArtifactStoreOptions = {},
  ) {
    this.#runtimeManager = runtimeManager;
    this.scope = Object.freeze(projectExecutionScopeSchema.parse({ ...scope }));
    this.#now = options.now ?? Date.now;
    this.#maxArtifacts = z.number().int().min(1).max(10_000)
      .parse(options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS);
    this.#maxTotalBytes = z.number().int().min(1).max(16 * 1024 * 1024 * 1024)
      .parse(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
    this.#maxAgeMs = z.number().int().min(1).max(365 * 24 * 60 * 60_000)
      .parse(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  }

  assertWritable(): void {
    this.#runtimeManager.open(this.scope).assertWritable();
  }

  recordScreenshot(rawInput: RecordBrowserScreenshotInput): BrowserScreenshotArtifact {
    const capturedAt = rawInput.capturedAt ?? this.#now();
    const metadata = metadataSchema.parse({
      schemaVersion: 1,
      paneId: rawInput.paneId,
      width: rawInput.width,
      height: rawInput.height,
      url: rawInput.url,
      title: rawInput.title,
      capturedAt,
    });
    const missionId = missionIdSchema.parse(rawInput.missionId ?? null);
    if (!Buffer.isBuffer(rawInput.png) || rawInput.png.length === 0) {
      throw new Error('browser screenshot PNG is empty');
    }
    if (rawInput.png.length > MAX_SCREENSHOT_BYTES) {
      throw new Error('browser screenshot PNG exceeds the size limit');
    }
    this.#prune(rawInput.png.length, 1);
    const runtime = this.#runtimeManager.open(this.scope);
    runtime.assertWritable();
    const runtimeDirectory = path.dirname(runtime.databasePath);
    const artifactDirectory = ensureArtifactDirectory(runtimeDirectory);
    const id = `browser-${randomUUID()}`;
    const fileName = `${id}.png`;
    const storageKey = safeStorageKey(`${ARTIFACT_DIRECTORY}/${fileName}`);
    const filePath = path.join(artifactDirectory, fileName);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let fileCreated = false;
    try {
      const fd = fs.openSync(
        filePath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollow,
        0o600,
      );
      fileCreated = true;
      try {
        fs.writeFileSync(fd, rawInput.png);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const sha256 = createHash('sha256').update(rawInput.png).digest('hex');
      runtime.db
        .prepare(
          `INSERT INTO browser_artifacts
             (id, mission_id, session_id, artifact_type, storage_key,
              metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          missionId,
          metadata.paneId,
          SCREENSHOT_TYPE,
          storageKey,
          JSON.stringify({ ...metadata, sha256 }),
          capturedAt,
        );
      return {
        id,
        projectId: this.scope.projectId,
        checkoutId: this.scope.checkoutId,
        missionId,
        paneId: metadata.paneId,
        storageKey,
        path: filePath,
        sha256,
        width: metadata.width,
        height: metadata.height,
        url: metadata.url,
        title: metadata.title,
        capturedAt,
      };
    } catch (error) {
      if (fileCreated) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Preserve the authoritative write/database failure as the cause.
        }
      }
      throw error;
    }
  }

  /** Handoff proof reads one indexed artifact and hashes bounded chunks off the hot path. */
  async verifiedScreenshot(id: string, assertCurrent: () => void = () => {}): Promise<BrowserScreenshotArtifact | null> {
    assertCurrent();
    if (!/^browser-[a-z0-9-]{1,128}$/i.test(id)) return null;
    const runtime = this.#runtimeManager.open(this.scope);
    const raw = runtime.db.prepare(`SELECT id, mission_id, session_id, storage_key, metadata_json, created_at
      FROM browser_artifacts WHERE id = ? AND artifact_type = ?`).get(id, SCREENSHOT_TYPE);
    if (!raw) return null;
    try {
      const row = rowSchema.parse(raw);
      const metadata = metadataSchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(row.metadata_json));
      if (row.session_id !== metadata.paneId || row.created_at !== metadata.capturedAt) return null;
      const storageKey = safeStorageKey(row.storage_key);
      const root = path.dirname(runtime.databasePath);
      const filePath = path.resolve(root, storageKey);
      if (!isInside(root, filePath) || await fs.promises.realpath(filePath) !== filePath) return null;
      assertCurrent();
      const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_SCREENSHOT_BYTES) return null;
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < stat.size) {
          assertCurrent();
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (!bytesRead) return null;
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        const after = await fs.promises.lstat(filePath);
        assertCurrent();
        if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs || hash.digest('hex') !== metadata.sha256 || await fs.promises.realpath(filePath) !== filePath) return null;
        assertCurrent();
        return { id: row.id, projectId: this.scope.projectId, checkoutId: this.scope.checkoutId,
          missionId: row.mission_id, paneId: metadata.paneId, storageKey, path: filePath,
          sha256: metadata.sha256, width: metadata.width, height: metadata.height,
          url: metadata.url, title: metadata.title, capturedAt: metadata.capturedAt };
      } finally { await handle.close(); }
    } catch { assertCurrent(); return null; }
  }

  listScreenshots(paneId?: string): BrowserScreenshotArtifact[] {
    const parsedPaneId =
      paneId === undefined
        ? undefined
        : z.string().min(1).max(128).parse(paneId);
    const runtime = this.#runtimeManager.open(this.scope);
    const rows = parsedPaneId
      ? runtime.db
          .prepare(
            `SELECT id, mission_id, session_id, storage_key, metadata_json,
                    created_at
             FROM browser_artifacts
             WHERE artifact_type = ? AND session_id = ?
             ORDER BY created_at DESC, id DESC`,
          )
          .all(SCREENSHOT_TYPE, parsedPaneId)
      : runtime.db
          .prepare(
            `SELECT id, mission_id, session_id, storage_key, metadata_json,
                    created_at
             FROM browser_artifacts
             WHERE artifact_type = ?
             ORDER BY created_at DESC, id DESC`,
          )
          .all(SCREENSHOT_TYPE);
    return rows.map((raw) => this.#fromRow(raw, runtime.databasePath));
  }

  prune(): BrowserArtifactPruneResult {
    return this.#prune(0, 0);
  }

  #prune(reservedBytes: number, reservedCount: number): BrowserArtifactPruneResult {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('browser artifact retention clock is invalid');
    }
    const runtime = this.#runtimeManager.open(this.scope);
    runtime.assertWritable();
    const runtimeDirectory = path.dirname(runtime.databasePath);
    const artifactDirectory = ensureArtifactDirectory(runtimeDirectory);
    const rows = runtime.db.prepare(
      `SELECT id, storage_key, created_at
       FROM browser_artifacts
       WHERE artifact_type = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(SCREENSHOT_TYPE) as RetentionRow[];
    const candidates = rows.map((row) => {
      const storageKey = safeStorageKey(row.storage_key);
      const filePath = path.resolve(runtimeDirectory, storageKey);
      if (
        !isInside(artifactDirectory, filePath) ||
        path.dirname(filePath) !== artifactDirectory
      ) {
        throw new Error('browser artifact retention path is unsafe');
      }
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new Error('browser artifact retention file is unsafe');
      }
      return { row, filePath, stat, bytes: stat.size };
    });
    let totalBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
    let totalCount = candidates.length;
    const selected = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.row.created_at <= now - this.#maxAgeMs) {
        selected.add(candidate.row.id);
        totalBytes -= candidate.bytes;
        totalCount -= 1;
      }
    }
    for (const candidate of candidates) {
      if (
        totalCount + reservedCount <= this.#maxArtifacts &&
        totalBytes + reservedBytes <= this.#maxTotalBytes
      ) {
        break;
      }
      if (selected.has(candidate.row.id)) continue;
      selected.add(candidate.row.id);
      totalBytes -= candidate.bytes;
      totalCount -= 1;
    }
    if (
      totalCount + reservedCount > this.#maxArtifacts ||
      totalBytes + reservedBytes > this.#maxTotalBytes
    ) {
      throw new Error('browser screenshot cannot fit the checkout artifact quota');
    }

    let freedBytes = 0;
    let removed = 0;
    for (const candidate of candidates) {
      if (!selected.has(candidate.row.id)) continue;
      unlinkVerifiedArtifact(candidate.filePath, candidate.stat);
      const result = runtime.db.prepare(
        'DELETE FROM browser_artifacts WHERE id = ? AND artifact_type = ?',
      ).run(candidate.row.id, SCREENSHOT_TYPE);
      if (result.changes !== 1) {
        throw new Error('browser artifact retention database conflict');
      }
      freedBytes += candidate.bytes;
      removed += 1;
    }
    return Object.freeze({ removed, freedBytes });
  }

  #fromRow(raw: unknown, databasePath: string): BrowserScreenshotArtifact {
    try {
      const row = rowSchema.parse(raw);
      const metadata = metadataSchema
        .extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(row.metadata_json));
      if (row.session_id !== metadata.paneId || row.created_at !== metadata.capturedAt) {
        throw new Error('browser artifact identity mismatch');
      }
      const storageKey = safeStorageKey(row.storage_key);
      const runtimeDirectory = path.dirname(databasePath);
      const filePath = path.resolve(runtimeDirectory, storageKey);
      if (!isInside(runtimeDirectory, filePath)) {
        throw new Error('browser artifact path escapes runtime');
      }
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new Error('browser artifact file is unsafe');
      }
      const real = fs.realpathSync(filePath);
      if (real !== filePath || !isInside(runtimeDirectory, real)) {
        throw new Error('browser artifact file changed identity');
      }
      const noFollow = fs.constants.O_NOFOLLOW ?? 0;
      const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      let actualSha256: string;
      try {
        const descriptorStat = fs.fstatSync(fd);
        if (
          descriptorStat.dev !== stat.dev ||
          descriptorStat.ino !== stat.ino ||
          descriptorStat.size > MAX_SCREENSHOT_BYTES
        ) {
          throw new Error('browser artifact descriptor identity changed');
        }
        actualSha256 = createHash('sha256')
          .update(fs.readFileSync(fd))
          .digest('hex');
      } finally {
        fs.closeSync(fd);
      }
      if (actualSha256 !== metadata.sha256) {
        throw new Error('browser artifact checksum mismatch');
      }
      return {
        id: row.id,
        projectId: this.scope.projectId,
        checkoutId: this.scope.checkoutId,
        missionId: row.mission_id,
        paneId: metadata.paneId,
        storageKey,
        path: filePath,
        sha256: metadata.sha256,
        width: metadata.width,
        height: metadata.height,
        url: metadata.url,
        title: metadata.title,
        capturedAt: metadata.capturedAt,
      };
    } catch (error) {
      throw new Error('invalid scoped browser artifact', { cause: error });
    }
  }
}

export function createScopedBrowserArtifactStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: BrowserArtifactStoreOptions = {},
): ScopedBrowserArtifactStore {
  return new ScopedBrowserArtifactStore(runtimeManager, scope, options);
}
