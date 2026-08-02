import os from 'node:os';
import path from 'node:path';

/**
 * `~/.claude/skills` instead of `/Users/<name>/.claude/skills`.
 *
 * Every absolute path under the operator's home carries the OS account name,
 * and none of the surfaces that print one need it: the directory is the
 * decision-relevant fact, the username is not. It leaks into agent context,
 * into transcripts, and — worse — into documents an agent may commit, so the
 * conversion happens here, once, and every caller uses the same rule.
 *
 * A path outside home is not rewritten to a half-truth: it is reported as
 * `(outside home)`, because a `../../` chain is neither private nor readable.
 */
export const OUTSIDE_HOME_LABEL = '(outside home)';

export function homeRelativePath(absolutePath: string, home = os.homedir()): string {
  const relative = path.relative(home, absolutePath);
  if (relative === '') return '~';
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return OUTSIDE_HOME_LABEL;
  }
  return `~/${relative.split(path.sep).join('/')}`;
}

/** Home-relative directory of a file (the file name itself is not returned). */
export function homeRelativeDirOf(file: string, home = os.homedir()): string {
  return homeRelativePath(path.dirname(file), home);
}
