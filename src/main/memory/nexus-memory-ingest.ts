import fs from 'node:fs';
import {
  CANONICAL_MEMORY_PROJECTION,
  DEFAULT_MEMORY_DIR,
  extractProjectionBody,
  memoryProjectionPath,
  parseFrontmatter,
  projectionBody,
  resolveMemoryRoot,
  type CanonicalMemoryProjectionInput,
} from './nexus-memory';

/**
 * Reads operator edits back out of the readable projection.
 *
 * This is the half of H4 that inverts the old premise ("never an ingestion
 * source") without discarding the reason that premise existed. A file becomes
 * an *edit* only when every one of these holds:
 *
 *   1. it is the projection of a row that is already active in SQLite — the
 *      caller supplies the record set, so a planted file for an id that has no
 *      row is not an edit, it is litter the reaper removes;
 *   2. it still carries the canonical marker and declares its own filename as
 *      its id — the identity rule from the projection hardening, untouched: a
 *      file may speak for itself and for nothing else;
 *   3. its frontmatter `updatedAt` equals the row's current `updated_at` — the
 *      operator edited the version SQLite still holds, not a buffer opened
 *      before the row moved on;
 *   4. its rendered body actually differs from what the row renders to.
 *
 * Anything the file says beyond its body — kind, importance, source, scope,
 * timestamps — is never read back. Provenance stays a property of the bank.
 */

export interface ProjectionEdit {
  readonly id: string;
  readonly path: string;
  /** Body as the operator left it; still unredacted at this point. */
  readonly content: string;
  /** Row version the edit was made against; the optimistic-concurrency token. */
  readonly baseUpdatedAt: number;
}

async function readProjectionFile(filePath: string): Promise<string | null> {
  try {
    if (!(await fs.promises.lstat(filePath)).isFile()) return null;
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    // Missing or unreadable: the write pass repairs it from SQLite.
    return null;
  }
}

async function editFor(
  root: string,
  record: CanonicalMemoryProjectionInput,
): Promise<ProjectionEdit | null> {
  const filePath = memoryProjectionPath(root, record.id);
  const raw = await readProjectionFile(filePath);
  if (raw === null) return null;

  const frontmatter = parseFrontmatter(raw);
  if (frontmatter.canonical !== CANONICAL_MEMORY_PROJECTION) return null;
  if (frontmatter.idFromFm !== record.id) return null;
  if (frontmatter.updatedAt !== record.updatedAt) return null;

  const body = extractProjectionBody(raw);
  if (body.length === 0) return null;
  if (body === projectionBody(record)) return null;

  return Object.freeze({
    id: record.id,
    path: filePath,
    content: body,
    baseUpdatedAt: record.updatedAt,
  });
}

/** F-764: lê os arquivos com `fs.promises` — a passada nunca para o Main. */
export async function collectProjectionEdits(
  projectRoot: string,
  records: readonly CanonicalMemoryProjectionInput[],
  dirname = DEFAULT_MEMORY_DIR,
): Promise<ProjectionEdit[]> {
  let root: string;
  try {
    root = resolveMemoryRoot(projectRoot, dirname);
  } catch {
    return [];
  }
  const edits: ProjectionEdit[] = [];
  for (const record of records) {
    const edit = await editFor(root, record);
    if (edit) edits.push(edit);
  }
  return edits;
}
