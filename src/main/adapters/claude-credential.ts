import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Claude Code subscription credential swap (macOS) — ported from the
 * ai-launcher account model (`conta_snapshot_to` / `conta_use`). The Claude CLI
 * keeps its OAuth session in the login keychain under the service
 * "Claude Code-credentials"; switching accounts = writing a different saved
 * credential blob back into that service, then re-spawning the CLI.
 *
 * We never store the blob in plaintext — the caller keeps it in the safeStorage
 * vault and hands it here only to read/restore.
 */

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export function isMac(): boolean {
  return process.platform === 'darwin';
}

/** Read the active Claude credential blob from the login keychain, or null. */
export function readActiveClaudeCredential(): string | null {
  if (!isMac()) return null;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null; // Not logged in / no keychain entry.
  }
}

/** Restore a saved credential blob into the active Claude keychain service. */
export function writeActiveClaudeCredential(blob: string): boolean {
  if (!isMac() || !blob) return false;
  try {
    // -U updates the existing item; -a account is $USER; -w is the secret.
    execFileSync(
      'security',
      [
        'add-generic-password',
        '-U',
        '-s',
        CLAUDE_KEYCHAIN_SERVICE,
        '-a',
        os.userInfo().username,
        '-w',
        blob,
      ],
      { stdio: 'ignore' },
    );
    return true;
  } catch (err) {
    console.warn('[claude-credential] failed to restore credential:', err);
    return false;
  }
}

/** The email of the currently signed-in Claude account (from ~/.claude.json). */
export function activeClaudeEmail(): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'),
    );
    const email = raw?.oauthAccount?.emailAddress;
    return typeof email === 'string' && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}
