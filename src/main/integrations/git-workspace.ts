/**
 * Pure helpers: git status / diff / branch / remote / stage / commit for the
 * active workspace (Source Control UI + integrations).
 *
 * The workspace path is trusted, but the repository CONTENTS are not: a cloned
 * repo can carry executable local config (`core.fsmonitor`, a `.gitattributes`
 * diff/textconv driver, hooks) that git would run merely on `status`/`diff`.
 * Every call therefore goes through the hardened ProcessGitRunner — which
 * disables hooks/fsmonitor and scrubs the GIT_, LD_ and DYLD_ env families —
 * and the untrusted status/diff reads additionally refuse a repo whose local
 * config is executable.
 */
import {
  assertSafeGitPathspec,
  parseGitLogOneline,
  parsePorcelainV1,
  truncateDiff,
  type GitCommitResult,
  type GitFileDiffResult,
  type GitLogResult,
  type GitMutateResult,
  type GitStatusResult,
} from '../../shared/git-scm';
import { parseHostedRemote } from '../git/hosted-remote-url';
import { ProcessGitRunner, assertSafeLocalGitConfig } from '../runtime/git-command';

const runner = new ProcessGitRunner();
const MAX_COMMIT_MESSAGE = 4096;
const MAX_PATHS = 500;

function git(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string; code: number } {
  try {
    const r = runner.run(cwd, args, { allowFailure: true });
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, code: r.status };
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      code: 1,
    };
  }
}

function refuseUnsafeConfig(cwd: string): string | null {
  try {
    assertSafeLocalGitConfig(runner, cwd);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'unsafe repository';
  }
}

function normalizePaths(paths: string[]): string[] | { error: string } {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { error: 'paths required' };
  }
  if (paths.length > MAX_PATHS) {
    return { error: `too many paths (max ${MAX_PATHS})` };
  }
  try {
    for (const p of paths) assertSafeGitPathspec(p);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return paths;
}

export function gitCurrentBranch(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return null;
  const b = r.stdout.trim();
  return b && b !== 'HEAD' ? b : null;
}

export function gitRemoteOrigin(cwd: string): string | null {
  const r = git(cwd, ['config', '--get', 'remote.origin.url']);
  if (!r.ok) return null;
  return r.stdout.trim() || null;
}

/**
 * The repo's real default branch, so "create PR" never hardcodes 'main'.
 * Prefers the cached origin/HEAD symbolic ref (no network); falls back to
 * 'main' when the remote head is unknown (fresh clone / no remote).
 */
export function gitDefaultBranch(cwd: string): string {
  const symbolic = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (symbolic.ok) {
    const ref = symbolic.stdout.trim().replace(/^origin\//, '');
    if (ref) return ref;
  }
  return 'main';
}

/**
 * Push the current branch to origin with upstream tracking. Required before a
 * PR: GitHub 422s when the head branch was never pushed. Returns a structured
 * result so the UI can surface the real git error instead of a cryptic HTTP.
 */
// git branch names that are safe as a push TARGET: no refspec metacharacters.
// A pathspec validator is not enough here — ':' would let 'a:refs/heads/b'
// become a refspec pushing a local ref to an arbitrary remote branch, and a
// leading '+' would force-push. Restrict to the plain ref-name charset.
const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export function gitPushCurrentBranch(cwd: string, branch: string): GitMutateResult {
  const unsafe = refuseUnsafeConfig(cwd);
  if (unsafe) return { ok: false, error: unsafe };
  const name = branch.trim();
  if (!name || name === 'HEAD') return { ok: false, error: 'no branch to push' };
  if (!SAFE_BRANCH_NAME.test(name) || name.startsWith('-') || name.includes('..')) {
    return { ok: false, error: `nome de branch inválido para push: ${name}` };
  }
  const r = git(cwd, ['push', '--set-upstream', 'origin', name]);
  if (!r.ok) {
    return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `git push exit ${r.code}` };
  }
  return { ok: true };
}

export function gitDiff(cwd: string, staged = false): { ok: true; diff: string } | { ok: false; error: string } {
  const unsafe = refuseUnsafeConfig(cwd);
  if (unsafe) return { ok: false, error: unsafe };
  // --no-ext-diff blocks a repo-supplied external diff driver from running.
  const args = staged
    ? ['diff', '--no-ext-diff', '--cached']
    : ['diff', '--no-ext-diff', 'HEAD'];
  const r = git(cwd, args);
  // git diff exits 1 when there are differences — still success for our UI.
  if (r.code !== 0 && r.code !== 1) {
    return { ok: false, error: r.stderr.trim() || `git diff exit ${r.code}` };
  }
  return { ok: true, diff: r.stdout };
}

