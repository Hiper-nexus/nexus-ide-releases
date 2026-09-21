import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

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
  clientId?: string;
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
    if (typeof oauth.clientId === 'string' && oauth.clientId) slimOauth.clientId = oauth.clientId;
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

/**
 * Identidade opaca e VOLÁTIL da sessão Claude que está no Keychain agora.
 *
 * O login pode reautenticar a mesma conta (mesmo e-mail) e ainda assim
 * substituir toda a linhagem OAuth. A UI precisa distinguir "não fez nada"
 * de "a credencial rodou", mas nunca pode receber token, refresh token ou
 * subject. O digest atende exatamente esse contrato: só igualdade.
 *
 * Não persista nem registre este valor. Ele muda quando a CLI rotaciona a
 * credencial e existe somente para comparar o baseline do terminal de login
 * com a leitura posterior.
 */
export function claudeCredentialFingerprint(
  blob: string | null | undefined,
): string | null {
  const slim = blob ? slimClaudeCredentialBlob(blob) : null;
  if (!slim) return null;
  return createHash('sha256')
    .update('claude-session\0')
    .update(slim)
    .digest('hex');
}

/** Read the active Claude credential blob from the login keychain, or null. */
export function readActiveClaudeCredential(): string | null {
  return readClaudeCredential(CLAUDE_KEYCHAIN_SERVICE);
}

/**
 * Leitura do Keychain é CARA e VISÍVEL: `find-generic-password -w` devolve o
 * segredo, então passa pela ACL do item e pode levantar o diálogo de
 * autorização do macOS. As mesmas chamadas acontecem em caminhos quentes
 * (snapshot de cota, preparo de spawn, sondas de auth), e uma negação era
 * lida como «não logado» — o que dispara novo login, que lê de novo. Era esse
 * laço que deixava o Mac pedindo autorização o tempo todo sem nunca logar.
 *
 * A janela é curta de propósito: o CLI rotaciona o token por fora, e toda
 * escrita nossa invalida a entrada na hora.
 */
const CREDENTIAL_READ_TTL_MS = 15_000;
/** Negado/bloqueado: recua bem mais para não reabrir o diálogo em loop. */
const CREDENTIAL_DENIED_BACKOFF_MS = 5 * 60_000;

const credentialReadCache = new Map<string, { blob: string | null; until: number }>();

function rememberCredentialRead(
  service: string,
  blob: string | null,
  ttlMs: number,
): void {
  credentialReadCache.set(service, { blob, until: Date.now() + ttlMs });
}

/**
 * Esquece a leitura memoizada. Obrigatório depois de escrever no item — sem
 * isto, uma troca de conta continuaria servindo o blob anterior por até
 * {@link CREDENTIAL_READ_TTL_MS}. Sem argumento, limpa tudo (troca de conta,
 * logout, testes).
 */
export function invalidateClaudeCredentialCache(service?: string): void {
  if (service === undefined) credentialReadCache.clear();
  else credentialReadCache.delete(service);
}

/** Claude 2.1.278 derives this namespace from CLAUDE_SECURESTORAGE_CONFIG_DIR. */
export function managedClaudeKeychainService(authDir: string): string {
  if (!path.isAbsolute(authDir) || /[\x00-\x1f]/.test(authDir)) {
    throw new Error('managed Claude auth directory must be an absolute path');
  }
  return `${CLAUDE_KEYCHAIN_SERVICE}-${createHash('sha256').update(authDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

export function readManagedClaudeCredential(authDir: string): string | null {
  return readClaudeCredential(managedClaudeKeychainService(authDir));
}

export function deleteManagedClaudeCredential(authDir: string): boolean {
  const service = managedClaudeKeychainService(authDir);
  invalidateClaudeCredentialCache(service);
  if (!isMac()) return true;
  try {
    execFileSync('security', ['delete-generic-password', '-s', service], {
      stdio: ['ignore', 'ignore', 'ignore'], timeout: 2_000, killSignal: 'SIGKILL',
    });
    return true;
  } catch (error) {
    return (error as { status?: number }).status === 44;
  }
}

function readClaudeCredential(service: string): string | null {
  if (!isMac()) return null;
  const held = credentialReadCache.get(service);
  if (held && Date.now() < held.until) return held.blob;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
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
    const blob = trimmed.length > 0 ? trimmed : null;
    rememberCredentialRead(service, blob, CREDENTIAL_READ_TTL_MS);
    return blob;
  } catch (error) {
    // Código 44 = item inexistente: resposta barata e definitiva, e o macOS
    // nem chega a pedir autorização. Qualquer outro código é o SecurityAgent
    // negado, keychain bloqueado ou timeout — ali houve (ou haveria) um
    // diálogo. Repetir a leitura a cada snapshot é o que vira a enxurrada de
    // prompts que nunca termina em login, então esse caso recua por mais
    // tempo. Nos dois casos o retorno segue `null`: este módulo continua sem
    // afirmar sessão que não leu.
    const absent = (error as { status?: number }).status === 44;
    rememberCredentialRead(
      service,
      null,
      absent ? CREDENTIAL_READ_TTL_MS : CREDENTIAL_DENIED_BACKOFF_MS,
    );
    return null;
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

function buildInteractiveAddCommand(slimBlob: string, service = CLAUDE_KEYCHAIN_SERVICE): string {
  const account = os.userInfo().username;
  return (
    `add-generic-password -U -s ${quoteSecurityInteractive(service)} ` +
    `-a ${quoteSecurityInteractive(account)} -w ${quoteSecurityInteractive(slimBlob)}\n`
  );
}

/**
 * Primary path: `security -i` with the full add-generic-password line on stdin
 * (secret never on argv). Only used when the command fits the line buffer.
 */
function writeViaInteractiveStdin(slimBlob: string, service = CLAUDE_KEYCHAIN_SERVICE): boolean {
  const cmd = buildInteractiveAddCommand(slimBlob, service);
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
 * Restore a saved credential blob into the active Claude keychain service.
 *
 * Always slims to `{ claudeAiOauth }` first (drops mcpOAuth). Primary path:
 * interactive `security -i` when the command fits. Never retry through a
 * shell or expose credentials in child-process arguments.
 * Failure returns false without claiming success.
 */
export function writeActiveClaudeCredential(blob: string): boolean {
  return writeClaudeCredential(blob, CLAUDE_KEYCHAIN_SERVICE);
}

/** Managed profiles never fall back to a secret-bearing argv or the native item. */
export function writeManagedClaudeCredential(authDir: string, blob: string): boolean {
  return writeClaudeCredential(blob, managedClaudeKeychainService(authDir));
}

function writeClaudeCredential(blob: string, service: string): boolean {
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

  // O item MUDA a partir daqui (inclusive quando a escrita falha no meio):
  // a leitura memoizada não pode sobreviver a isso, senão uma troca de conta
  // continuaria servindo a credencial anterior.
  invalidateClaudeCredentialCache(service);

  const ok = writeViaInteractiveStdin(slim, service);
  if (!ok) console.warn('[claude-credential] bounded Keychain write failed');
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
