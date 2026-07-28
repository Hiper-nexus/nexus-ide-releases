import fs from 'node:fs';
import path from 'node:path';

/**
 * Filesystem authority a governed worker needs to commit inside a LINKED git
 * worktree.
 *
 * A linked worktree keeps only a `.git` FILE pointing at
 * `<repo>/.git/worktrees/<id>`, and git still writes the new objects, refs and
 * reflogs into the parent repository. Nexus places task worktrees under its own
 * runtime directory, so the Seatbelt profile — which grants the execution scope
 * root plus the sandbox dir — leaves that parent `.git` outside the writable
 * set and every commit dies with:
 *
 *   fatal: Unable to create '<repo>/.git/worktrees/<id>/index.lock':
 *   Operation not permitted
 *
 * The worker then correctly refuses to fake success, and the mission blocks.
 *
 * These are the exact subtrees a commit touches, measured against a real
 * Seatbelt profile — deliberately NOT the whole `.git`: `hooks/` would hand the
 * sandboxed process arbitrary host code execution and `config` would let it
 * rewrite remotes and filters. Both stay unwritable.
 */
const COMMON_DIR_WRITE_ENTRIES = [
  'objects',
  'refs',
  'logs',
  // Written when git opportunistically re-packs refs. Its absence is normal and
  // a denial here is not fatal, but granting it keeps the log clean.
  'packed-refs',
] as const;

function readGitDirPointer(worktreeDir: string): string | null {
  const dotGit = path.join(worktreeDir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dotGit);
  } catch {
    return null;
  }
  // A real directory means an ordinary checkout: the profile already covers it.
  if (stat.isDirectory()) return null;
  if (!stat.isFile()) return null;
  let pointer: string;
  try {
    pointer = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/mu.exec(pointer.trim());
  if (!match) return null;
  const target = match[1]!.trim();
  return path.isAbsolute(target)
    ? target
    : path.resolve(worktreeDir, target);
}

function readCommonDir(gitDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (!raw) return gitDir;
    return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
  } catch {
    // No commondir: the gitdir is already the repository directory.
    return gitDir;
  }
}

/** Never writable: one is host code execution, the other rewrites remotes. */
const COMMON_DIR_PROTECTED_ENTRIES = ['hooks', 'config'] as const;

export interface LinkedWorktreeGitPaths {
  /**
   * The repository directory must be READABLE as a whole: git stats and lists
   * it while resolving the worktree, and denying it yields
   * `fatal: not a git repository` — the commit never even starts.
   */
  readonly readPaths: readonly string[];
  /** Exactly the subtrees a commit mutates. */
  readonly writePaths: readonly string[];
  /** Carved back out of any writable grant, as defence in depth. */
  readonly protectedPaths: readonly string[];
}

const EMPTY: LinkedWorktreeGitPaths = Object.freeze({
  readPaths: Object.freeze([]),
  writePaths: Object.freeze([]),
  protectedPaths: Object.freeze([]),
});

function realpathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

/**
 * Filesystem authority `git commit` needs from `worktreeDir`. Returns empty for
 * an ordinary checkout, an unreadable pointer, or anything that does not
 * resolve to a real directory — the caller must never widen the sandbox on a
 * guess.
 */
export function linkedWorktreeGitPaths(
  worktreeDir: string,
): LinkedWorktreeGitPaths {
  const gitDir = readGitDirPointer(worktreeDir);
  if (!gitDir) return EMPTY;
  const realGitDir = realpathOrNull(gitDir);
  if (
    !realGitDir ||
    !fs.statSync(realGitDir, { throwIfNoEntry: false })?.isDirectory()
  ) {
    return EMPTY;
  }
  const commonDir = readCommonDir(realGitDir);
  const readPaths = new Set<string>();
  for (const candidate of [realGitDir, commonDir]) {
    const real = realpathOrNull(candidate);
    if (real) readPaths.add(real);
  }
  const writePaths = new Set<string>();
  for (const candidate of [
    realGitDir,
    ...COMMON_DIR_WRITE_ENTRIES.map((entry) => path.join(commonDir, entry)),
  ]) {
    const real = realpathOrNull(candidate);
    // Absent entries (a fresh repo has no packed-refs) are simply not granted.
    if (real) writePaths.add(real);
  }
  const protectedPaths = new Set<string>();
  for (const entry of COMMON_DIR_PROTECTED_ENTRIES) {
    const real = realpathOrNull(path.join(commonDir, entry));
    if (real) protectedPaths.add(real);
  }
  return Object.freeze({
    readPaths: Object.freeze([...readPaths].sort()),
    writePaths: Object.freeze([...writePaths].sort()),
    protectedPaths: Object.freeze([...protectedPaths].sort()),
  });
}
