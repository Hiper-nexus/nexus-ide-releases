import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import { orientationCacheDirectory } from './orientation-cache';
import { normalizeOrientationChangedPath } from './orientation-path-policy';
import type {
  OrientationStructuralFile,
  OrientationStructuralIndex,
} from './orientation-structural-index';
import type { DbUsageEdge } from './orientation-db-usage';
import type { SchemaEntityFact } from './orientation-schema';
import {
  throwIfOrientationAborted,
  yieldOrientationWork,
} from './orientation-cooperative';

const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_INDEX_FILES = 100_000;
const MAX_DECLARATIONS_PER_FILE = 2_048;
const MAX_IMPORTS_PER_FILE = 4_096;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/;

export function orientationStructuralIndexPath(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): string {
  return path.join(
    orientationCacheDirectory(cacheRoot, scope),
    'structural-index.json',
  );
}

function stringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some(
      (item) => typeof item !== 'string' || item.length > maxLength,
    )
  ) {
    return null;
  }
  return Object.freeze([...value] as string[]);
}

/** Teto de fatos de banco por arquivo; o writer corta no mesmo número. */
export const MAX_DB_FACTS_PER_FILE = 4_096;
/** Maior string que o leitor aceita num fato de banco. */
export const MAX_DB_FACT_STRING_LENGTH = 1_024;

function optionalString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_DB_FACT_STRING_LENGTH);
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DB_FACT_STRING_LENGTH;
}

/** Validate a persisted array of plain records; null when anything is off. */
function recordArray<T>(
  value: unknown,
  isValid: (item: Record<string, unknown>) => boolean,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length > MAX_DB_FACTS_PER_FILE) return null;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (!isValid(item as Record<string, unknown>)) return null;
  }
  return Object.freeze(value.map((item) => Object.freeze({ ...item }))) as readonly T[];
}

const DB_KINDS = new Set(['table', 'function']);
const DB_RELATIONS = new Set(['reads', 'writes', 'calls']);

function parseFile(value: unknown): OrientationStructuralFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const relativePath =
    typeof raw.relativePath === 'string'
      ? normalizeOrientationChangedPath(raw.relativePath)
      : null;
  const declarations = stringArray(
    raw.declarations,
    MAX_DECLARATIONS_PER_FILE,
    128,
  );
  const importSpecifiers = stringArray(
    raw.importSpecifiers,
    MAX_IMPORTS_PER_FILE,
    1_024,
  );
  // Indexes written before the db graph existed lack these fields: reject
  // them (forcing a rebuild) instead of silently dropping every db fact.
  const dbSchemaFacts = recordArray<SchemaEntityFact>(raw.dbSchemaFacts, (fact) =>
    DB_KINDS.has(fact.kind as string) &&
    boundedString(fact.qualifiedName) &&
    boundedString(fact.name) &&
    boundedString(fact.definedIn) &&
    (fact.rlsEnabled === undefined || typeof fact.rlsEnabled === 'boolean') &&
    optionalString(fact.modelName) &&
    optionalString(fact.drizzleBinding));
  const dbUsageEdges = recordArray<DbUsageEdge>(raw.dbUsageEdges, (edge) =>
    boundedString(edge.from) &&
    DB_KINDS.has(edge.toKind as string) &&
    boundedString(edge.toQualifiedName) &&
    DB_RELATIONS.has(edge.relation as string) &&
    optionalString(edge.prismaModel) &&
    optionalString(edge.drizzleBinding));
  if (
    !dbSchemaFacts ||
    !dbUsageEdges ||
    !relativePath ||
    relativePath !== raw.relativePath ||
    typeof raw.ext !== 'string' ||
    raw.ext.length > 24 ||
    !(typeof raw.language === 'string' || raw.language === null) ||
    !Number.isSafeInteger(raw.size) ||
    (raw.size as number) < 0 ||
    typeof raw.mtimeMs !== 'number' ||
    !Number.isFinite(raw.mtimeMs) ||
    (raw.mtimeMs as number) < 0 ||
    typeof raw.isSource !== 'boolean' ||
    typeof raw.isContentIndexed !== 'boolean' ||
    !declarations ||
    !importSpecifiers
  ) {
    return null;
  }
  return Object.freeze({
    relativePath,
    ext: raw.ext,
    language: raw.language,
    size: raw.size,
    mtimeMs: raw.mtimeMs,
    isSource: raw.isSource,
    isContentIndexed: raw.isContentIndexed,
    declarations,
    importSpecifiers,
    dbSchemaFacts,
    dbUsageEdges,
  }) as OrientationStructuralFile;
}

