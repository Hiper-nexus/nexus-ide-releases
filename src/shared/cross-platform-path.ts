// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: subset — only the
// helpers needed by worktree removal safety are imported in this harvest; the
// remaining runtime-path helpers (WSL UNC aliasing, NFC comparison folding,
// etc., grown substantially upstream) stay deferred to a future remote/WSL
// harvest. Resynced 2026-09-11: isWindowsAbsolutePathLike itself is unchanged
// upstream, so no code changed here.

/** True for `C:\…`, `C:/…`, `\\Server\…` and forward-slash UNC `//Server/…`. */
export function isWindowsAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}
