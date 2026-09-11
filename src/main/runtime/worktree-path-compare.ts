// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// (src/main/ipc/worktree-path-comparison.ts — extraction of
// areWorktreePathsEqual and its private helpers only; worktreePathComparisonKey
// and dedupeWorktreesByPath are ORCA relay/listing-specific and stay out).
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: standalone module;
// statement style; Windows-path detection resynced onto the shared
// isWindowsAbsolutePathLike helper instead of a duplicate local regex.

import { posix, win32 } from 'node:path';
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path';

export function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (looksLikePosixAbsolutePath(leftPath) || looksLikePosixAbsolutePath(rightPath)) {
    // Why: local WSL projects run POSIX paths on a Windows desktop; comparing
    // them with win32 rules can delete or dedupe the wrong runtime-owned path.
    if (!looksLikePosixAbsolutePath(leftPath) || !looksLikePosixAbsolutePath(rightPath)) {
      return false;
    }
    const left = normalizePosixWorktreePathForComparison(leftPath, platform);
    const right = normalizePosixWorktreePathForComparison(rightPath, platform);
    return left === right;
  }

  if (
    platform === 'win32' ||
    isWindowsAbsolutePathLike(leftPath) ||
    isWindowsAbsolutePathLike(rightPath)
  ) {
    // Why: `git worktree list` can report the same Windows path with different
    // slash styles or drive-letter casing than the path computed before
    // creation; those must compare as the same worktree.
    return (
      normalizeWindowsWorktreePathForComparison(leftPath) ===
      normalizeWindowsWorktreePathForComparison(rightPath)
    );
  }
  const left = normalizePosixWorktreePathForComparison(leftPath, platform);
  const right = normalizePosixWorktreePathForComparison(rightPath, platform);
  return left === right;
}

function normalizeWindowsWorktreePathForComparison(pathValue: string): string {
  return win32.normalize(win32.resolve(pathValue)).toLowerCase();
}

function looksLikePosixAbsolutePath(pathValue: string): boolean {
  return pathValue.startsWith('/') && !pathValue.startsWith('//');
}

function normalizePosixWorktreePathForComparison(
  pathValue: string,
  platform: NodeJS.Platform,
): string {
  const normalized = posix.normalize(posix.resolve(pathValue));
  if (platform !== 'darwin') {
    return normalized;
  }
  if (normalized === '/private/tmp') {
    return '/tmp';
  }
  return normalized.startsWith('/private/tmp/') ? normalized.slice('/private'.length) : normalized;
}
