import fs from 'node:fs';
import path from 'node:path';
import { removeTreeSync } from '../util/remove-tree';

const SESSION_DIR_NAME = /^[0-9a-f]{32}$/;
const MAX_ROOT_ENTRIES_SCANNED = 2_048;
const MAX_SESSION_DIRS_REMOVED = 256;
const MAX_TREE_ENTRIES_SCANNED = 4_096;
const MAX_TREE_DEPTH = 32;

export interface ArtifactPurgeResult {
  removed: number;
  skippedActive: number;
  failed: number;
  truncated: boolean;
}

type VerifiedRoot =
  | { status: 'ok'; canonicalPath: string }
  | { status: 'missing' }
  | { status: 'unsafe' };

function emptyResult(): ArtifactPurgeResult {
  return { removed: 0, skippedActive: 0, failed: 0, truncated: false };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isBoundedTree(root: string): boolean {
  const pending: Array<{ entryPath: string; depth: number }> = [
    { entryPath: root, depth: 0 },
  ];
  let discovered = 1;

  while (pending.length > 0) {
    const current = pending.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current.entryPath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (current.depth >= MAX_TREE_DEPTH) return false;

    let dir: fs.Dir;
    try {
      dir = fs.opendirSync(current.entryPath);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    try {
      let entry: fs.Dirent | null;
      while ((entry = dir.readSync()) !== null) {
        discovered += 1;
        if (discovered > MAX_TREE_ENTRIES_SCANNED) return false;
        pending.push({
          entryPath: path.join(current.entryPath, entry.name),
          depth: current.depth + 1,
        });
      }
    } finally {
      dir.closeSync();
    }
  }
  return true;
}

function verifyOwnedRoot(root: string, trustedBoundary: string): VerifiedRoot {
  const resolvedBoundary = path.resolve(trustedBoundary);
  const resolvedRoot = path.resolve(root);
  const relativeRoot = path.relative(resolvedBoundary, resolvedRoot);
  if (
    relativeRoot === '' ||
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRoot)
  ) {
    return { status: 'unsafe' };
  }

  let canonicalBoundary: string;
  try {
    canonicalBoundary = fs.realpathSync.native(resolvedBoundary);
  } catch (error) {
    return { status: isMissing(error) ? 'missing' : 'unsafe' };
  }

  let current = canonicalBoundary;
  for (const segment of relativeRoot.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      return { status: isMissing(error) ? 'missing' : 'unsafe' };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { status: 'unsafe' };
    }
  }

  try {
    const canonicalPath = fs.realpathSync.native(current);
    const canonicalRelative = path.relative(canonicalBoundary, canonicalPath);
    if (
      canonicalRelative === '..' ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    ) {
      return { status: 'unsafe' };
    }
    return { status: 'ok', canonicalPath };
  } catch (error) {
    return { status: isMissing(error) ? 'missing' : 'unsafe' };
  }
}

function removeWithoutFollowing(candidate: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fs.unlinkSync(candidate);
    return true;
  }
  if (!isBoundedTree(candidate)) return false;
  // F-663: o rm recursivo do Node 24 (Electron 43) ATRAVESSA junctions no
  // Windows — era isto que apagava as conversas do provider-state no boot.
  // removeTreeSync tira cada link antes, sem seguir nenhum.
  removeTreeSync(candidate, {
    recursive: true,
    force: true,
    maxRetries: 2,
    retryDelay: 10,
  });
  return true;
}

/**
 * Removes only direct, hash-named session artifacts from one Nexus-owned root.
 * The root itself must be a real directory, never a symlink. Work per call is
 * bounded so a corrupt or attacker-inflated tree cannot stall application boot.
 */
export function purgeOwnedSessionRoot(
  root: string,
  activePaths: Iterable<string> = [],
  trustedBoundary: string = path.dirname(root),
): ArtifactPurgeResult {
  const result = emptyResult();
  const verifiedRoot = verifyOwnedRoot(root, trustedBoundary);
  if (verifiedRoot.status === 'missing') return result;
  if (verifiedRoot.status === 'unsafe') {
    result.failed += 1;
    return result;
  }
  const canonicalRoot = verifiedRoot.canonicalPath;

  const active = new Set(
    Array.from(activePaths, (item) => {
      try {
        return fs.realpathSync.native(item);
      } catch {
        return path.resolve(item);
      }
    }),
  );
  const candidates: string[] = [];
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(canonicalRoot);
  } catch (error) {
    if (isMissing(error)) return result;
    result.failed += 1;
    return result;
  }
  try {
    let entry: fs.Dirent | null;
    let scanned = 0;
    while ((entry = dir.readSync()) !== null) {
      scanned += 1;
      if (scanned > MAX_ROOT_ENTRIES_SCANNED) {
        result.truncated = true;
        break;
      }
      if (!SESSION_DIR_NAME.test(entry.name)) continue;
      if (candidates.length >= MAX_SESSION_DIRS_REMOVED) {
        result.truncated = true;
        continue;
      }
      const candidate = path.resolve(canonicalRoot, entry.name);
      if (path.dirname(candidate) === canonicalRoot) candidates.push(candidate);
    }
  } finally {
    dir.closeSync();
  }

  for (const candidate of candidates) {
    if (active.has(candidate)) {
      result.skippedActive += 1;
      continue;
    }
    try {
      if (removeWithoutFollowing(candidate)) result.removed += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export function mergeArtifactPurgeResults(
  ...results: ArtifactPurgeResult[]
): ArtifactPurgeResult {
  return results.reduce<ArtifactPurgeResult>(
    (merged, item) => ({
      removed: merged.removed + item.removed,
      skippedActive: merged.skippedActive + item.skippedActive,
      failed: merged.failed + item.failed,
      truncated: merged.truncated || item.truncated,
    }),
    emptyResult(),
  );
}
