import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../../shared/types';
import {
  LANGUAGE_BY_EXT,
  SECRET_BASENAME_PATTERN,
  SKIP_DIRECTORIES,
  SOURCE_EXTENSIONS,
  type OrientationLimits,
} from './orientation-types';
import {
  throwIfOrientationAborted,
  yieldOrientationChunk,
} from './orientation-cooperative';

export interface WalkedFile {
  readonly relativePath: string;
  readonly ext: string;
  readonly language: string | null;
  readonly size: number;
  readonly isSource: boolean;
  readonly isSecretName: boolean;
}

export interface OrientationWalkResult {
  readonly files: readonly WalkedFile[];
  readonly truncated: boolean;
  readonly treeFingerprintParts: readonly string[];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * F-1322: um filho com `.git` (arquivo de worktree ou pasta de repo) é a
 * raiz de OUTRO checkout — `.harvest/`, `.nexus-worktrees/`, clone do
 * usuário. Descer nele esgota o orçamento com fontes alheias e deixa o
 * `src/` atual fora do mapa.
 */
function isNestedCheckoutRoot(absoluteChild: string): boolean {
  return fs.existsSync(path.join(absoluteChild, '.git'));
}

/**
 * Safe recursive inventory walk. Skips symlinks, secret basenames (listed but
 * never read for content), and standard build/vendor dirs.
 */
export function walkOrientationTree(
  scope: ProjectExecutionScope,
  limits: OrientationLimits,
): OrientationWalkResult {
  const root = fs.realpathSync(scope.rootRealPath);
  if (root !== scope.rootRealPath) {
    throw new Error('project root identity changed');
  }
  const files: WalkedFile[] = [];
  const fingerprintParts: string[] = [];
  let truncated = false;
  let totalBytes = 0;

  function visit(relative: string, depth: number): void {
    if (truncated) return;
    if (depth > limits.maxDepth) {
      truncated = true;
      return;
    }
    const absolute = path.join(root, relative);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let real: string;
      try {
        real = fs.realpathSync(absolute);
      } catch {
        return;
      }
      if (!isInside(root, real)) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(real, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
        if (entry.isDirectory() && isNestedCheckoutRoot(path.join(real, entry.name))) continue;
        const child = relative ? path.join(relative, entry.name) : entry.name;
        visit(child, depth + 1);
        if (truncated) return;
      }
      return;
    }
    if (!stat.isFile()) return;
    const base = path.basename(relative);
    if (SECRET_BASENAME_PATTERN.test(base)) {
      // Record presence for fingerprint only; never treat as source content.
      fingerprintParts.push(`${relative}\0secret\0${stat.size}`);
      return;
    }
    const ext = path.extname(base).toLowerCase();
    const isSource = SOURCE_EXTENSIONS.has(ext);
    const size = stat.size;
    if (size > limits.maxFileBytes) {
      fingerprintParts.push(`${relative}\0skip-size\0${size}`);
      return;
    }
    // maxTotalBytes limita conteúdo LIDO; só fonte é lida (structural-index).
    if (isSource) totalBytes += size;
    if (files.length >= limits.maxFiles || totalBytes > limits.maxTotalBytes) {
      truncated = true;
      return;
    }
    const posixPath = relative.split(path.sep).join('/');
    files.push(
      Object.freeze({
        relativePath: posixPath,
        ext,
        language: LANGUAGE_BY_EXT[ext] ?? null,
        size,
        isSource,
        isSecretName: false,
      }),
    );
    fingerprintParts.push(`${posixPath}\0${size}\0${stat.mtimeMs}`);
  }

  visit('', 0);
  return Object.freeze({
    files: Object.freeze(files),
    truncated,
    treeFingerprintParts: Object.freeze(fingerprintParts),
  });
}

/**
 * Production walker. Filesystem operations and traversal chunks yield back to
 * Electron instead of monopolizing the main process on large repositories.
 * The synchronous walker remains available for deterministic pure callers and
 * compatibility tests, but ProjectOrientationService uses this variant.
 */
export async function walkOrientationTreeAsync(
  scope: ProjectExecutionScope,
  limits: OrientationLimits,
  signal?: AbortSignal,
): Promise<OrientationWalkResult> {
  throwIfOrientationAborted(signal);
  const root = await fs.promises.realpath(scope.rootRealPath);
  if (root !== scope.rootRealPath) {
    throw new Error('project root identity changed');
  }
  const files: WalkedFile[] = [];
  const fingerprintParts: string[] = [];
  let truncated = false;
  let totalBytes = 0;
  let visited = 0;

  async function visit(relative: string, depth: number): Promise<void> {
    if (truncated) return;
    throwIfOrientationAborted(signal);
    if (depth > limits.maxDepth) {
      truncated = true;
      return;
    }
    visited += 1;
    await yieldOrientationChunk(visited, signal);

    const absolute = path.join(root, relative);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(absolute);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let real: string;
      try {
        real = await fs.promises.realpath(absolute);
      } catch {
        return;
      }
      if (!isInside(root, real)) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(real, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
        if (entry.isDirectory() && isNestedCheckoutRoot(path.join(real, entry.name))) continue;
        const child = relative ? path.join(relative, entry.name) : entry.name;
        await visit(child, depth + 1);
        if (truncated) return;
      }
      return;
    }
    if (!stat.isFile()) return;
    const base = path.basename(relative);
    if (SECRET_BASENAME_PATTERN.test(base)) {
      fingerprintParts.push(`${relative}\0secret\0${stat.size}`);
      return;
    }
    const ext = path.extname(base).toLowerCase();
    const isSource = SOURCE_EXTENSIONS.has(ext);
    const size = stat.size;
    if (size > limits.maxFileBytes) {
      fingerprintParts.push(`${relative}\0skip-size\0${size}`);
      return;
    }
    // maxTotalBytes limita conteúdo LIDO; só fonte é lida (structural-index).
    if (isSource) totalBytes += size;
    if (files.length >= limits.maxFiles || totalBytes > limits.maxTotalBytes) {
      truncated = true;
      return;
    }
    const posixPath = relative.split(path.sep).join('/');
    files.push(
      Object.freeze({
        relativePath: posixPath,
        ext,
        language: LANGUAGE_BY_EXT[ext] ?? null,
        size,
        isSource,
        isSecretName: false,
      }),
    );
    fingerprintParts.push(`${posixPath}\0${size}\0${stat.mtimeMs}`);
  }

  await visit('', 0);
  throwIfOrientationAborted(signal);
  return Object.freeze({
    files: Object.freeze(files),
    truncated,
    treeFingerprintParts: Object.freeze(fingerprintParts),
  });
}
