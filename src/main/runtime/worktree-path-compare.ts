// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// (src/main/ipc/worktree-logic.ts — extraction of areWorktreePathsEqual and
// its private helpers only; the rest of worktree-logic is ORCA IPC-specific).
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: standalone module;
// statement style; no behavioral change.

import { posix, win32 } from 'node:path';

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

  if (platform === 'win32' || looksLikeWindowsPath(leftPath) || looksLikeWindowsPath(rightPath)) {
    const left = win32.normalize(win32.resolve(leftPath));
    const right = win32.normalize(win32.resolve(rightPath));
    // Why: `git worktree list` can report the same Windows path with different
    // slash styles or drive-letter casing than the path computed before
    // creation; those must compare as the same worktree.
    return left.toLowerCase() === right.toLowerCase();
  }
  const left = normalizePosixWorktreePathForComparison(leftPath, platform);
  const right = normalizePosixWorktreePathForComparison(rightPath, platform);
  return left === right;
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\') || pathValue.startsWith('//')
  );
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
