/**
 * Pure helpers: git status / diff / branch / remote for the active workspace.
 *
 * The workspace path is trusted, but the repository CONTENTS are not: a cloned
 * repo can carry executable local config (`core.fsmonitor`, a `.gitattributes`
 * diff/textconv driver, hooks) that git would run merely on `status`/`diff`.
 * Every call therefore goes through the hardened ProcessGitRunner — which
 * disables hooks/fsmonitor and scrubs the GIT_, LD_ and DYLD_ env families —
 * and the untrusted status/diff reads additionally refuse a repo whose local
 * config is executable.
 */
import { parseHostedRemote } from '../git/hosted-remote-url';
import { ProcessGitRunner, assertSafeLocalGitConfig } from '../runtime/git-command';

const runner = new ProcessGitRunner();

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

export function gitDiff(cwd: string, staged = false): { ok: true; diff: string } | { ok: false; error: string } {
  try {
    assertSafeLocalGitConfig(runner, cwd);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unsafe repository' };
  }
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

export function gitStatusShort(cwd: string): string {
  try {
    assertSafeLocalGitConfig(runner, cwd);
  } catch (err) {
    return err instanceof Error ? err.message : 'unsafe repository';
  }
  const r = git(cwd, ['status', '--short']);
  return r.ok ? r.stdout : r.stderr;
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
