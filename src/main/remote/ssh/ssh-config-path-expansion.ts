// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: pure path expansion only.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand leading `~` in SSH config paths (IdentityFile, ControlPath, etc.). */
export function resolveSshConfigHomePath(
  filepath: string,
  home: string = homedir(),
): string {
  if (filepath === '~') {
    return home;
  }
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    return join(
      home,
      ...filepath
        .slice(2)
        .split(/[\\/]+/)
        .filter(Boolean),
    );
  }
  return filepath;
}
