// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: subset — only the
// helpers needed by worktree removal safety are imported in this harvest; the
// remaining runtime-path helpers arrive with the remote/WSL harvest.

/** True for `C:\…`, `C:/…`, `\\Server\…` and forward-slash UNC `//Server/…`. */
export function isWindowsAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}
