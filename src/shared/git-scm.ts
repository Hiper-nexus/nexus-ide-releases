/**
 * Pure git SCM models + porcelain v1 parser for the source-control UI.
 * Keep this free of Electron / Node APIs so renderer and main can share it.
 */

export type GitFileChange = {
  path: string;
  /** Single-letter status for the section (M/A/D/R/C/U/?). */
  status: string;
  originalPath?: string;
};

export type GitScmSnapshot = {
  branch: string | null;
  remote: string | null;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  clean: boolean;
  raw: string;
  /** True when lists were truncated for UI safety. */
  truncated?: boolean;
};

export type GitLogEntry = {
  hash: string;
  subject: string;
};

export type GitMutateResult =
  | { ok: true }
  | { ok: false; error: string };

export type GitCommitResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

export type GitFileDiffResult =
  | { ok: true; diff: string; untracked?: boolean; truncated?: boolean }
  | { ok: false; error: string };

export type GitLogResult =
  | { ok: true; commits: GitLogEntry[] }
  | { ok: false; error: string };

export type GitStatusResult =
  | ({ ok: true } & GitScmSnapshot)
  | { ok: false; error: string };

/** Soft cap for file lists sent to the renderer. */
export const GIT_SCM_MAX_FILES = 2_000;

/** Soft cap for a single-file diff payload (bytes as UTF-16 code units ≈ chars). */
export const GIT_SCM_MAX_DIFF_CHARS = 512 * 1024;

/**
 * Reject pathspecs that can escape the workspace or look like flags.
 * Allows "." (stage/unstage all in cwd). Rejects any `..` segment.
 */
export function assertSafeGitPathspec(value: string): void {
  if (!value || typeof value !== 'string') {
    throw new Error('pathspec missing');
  }
  if (value !== value.trim()) {
    throw new Error('pathspec has leading or trailing whitespace');
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error('pathspec contains control characters');
  }
  if (value.startsWith('-')) {
    throw new Error('pathspec cannot start with "-"');
  }
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('pathspec must be workspace-relative');
  }
  const segments = value.split(/[/\\]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    throw new Error('pathspec cannot traverse parent directories');
  }
}

function statusLetter(code: string): string {
  const c = code.trim();
  if (!c) return '?';
  return c[0] ?? '?';
}

