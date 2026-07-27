import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

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

/** Restore a saved credential blob into the active Claude keychain service.
 *
 * M3 mitigation: the secret is NEVER passed via argv (visible in `ps auxww`).
 * We drive `security` in interactive mode (`-i`), feeding the whole
 * `add-generic-password` command through STDIN — stdin is not enumerable by
 * other users, unlike argv. No temp file touches the filesystem either.
 * The interactive parser is line-oriented, so a blob containing a newline would
 * be malformed for `-w` storage; we refuse it rather than silently corrupt
 * (the old `$(cat …)` approach also stripped trailing newlines via command
 * substitution — a silent-corruption bug this version eliminates).
 */
export function writeActiveClaudeCredential(blob: string): boolean {
  if (!isMac() || !blob) return false;
  if (blob.includes('\n') || blob.includes('\r')) {
    console.warn('[claude-credential] credential blob contains newline; refusing');
    return false;
  }
  // Quoting for security's interactive parser: double-quoted, escaping \ and ".
  const q = (s: string) => `"${s.replace(/([\\"])/g, '\\$1')}"`;
  const cmd = `add-generic-password -U -s ${q(CLAUDE_KEYCHAIN_SERVICE)} -a ${q(os.userInfo().username)} -w ${q(blob)}\n`;
  // O parser interativo do `security` lê a linha num buffer fixo (~4 KiB). Uma
  // linha maior é DIVIDIDA: a primeira metade EXECUTA `add-generic-password -U`
  // com o blob TRUNCADO (sobrescrevendo a credencial viva) e o resto vira um
  // comando inválido que faz o `security` sair com erro — ou seja, a função
  // retornaria false mas o login real já teria sido corrompido. Recusa acima do
  // limite seguro (blobs Claude atuais ficam bem abaixo de 2 KiB).
  if (Buffer.byteLength(cmd, 'utf8') > 3500) {
    console.warn('[claude-credential] credential blob too large for security -i; refusing');
    return false;
  }
  try {
    const res = spawnSync('security', ['-i'], {
      input: cmd,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    if (res.status !== 0) {
      console.warn('[claude-credential] failed to restore credential (status %d)', res.status);
      return false;
    }
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