function parseOrientationStructuralIndex(
  raw: Record<string, unknown>,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): OrientationStructuralIndex | null {
  if (
    raw.schemaVersion !== 1 ||
    raw.projectId !== scope.projectId ||
    raw.checkoutId !== scope.checkoutId ||
    !(raw.headSha === null ||
      (typeof raw.headSha === 'string' && SHA_PATTERN.test(raw.headSha))) ||
    typeof raw.truncated !== 'boolean' ||
    !Array.isArray(raw.files) ||
    raw.files.length > MAX_INDEX_FILES
  ) {
    return null;
  }
  const files = raw.files.map(parseFile);
  if (files.some((item) => item === null)) return null;
  const concrete = files as OrientationStructuralFile[];
  const paths = new Set(concrete.map((item) => item.relativePath));
  if (paths.size !== concrete.length) return null;
  return Object.freeze({
    schemaVersion: 1,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    headSha: raw.headSha,
    truncated: raw.truncated,
    files: Object.freeze(
      concrete.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)),
    ),
  }) as OrientationStructuralIndex;
}

function readableIndexStat(stat: fs.Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.size <= MAX_INDEX_BYTES;
}

export function readOrientationStructuralIndex(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): OrientationStructuralIndex | null {
  const file = orientationStructuralIndexPath(cacheRoot, scope);
  try {
    if (!readableIndexStat(fs.lstatSync(file))) return null;
    return parseOrientationStructuralIndex(
      JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>,
      scope,
    );
  } catch {
    return null;
  }
}

/** Same contract as the sync reader, without blocking Main on disk I/O (F-1238). */
export async function readOrientationStructuralIndexAsync(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
): Promise<OrientationStructuralIndex | null> {
  const file = orientationStructuralIndexPath(cacheRoot, scope);
  try {
    if (!readableIndexStat(await fs.promises.lstat(file))) return null;
    return parseOrientationStructuralIndex(
      JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>,
      scope,
    );
  } catch {
    return null;
  }
}

export function writeOrientationStructuralIndex(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  index: OrientationStructuralIndex,
): void {
  const dir = orientationCacheDirectory(cacheRoot, scope);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = orientationStructuralIndexPath(cacheRoot, scope);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/**
 * Streaming writer used by the main-process service. It avoids constructing a
 * possible 128 MB JSON string and yields between bounded file records.
 */
export async function writeOrientationStructuralIndexAsync(
  cacheRoot: string,
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  index: OrientationStructuralIndex,
  signal?: AbortSignal,
): Promise<void> {
  throwIfOrientationAborted(signal);
  const dir = orientationCacheDirectory(cacheRoot, scope);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = orientationStructuralIndexPath(cacheRoot, scope);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    const header = JSON.stringify({
      schemaVersion: 1,
      projectId: index.projectId,
      checkoutId: index.checkoutId,
      headSha: index.headSha,
      truncated: index.truncated,
    });
    await handle.write(`${header.slice(0, -1)},"files":[`);
    for (let fileIndex = 0; fileIndex < index.files.length; fileIndex += 1) {
      await handle.write(
        `${fileIndex === 0 ? '' : ','}${JSON.stringify(index.files[fileIndex])}`,
      );
      if (fileIndex > 0 && fileIndex % 64 === 0) {
        await yieldOrientationWork(signal);
      }
    }
    await handle.write(']}\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
