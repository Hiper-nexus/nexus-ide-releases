/**
 * Pure helpers: git status / diff / branch / remote for the active workspace.
 */
import { spawnSync } from 'node:child_process';
import { parseHostedRemote } from '../git/hosted-remote-url';

function git(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string; code: number } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
    code: r.status ?? 1,
  };
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
  const args = staged ? ['diff', '--cached'] : ['diff', 'HEAD'];
  const r = git(cwd, args);
  // git diff exits 1 when there are differences — still success for our UI.
  if (r.code !== 0 && r.code !== 1) {
    return { ok: false, error: r.stderr.trim() || `git diff exit ${r.code}` };
  }
  return { ok: true, diff: r.stdout };
}

export function gitStatusShort(cwd: string): string {
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