function pushUnique(
  list: GitFileChange[],
  entry: GitFileChange,
  seen: Set<string>,
): void {
  const key = `${entry.status}\0${entry.path}\0${entry.originalPath ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(entry);
}

/**
 * Parse `git status --porcelain=v1 -z`.
 * NUL-terminated entries avoid C-style quoting for awkward paths.
 * Renames/copies: `XY PATH\0ORIG_PATH\0`.
 */
export function parsePorcelainV1(stdout: string): Pick<
  GitScmSnapshot,
  'staged' | 'unstaged' | 'untracked' | 'clean' | 'raw' | 'truncated'
> {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  const seenStaged = new Set<string>();
  const seenUnstaged = new Set<string>();
  const seenUntracked = new Set<string>();

  // Support both -z (NUL) and legacy LF output for tests / fallbacks.
  const nulMode = stdout.includes('\0');
  if (!nulMode) {
    return parsePorcelainV1Lines(stdout);
  }

  const parts = stdout.split('\0');
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    i += 1;
    if (!entry) continue;
    if (entry.length < 3) continue;

    const x = entry[0]!;
    const y = entry[1]!;
    // Porcelain uses a space at index 2; tolerate missing separator.
    const path = entry[2] === ' ' ? entry.slice(3) : entry.slice(2);
    if (!path) continue;

    if (x === '?' && y === '?') {
      pushUnique(untracked, { path, status: '?' }, seenUntracked);
      continue;
    }
    if (x === '!' && y === '!') continue;

    const rename = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    let originalPath: string | undefined;
    if (rename) {
      const orig = parts[i];
      if (orig) {
        originalPath = orig;
        i += 1;
      }
    }

    if (x !== ' ' && x !== '?') {
      pushUnique(
        staged,
        {
          path,
          status: statusLetter(x),
          ...(originalPath ? { originalPath } : {}),
        },
        seenStaged,
      );
    }
    if (y !== ' ' && y !== '?') {
      pushUnique(
        unstaged,
        {
          path,
          status: statusLetter(y),
          ...(originalPath && (y === 'R' || y === 'C')
            ? { originalPath }
            : {}),
        },
        seenUnstaged,
      );
    }
  }

  return finalizeSnapshot(staged, unstaged, untracked, stdout);
}

/** LF-delimited porcelain (no -z). Used by tests and as a fallback. */
function parsePorcelainV1Lines(stdout: string): Pick<
  GitScmSnapshot,
  'staged' | 'unstaged' | 'untracked' | 'clean' | 'raw' | 'truncated'
> {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  const seenStaged = new Set<string>();
  const seenUnstaged = new Set<string>();
  const seenUntracked = new Set<string>();

  for (const line of stdout.split('\n')) {
    if (!line || line.length < 3) continue;
    const x = line[0]!;
    const y = line[1]!;
    const rest = unquotePorcelainPath(
      line[2] === ' ' ? line.slice(3) : line.slice(2),
    );

    if (x === '?' && y === '?') {
      pushUnique(untracked, { path: rest, status: '?' }, seenUntracked);
      continue;
    }
    if (x === '!' && y === '!') continue;

    const rename = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    const { path, originalPath } = rename
      ? parseRenamePath(rest)
      : { path: rest };

    if (x !== ' ' && x !== '?') {
      pushUnique(
        staged,
        {
          path,
          status: statusLetter(x),
          ...(originalPath ? { originalPath } : {}),
        },
        seenStaged,
      );
    }
    if (y !== ' ' && y !== '?') {
      pushUnique(
        unstaged,
        {
          path,
          status: statusLetter(y),
          ...(originalPath && (y === 'R' || y === 'C')
            ? { originalPath }
            : {}),
        },
        seenUnstaged,
      );
    }
  }

  return finalizeSnapshot(staged, unstaged, untracked, stdout);
}

function parseRenamePath(rest: string): { path: string; originalPath?: string } {
  const arrow = ' -> ';
  const idx = rest.lastIndexOf(arrow);
  if (idx === -1) return { path: rest };
  return {
    originalPath: unquotePorcelainPath(rest.slice(0, idx)),
    path: unquotePorcelainPath(rest.slice(idx + arrow.length)),
  };
}

/** Decode C-style quoted porcelain paths (`"a b\\t.txt"`). */
export function unquotePorcelainPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return raw;
  }
  let out = '';
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    const esc = raw[i];
    if (esc === undefined) break;
    switch (esc) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '"':
      case '\\':
        out += esc;
        break;
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      default:
        out += esc;
        break;
    }
  }
  return out;
}

function finalizeSnapshot(
  staged: GitFileChange[],
  unstaged: GitFileChange[],
  untracked: GitFileChange[],
  raw: string,
): Pick<
  GitScmSnapshot,
  'staged' | 'unstaged' | 'untracked' | 'clean' | 'raw' | 'truncated'
> {
  const total = staged.length + unstaged.length + untracked.length;
  let truncated = false;
  let s = staged;
  let u = unstaged;
  let t = untracked;
  if (total > GIT_SCM_MAX_FILES) {
    truncated = true;
    // Keep proportional head of each list.
    const budget = GIT_SCM_MAX_FILES;
    const ratio = budget / total;
    s = staged.slice(0, Math.max(1, Math.floor(staged.length * ratio)));
    u = unstaged.slice(0, Math.max(1, Math.floor(unstaged.length * ratio)));
    t = untracked.slice(0, Math.max(0, budget - s.length - u.length));
  }
  return {
    staged: s,
    unstaged: u,
    untracked: t,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    raw,
    truncated,
  };
}

export function parseGitLogOneline(stdout: string): GitLogEntry[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(' ');
      if (sp === -1) return { hash: line, subject: '' };
      return { hash: line.slice(0, sp), subject: line.slice(sp + 1) };
    });
}

export function truncateDiff(diff: string): {
  diff: string;
  truncated: boolean;
} {
  if (diff.length <= GIT_SCM_MAX_DIFF_CHARS) {
    return { diff, truncated: false };
  }
  const marker = '\n\n… [diff truncado para proteção da UI]';
  const keep = Math.max(0, GIT_SCM_MAX_DIFF_CHARS - marker.length);
  return {
    diff: diff.slice(0, keep) + marker,
    truncated: true,
  };
}

/** Convert NUL porcelain (-z) to LF short-status lines for legacy callers. */
export function porcelainZToLf(raw: string): string {
  if (!raw.includes('\0')) return raw;
  const parts = raw.split('\0');
  const lines: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    i += 1;
    if (!entry || entry.length < 3) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry[2] === ' ' ? entry.slice(3) : entry.slice(2);
    const rename = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    if (rename) {
      const orig = parts[i];
      if (orig) {
        i += 1;
        lines.push(`${x}${y} ${orig} -> ${path}`);
        continue;
      }
    }
    lines.push(`${x}${y} ${path}`);
  }
  return lines.join('\n');
}
