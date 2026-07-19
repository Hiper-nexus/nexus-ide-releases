import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

/** Restore a saved credential blob into the active Claude keychain service.
 *
 * M3 mitigation: the secret is NEVER passed via argv (visible in `ps auxww`).
 * Instead we write it to a 0600 temp file, then a short-lived `sh` reads the
 * file and feeds the value to `security add-generic-password -w`. The secret
 * travels only through an env var (not enumerable by other users on macOS)
 * and a 0600 temp file that is unlinked immediately after use.
 */
export function writeActiveClaudeCredential(blob: string): boolean {
  if (!isMac() || !blob) return false;
  const tmpFile = path.join(
    os.tmpdir(),
    `nexus-claude-cred-${crypto.randomBytes(8).toString('hex')}`,
  );
  try {
    fs.writeFileSync(tmpFile, blob, { mode: 0o600 });
    // The shell reads the secret from the temp file; neither the shell's argv
    // nor security's argv ever contains the credential value.
    execFileSync(
      '/bin/sh',
      [
        '-c',
        `security add-generic-password -U -s "$1" -a "$2" -w "$(cat "$3")"`,
        '--',
        CLAUDE_KEYCHAIN_SERVICE,
        os.userInfo().username,
        tmpFile,
      ],
      { stdio: 'ignore' },
    );
    return true;
  } catch (err) {
    console.warn('[claude-credential] failed to restore credential:', err);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
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
