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

/**
 * Existing paths that must be writable for `git commit` to succeed from
 * `worktreeDir`. Returns an empty list for an ordinary checkout, an unreadable
 * pointer, or anything that does not resolve to a real directory — the caller
 * must never widen the sandbox on a guess.
 */
export function linkedWorktreeGitWritePaths(
  worktreeDir: string,
): string[] {
  const gitDir = readGitDirPointer(worktreeDir);
  if (!gitDir) return [];
  let realGitDir: string;
  try {
    realGitDir = fs.realpathSync.native(gitDir);
  } catch {
    return [];
  }
  if (!fs.statSync(realGitDir, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }
  const commonDir = readCommonDir(realGitDir);
  const candidates = [
    realGitDir,
    ...COMMON_DIR_WRITE_ENTRIES.map((entry) => path.join(commonDir, entry)),
  ];
  const resolved = new Set<string>();
  for (const candidate of candidates) {
    try {
      resolved.add(fs.realpathSync.native(candidate));
    } catch {
      // Absent entries (a fresh repo has no packed-refs) are simply not granted.
    }
  }
  return [...resolved].sort();
}
