import path from 'node:path';
import {
  SECRET_BASENAME_PATTERN,
  SKIP_DIRECTORIES,
} from './orientation-types';
import {
  sortOrientationItems,
  yieldOrientationWork,
} from './orientation-cooperative';

/**
 * Normalize a Git/workspace-relative path and apply the same exclusions used
 * by the full orientation walk. This is lexical by design so deleted files
 * can still be filtered without touching the filesystem.
 */
export function normalizeOrientationChangedPath(
  candidate: string,
): string | null {
  if (
    !candidate ||
    candidate.includes('\0') ||
    path.isAbsolute(candidate)
  ) {
    return null;
  }

  const slashed = candidate.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const normalized = path.posix.normalize(slashed);
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    return null;
  }

  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        SKIP_DIRECTORIES.has(segment),
    )
  ) {
    return null;
  }
  const basename = segments.at(-1);
  if (!basename || SECRET_BASENAME_PATTERN.test(basename)) return null;
  return normalized;
}

export function filterOrientationChangedPaths(
  candidates: readonly string[],
): readonly string[] {
  const eligible = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeOrientationChangedPath(candidate);
    if (normalized) eligible.add(normalized);
  }
  return Object.freeze(
    [...eligible].sort((left, right) => left.localeCompare(right)),
  );
}

export async function filterOrientationChangedPathsAsync(
  candidates: readonly string[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const eligible = new Set<string>();
  for (
    let candidateIndex = 0;
    candidateIndex < candidates.length;
    candidateIndex += 1
  ) {
    const normalized = normalizeOrientationChangedPath(
      candidates[candidateIndex],
    );
    if (normalized) eligible.add(normalized);
    if (candidateIndex > 0 && candidateIndex % 512 === 0) {
      await yieldOrientationWork(signal);
    }
  }
  return sortOrientationItems(
    [...eligible],
    (left, right) => left.localeCompare(right),
    signal,
  );
}