/** Structured status for the Source Control panel. */
export function gitScmStatus(cwd: string): GitStatusResult {
  const unsafe = refuseUnsafeConfig(cwd);
  if (unsafe) return { ok: false, error: unsafe };
  // -z: NUL-terminated paths (no C-quoting) — required for spaces/unicode.
  const r = git(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
  ]);
  if (!r.ok) {
    return { ok: false, error: r.stderr.trim() || `git status exit ${r.code}` };
  }
  const parsed = parsePorcelainV1(r.stdout);
  return {
    ok: true,
    branch: gitCurrentBranch(cwd),
    remote: gitRemoteOrigin(cwd),
    ...parsed,
  };
}

export function gitStage(cwd: string, paths: string[]): GitMutateResult {
  const unsafe = refuseUnsafeConfig(cwd);
  if (unsafe) return { ok: false, error: unsafe };
  const normalized = normalizePaths(paths);
  if ('error' in normalized) return { ok: false, error: normalized.error };
  const r = git(cwd, ['add', '--', ...normalized]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || `git add exit ${r.code}` };
  return { ok: true };
}

export function gitUnstage(cwd: string, paths: string[]): GitMutateResult {
  const unsafe = refuseUnsafeConfig(cwd);
  if (unsafe) return { ok: false, error: unsafe };
  const normalized = normalizePaths(paths);
  if ('error' in normalized) return { ok: false, error: normalized.error };
  const r = git(cwd, ['restore', '--staged', '--', ...normalized]);
  if (!r.ok) {
    return {
      ok: false,
      error: r.stderr.trim() || `git restore --staged exit ${r.code}`,
    };
  }
  return { ok: true };
}

export function gitCommitMessage(cwd: string, message: string): GitCommitResult {
  const unsafe = refuseUnsafeConfig(cwd);
  if (unsafe) return { ok: false, error: unsafe };
  const msg = message.trim();
  if (!msg) return { ok: false, error: 'commit message required' };
  if (msg.length > MAX_COMMIT_MESSAGE) {
    return { ok: false, error: `commit message too long (max ${MAX_COMMIT_MESSAGE})` };
  }
  if (/[\0]/.test(msg)) return { ok: false, error: 'commit message contains NUL' };
  const r = git(cwd, ['commit', '-m', msg]);
  if (!r.ok) {
    return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `git commit exit ${r.code}` };
  }
  return { ok: true, summary: r.stdout.trim() || 'committed' };
}

export function gitLogOneline(cwd: string, count = 20): GitLogResult {
  const unsafe = refuseUnsafeConfig(cwd);
  if (unsafe) return { ok: false, error: unsafe };
  const n = Number.isInteger(count) && count > 0 ? Math.min(count, 100) : 20;
  const r = git(cwd, ['log', '--oneline', '-n', String(n)]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || `git log exit ${r.code}` };
  return { ok: true, commits: parseGitLogOneline(r.stdout) };
}

export function gitFileDiff(
  cwd: string,
  path: string,
  opts: { staged?: boolean; untracked?: boolean } = {},
): GitFileDiffResult {
  const unsafe = refuseUnsafeConfig(cwd);
  if (unsafe) return { ok: false, error: unsafe };
  try {
    assertSafeGitPathspec(path);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (opts.untracked) {
    return { ok: true, diff: '', untracked: true };
  }
  const args = opts.staged
    ? ['diff', '--no-ext-diff', '--cached', '--', path]
    : ['diff', '--no-ext-diff', 'HEAD', '--', path];
  const r = git(cwd, args);
  if (r.code !== 0 && r.code !== 1) {
    return { ok: false, error: r.stderr.trim() || `git diff exit ${r.code}` };
  }
  const { diff, truncated } = truncateDiff(r.stdout);
  return { ok: true, diff, truncated };
}

export function parseGithubRepo(
  remoteUrl: string | null,
): { owner: string; name: string; host: string } | null {
  if (!remoteUrl) return null;
  const parsed = parseHostedRemote(remoteUrl);
  if (!parsed || parsed.provider !== 'github') return null;
  const parts = parsed.path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0]!, name: parts[1]!, host: parsed.host };
}
