// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: pure path expansion
// only. Resynced 2026-09-11: brought the __PROGRAMDATA__ token fix (below);
// unlike upstream's raw `join(programData, programDataRest)` — correct only
// when actually running on Windows, since elsewhere `join` won't split on
// backslash — the remainder is split on both separators first, the same
// portable technique this file already used for `~/`.

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Windows OpenSSH's own placeholder for the system config directory's parent.
 *
 * It prints this token UNEXPANDED from `ssh -G` — captured from a real Windows
 * host: `globalknownhostsfile __PROGRAMDATA__\ssh/ssh_known_hosts`. Passed
 * through as a literal it misses with ENOENT, and an absent file is
 * indistinguishable from "no host is known there", so a site-managed
 * `known_hosts` would be silently invisible — including one holding a rotated
 * key that should have produced a mismatch.
 */
const PROGRAMDATA_TOKEN = '__PROGRAMDATA__';

/**
 * What follows the token when this path really starts with it, or null when
 * it does not.
 *
 * A bare `startsWith` also matches a path that merely BEGINS with those
 * characters, so a file named `__PROGRAMDATA__evil/x` would be rewritten to a
 * directory the user never named. It has to be the whole path or be followed
 * by a separator.
 */
function programDataTokenRemainder(filepath: string): string | null {
  if (!filepath.startsWith(PROGRAMDATA_TOKEN)) {
    return null;
  }
  const rest = filepath.slice(PROGRAMDATA_TOKEN.length);
  if (rest === '') {
    return rest;
  }
  // Both separators, because this path is Windows-shaped but may be parsed anywhere.
  return rest.startsWith('\\') || rest.startsWith('/') ? rest : null;
}

/** Expand leading `~` in SSH config paths (IdentityFile, ControlPath, etc.). */
export function resolveSshConfigHomePath(
  filepath: string,
  home: string = homedir(),
): string {
  const programDataRest = programDataTokenRemainder(filepath);
  if (programDataRest !== null) {
    // Left alone when the variable is unset rather than guessed: a wrong path
    // reads as "absent", which is the failure this expansion exists to
    // prevent, so it must not be invented.
    const programData = process.env.ProgramData;
    return programData
      ? join(programData, ...programDataRest.split(/[\\/]+/).filter(Boolean))
      : filepath;
  }
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
