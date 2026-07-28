import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Claude Code subscription credential swap (macOS) — ported from the
 * ai-launcher account model (`conta_snapshot_to` / `conta_use`). The Claude CLI
 * keeps its OAuth session in the login keychain under the service
 * "Claude Code-credentials"; switching accounts = writing a different saved
 * credential blob back into that service, then re-spawning the CLI.
 *
 * Modern Claude stores a fat blob: `claudeAiOauth` (login) + a large `mcpOAuth`
 * map (plugin MCP secrets). Nexus only vaults and restores the slim OAuth
 * slice so multi-account write stays under the interactive `security -i`
 * line-buffer limit and never clobbers plugin MCP secrets on purpose.
 *
 * We never store the blob in plaintext — the caller keeps it in the safeStorage
 * vault and hands it here only to read/restore.
 */

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Interactive `security -i` reads each command as a single line into a fixed
 * buffer (~4 KiB). Above this we refuse the line path rather than truncate.
 */
export const CLAUDE_KEYCHAIN_INTERACTIVE_CMD_MAX_BYTES = 3500;

export function isMac(): boolean {
  return process.platform === 'darwin';
}

export interface ClaudeAiOauthSlice {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[] | string;
  subscriptionType?: string;
  rateLimitTier?: string;
  [key: string]: unknown;
}

/**
 * Pure transform: keep only the OAuth login slice required for session restore
 * and env materialization. Drops `mcpOAuth` and any other top-level keys.
 * Returns null when there is no usable access token.
 */
export function slimClaudeCredentialBlob(blob: string): string | null {
  if (!blob || typeof blob !== 'string') return null;
  try {
    const parsed = JSON.parse(blob) as {
      claudeAiOauth?: Record<string, unknown>;
    };
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) {
      return null;
    }
    const accessToken = oauth.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return null;
    }
    // Preserve known session fields; do not invent values.
    const slimOauth: ClaudeAiOauthSlice = { accessToken };
    if (typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0) {
      slimOauth.refreshToken = oauth.refreshToken;
    }
    if (typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt)) {
      slimOauth.expiresAt = oauth.expiresAt;
    }
    if (
      typeof oauth.refreshTokenExpiresAt === 'number' &&
      Number.isFinite(oauth.refreshTokenExpiresAt)
    ) {
      slimOauth.refreshTokenExpiresAt = oauth.refreshTokenExpiresAt;
    }
    if (Array.isArray(oauth.scopes)) {
      const scopes = oauth.scopes.filter(
        (s): s is string => typeof s === 'string' && s.length > 0,
      );
      if (scopes.length > 0) slimOauth.scopes = scopes;
    } else if (typeof oauth.scopes === 'string' && oauth.scopes.trim()) {
      slimOauth.scopes = oauth.scopes.trim();
    }
    if (typeof oauth.subscriptionType === 'string' && oauth.subscriptionType) {
      slimOauth.subscriptionType = oauth.subscriptionType;
    }
    if (typeof oauth.rateLimitTier === 'string' && oauth.rateLimitTier) {
      slimOauth.rateLimitTier = oauth.rateLimitTier;
    }
    // Compact JSON — no whitespace, no newlines (required for security -w).
    return JSON.stringify({ claudeAiOauth: slimOauth });
  } catch {
    return null;
  }
}

/** True when a keychain/vault blob carries a non-empty OAuth access token. */
export function claudeCredentialBlobIsUsable(blob: string | null | undefined): boolean {
  if (!blob) return false;
  return slimClaudeCredentialBlob(blob) !== null;
}

/** Read the active Claude credential blob from the login keychain, or null. */
export function readActiveClaudeCredential(): string | null {
  if (!isMac()) return null;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        // Explicit account operations may consult the Keychain, but a locked
        // or stale login session must not freeze Electron's main process.
        timeout: 5_000,
        killSignal: 'SIGKILL',
      },
    );
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null; // Not logged in / no keychain entry.
  }
}

/**
 * Read the native keychain and return the vault-safe slim OAuth slice only.
 * Fat MCP maps are never persisted into Nexus vaults.
 */
export function readActiveClaudeCredentialSlim(): string | null {
  const raw = readActiveClaudeCredential();
  if (!raw) return null;
  return slimClaudeCredentialBlob(raw);
}

function quoteSecurityInteractive(s: string): string {
  // Quoting for security's interactive parser: double-quoted, escaping \ and ".
  return `"${s.replace(/([\\"])/g, '\\$1')}"`;
}

function buildInteractiveAddCommand(slimBlob: string): string {
  const account = os.userInfo().username;
  return (
    `add-generic-password -U -s ${quoteSecurityInteractive(CLAUDE_KEYCHAIN_SERVICE)} ` +
    `-a ${quoteSecurityInteractive(account)} -w ${quoteSecurityInteractive(slimBlob)}\n`
  );
}

/**
 * Primary path: `security -i` with the full add-generic-password line on stdin
 * (secret never on argv). Only used when the command fits the line buffer.
 */
function writeViaInteractiveStdin(slimBlob: string): boolean {
  const cmd = buildInteractiveAddCommand(slimBlob);
  if (Buffer.byteLength(cmd, 'utf8') > CLAUDE_KEYCHAIN_INTERACTIVE_CMD_MAX_BYTES) {
    return false;
  }
  try {
    const res = spawnSync('security', ['-i'], {
      input: cmd,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Fallback: write secret to a mode-0600 temp file, then `security
 * add-generic-password -w "$(cat …)"` is avoided (shell expansion). Instead
 * we pass the password via `security add-generic-password … -w` reading from
 * a file with `-w` as the file contents path is NOT supported on all macOS
 * versions. We use: `security add-generic-password -U -s … -a … -w <blob>`
 * only when the slim blob is short enough that argv is acceptable for the
 * *fallback* path AND we already refused oversized interactive lines —
 * actually argv still shows in ps. Prefer:
 *
 *   security add-generic-password -U -s S -a A -w "$(cat file)"
 *
 * is shell. The safe portable fallback without shell is still spawn with
 * `-w` and the slim secret as argv when slim is small (always ~500B after
 * slim), which is the same surface the interactive path would have put on
 * the security tool's internal command buffer — still better than truncation.
 *
 * For true no-argv secret injection without interactive line limits we use
 * a mode-0600 temp file + `security` reading via stdin protocol alternative:
 * `add-generic-password` does not support @file. So the robust fallback is
 * file-backed: write slim to temp 0600, then run:
 *   security add-generic-password -U -s S -a A -w "$(cat FILE)"
 * through `/bin/bash -c` with the path embedded but secret only in the file
 * that bash cats — still briefly in bash memory, not in Nexus argv, not in a
 * truncated -i line.
 */
function writeViaTempFileFallback(slimBlob: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-cred-'));
  const file = path.join(dir, `blob-${randomBytes(8).toString('hex')}`);
  try {
    fs.writeFileSync(file, slimBlob, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(file, 0o600);
    const account = os.userInfo().username;
    // Secret lives only in the 0600 file; argv carries the path, not the blob.
    // Use execFileSync with bash so we never put the secret on Nexus argv.
    const script =
      `security add-generic-password -U ` +
      `-s ${JSON.stringify(CLAUDE_KEYCHAIN_SERVICE)} ` +
      `-a ${JSON.stringify(account)} ` +
      `-w "$(cat ${JSON.stringify(file)})"`;
    const res = spawnSync('/bin/bash', ['-c', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    return res.status === 0;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; never leave secrets if we can help it.
    }
  }
}

/**
 * Restore a saved credential blob into the active Claude keychain service.
 *
 * Always slims to `{ claudeAiOauth }` first (drops mcpOAuth). Primary path:
 * interactive `security -i` when the command fits. Fallback: mode-0600 temp
 * file + bash cat into `add-generic-password` (never a truncated -i line).
 * Failure returns false without claiming success.
 */
export function writeActiveClaudeCredential(blob: string): boolean {
  if (!isMac() || !blob) return false;
  if (blob.includes('\n') || blob.includes('\r')) {
    console.warn('[claude-credential] credential blob contains newline; refusing');
    return false;
  }
  const slim = slimClaudeCredentialBlob(blob);
  if (!slim) {
    console.warn('[claude-credential] blob has no usable claudeAiOauth.accessToken; refusing');
    return false;
  }
  if (slim.includes('\n') || slim.includes('\r')) {
    console.warn('[claude-credential] slim blob contains newline; refusing');
    return false;
  }

  if (writeViaInteractiveStdin(slim)) {
    return true;
  }

  // Interactive path refused (oversized line or security status != 0).
  // Fallback must not truncate — full slim secret via temp file.
  const ok = writeViaTempFileFallback(slim);
  if (!ok) {
    console.warn('[claude-credential] failed to restore credential (interactive + fallback)');
  }
  return ok;
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
