import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { safeStorage } from 'electron';
import { isCurrentProcessSmokeTest } from '../smoke-core';

/**
 * Secret key vault. API keys are encrypted with Electron safeStorage (backed
 * by the macOS Keychain) and written as opaque base64 blobs to
 * ~/.nexus/secrets.enc — NEVER as plaintext, NEVER in versioned config.
 *
 * This supersedes an earlier home-rolled crypto scheme (which broke twice
 * and leaked a JWT in plaintext — see docs/ARCHITECTURE.md §E.6). If
 * safeStorage is unavailable (or Linux selected the weak `basic_text`
 * backend), we refuse the operation rather than degrade to plaintext.
 */

const SECRETS_FILE = path.join(os.homedir(), '.nexus', 'secrets.enc');
const SECURE_STORAGE_ERROR =
  'OS secure storage is unavailable; secret was not persisted.';
const SECRET_PERSISTENCE_ERROR =
  'Encrypted secret could not be published durably.';
const SECRETS_LOCK_DATABASE = `${SECRETS_FILE}.lock.sqlite`;
const LOCK_ACQUIRE_TIMEOUT_MS = 500;
/**
 * Uma falha do safeStorage é o suficiente. `encryptString`/`isEncryptionAvailable`
 * são SecItemAdd/SecItemCopyMatching e levantam o modal macOS "Chaves Não
 * Encontradas / Reajustar Para Padrões" (esse botão apaga o keychain inteiro).
 * Com backoff curto o modal voltava a cada janela — o operador via o diálogo
 * várias vezes por sessão. Depois da PRIMEIRA falha o vault fica envenenado
 * pela vida do processo: nenhuma chamada nova ao Keychain, fail-closed.
 */
const SECURE_STORAGE_FAILURE_BACKOFF_MS = 5 * 60_000;

// adapterId → decrypted key (in-memory cache; the disk copy is encrypted).
let cache: Map<string, string> | null = null;
/**
 * Per-key decrypt denial (Keychain locked, ACL refused, vault from another
 * machine/user). Presence in the raw index is NOT the same as readable:
 * `hasSecret` stays true while `getSecret` returns null during the backoff.
 */
const decryptDeniedUntil = new Map<string, number>();
/**
 * Veneno de SESSÃO: a primeira falha do safeStorage (SecItemAdd/SecItemCopyMatching)
 * desliga o vault para o resto do processo. Sem isto o modal "Chaves Não
 * Encontradas" voltava a cada janela de backoff durante o uso normal.
 */
let secureStoragePoisoned = false;
let temporaryFileSequence = 0;
export interface SecretWriteResult {
  ok: boolean;
  error?: string;
}

export function isSecureStorageBackendAllowed(
  platform: NodeJS.Platform,
  readBackend: () => string,
): boolean {
  return platform !== 'linux' || readBackend() !== 'basic_text';
}

/**
 * Dev-only fail-closed doctrine (F-105, campo 21/08): o binário de dev NÃO é
 * a assinatura que o ACL do Keychain confia — QUALQUER acesso ao vault pode
 * abrir um prompt síncrono do SecurityAgent que congela o main do Electron
 * (SecItemCopyMatching sem timeout; main, gate HTTP, supervisor e CDP morrem
 * juntos). Em dev o vault fica DESLIGADO por padrão: leituras falham fechado
 * (null), writes ficam em memória — os CLIs usam auth nativa de qualquer
 * forma. Opt-in explícito: NEXUS_DEV_VAULT=1. Kill-switch extra:
 * NEXUS_DEV_NO_VAULT=1 vale até em sessão empacotada de teste. Nunca afeta
 * build empacotada real.
 */
function isDevVaultDisabled(): boolean {
  if (process.env.NEXUS_DEV_NO_VAULT === '1') return true;
  const isDevCliSession = process.defaultApp !== undefined;
  return isDevCliSession && process.env.NEXUS_DEV_VAULT !== '1';
}

export function isSecureStorageAvailable(options?: { probe?: boolean }): boolean {
  if (isCurrentProcessSmokeTest()) return false;
  if (isDevVaultDisabled()) return false;
  // Do not synchronously probe the macOS Keychain during app startup. On a
  // locked/stale login session `safeStorage.isEncryptionAvailable()` enters
  // SecItemCopyMatching and can block Electron's main thread indefinitely,
  // preventing AppKit from presenting the already-created window. macOS
  // safeStorage is the only supported backend here; actual encrypt/decrypt
  // calls remain guarded and fail closed when the user uses the vault.
  if (process.platform === 'darwin' && options?.probe === false) return true;
  try {
    return (
      safeStorage.isEncryptionAvailable() &&
      isSecureStorageBackendAllowed(process.platform, () =>
        safeStorage.getSelectedStorageBackend(),
      )
    );
  } catch {
    return false;
  }
}

/**
 * Decrypt one blob. Keychain (SecItemCopyMatching) can block for a long time
 * when the agent launches without an unlocked session — never decrypt the whole
 * vault at once on boot/getInfo. A failure is memoized per key: retrying the
 * hop is what re-opens the SecurityAgent dialog in a loop.
 */
function decryptBlob(key: string, blob: string): string | null {
  if (isDevVaultDisabled()) return null;
  const deniedUntil = decryptDeniedUntil.get(key);
  if (deniedUntil !== undefined && Date.now() < deniedUntil) return null;
  try {
    const plain = safeStorage.decryptString(Buffer.from(blob, 'base64'));
    decryptDeniedUntil.delete(key);
    return plain || null;
  } catch {
    // Keychain/safeStorage failures stay inside the vault: callers see null,
    // never an Electron throw and never the macOS Keychain dialog as UX.
    decryptDeniedUntil.set(key, Date.now() + SECURE_STORAGE_FAILURE_BACKOFF_MS);
    return null;
  }
}

/** True when the key is in the raw index but decrypt is currently denied. */
export function isSecretDecryptDenied(key: string): boolean {
  const deniedUntil = decryptDeniedUntil.get(key);
  return deniedUntil !== undefined && Date.now() < deniedUntil;
}

function ensureCache(): Map<string, string> {
  if (!cache) cache = new Map();
  return cache;
}

/** Raw (still-encrypted) disk map — used to merge writes without decrypting. */
function readRawFromDisk(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid encrypted vault');
    }
    const entries = Object.entries(parsed);
    if (!entries.every(([, value]) => typeof value === 'string')) {
      throw new Error('invalid encrypted vault entry');
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const directoryFd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function acquireVaultLock(): Database.Database {
  const directory = path.dirname(SECRETS_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  let lock: Database.Database | null = null;
  try {
    lock = new Database(SECRETS_LOCK_DATABASE, {
      timeout: LOCK_ACQUIRE_TIMEOUT_MS,
    });
    fs.chmodSync(SECRETS_LOCK_DATABASE, 0o600);
    lock.pragma(`busy_timeout = ${LOCK_ACQUIRE_TIMEOUT_MS}`);
    lock.exec('BEGIN EXCLUSIVE');
    return lock;
  } catch (error) {
    lock?.close();
    throw error;
  }
}

function withVaultLock<T>(operation: () => T): T {
  const lock = acquireVaultLock();
  let isCommitted = false;
  try {
    const result = operation();
    lock.exec('COMMIT');
    isCommitted = true;
    return result;
  } catch (error) {
    try {
      if (lock.inTransaction) lock.exec('ROLLBACK');
    } catch {
      // Preserve the authoritative vault operation failure.
    }
    throw error;
  } finally {
    try {
      lock.close();
    } catch (error) {
      if (!isCommitted) throw error;
      // COMMIT already released the interprocess lock durably.
    }
  }
}

function restoreVaultAfterPublishFailure(
  backupFile: string,
  hadPreviousVault: boolean,
  directory: string,
): void {
  if (hadPreviousVault) {
    fs.renameSync(backupFile, SECRETS_FILE);
  } else {
    removeFile(SECRETS_FILE);
  }
  syncDirectory(directory);
}

function publishEncryptedVault(raw: Readonly<Record<string, string>>): void {
  const directory = path.dirname(SECRETS_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const sequence = ++temporaryFileSequence;
  const temporaryFile = `${SECRETS_FILE}.tmp-${process.pid}-${sequence}`;
  const backupFile = `${SECRETS_FILE}.bak-${process.pid}-${sequence}`;
  const hadPreviousVault = fs.existsSync(SECRETS_FILE);
  let fileFd: number | null = null;
  let published = false;
  try {
    fileFd = fs.openSync(temporaryFile, 'wx', 0o600);
    fs.writeFileSync(fileFd, JSON.stringify(raw), 'utf8');
    fs.fchmodSync(fileFd, 0o600);
    fs.fsyncSync(fileFd);
    fs.closeSync(fileFd);
    fileFd = null;
    if (hadPreviousVault) {
      fs.copyFileSync(SECRETS_FILE, backupFile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backupFile, 0o600);
      syncFile(backupFile);
    }
    fs.renameSync(temporaryFile, SECRETS_FILE);
    published = true;
    try {
      syncDirectory(directory);
    } catch (error) {
      restoreVaultAfterPublishFailure(
        backupFile,
        hadPreviousVault,
        directory,
      );
      published = false;
      throw error;
    }
    // The target rename is durable. Backup deletion is cleanup only; an old
    // encrypted backup is never read and is removed again on the next write.
    removeFile(backupFile);
    try {
      syncDirectory(directory);
    } catch {
      // The published target was already synced above.
    }
  } catch (error) {
    if (fileFd !== null) {
      try {
        fs.closeSync(fileFd);
      } catch {
        // The original persistence failure remains authoritative.
      }
    }
    removeFile(temporaryFile);
    if (!published) removeFile(backupFile);
    throw error;
  }
}

/**
 * Cipher one plaintext. Never throws and never calls encryptString unless the
 * OS backend already reports it is available — encryptString is the Keychain
 * SecItemAdd that surfaces macOS "Chaves Não Encontradas / Reajustar Para
 * Padrões" (that button wipes the default keychain).
 *
 * ponytail: Electron 43 exposes encryptStringAsync (non-blocking), but the
 * vault contract is sync (`SecretWriteResult`). Ceiling: the first Keychain
 * hop can still block the main thread. Upgrade: async vault API that calls
 * encryptStringAsync once callers can move.
 */
function encryptSecret(
  plainValue: string,
): { ok: true; blob: string } | { ok: false; error: string } {
  // Veneno de sessão: uma falha e o Keychain nunca mais é tocado — é o que
  // levanta o modal "Chaves Não Encontradas / Reajustar Para Padrões".
  if (secureStoragePoisoned) {
    return { ok: false, error: SECURE_STORAGE_ERROR };
  }
  // Single availability probe: isEncryptionAvailable() already hops the
  // Keychain; calling it twice before encryptString just doubles the chance
  // of a SecurityAgent prompt on a locked session.
  if (!isSecureStorageAvailable()) {
    secureStoragePoisoned = true;
    return { ok: false, error: SECURE_STORAGE_ERROR };
  }
  try {
    const blob = safeStorage.encryptString(plainValue).toString('base64');
    if (!blob) {
      secureStoragePoisoned = true;
      return { ok: false, error: SECURE_STORAGE_ERROR };
    }
    return { ok: true, blob };
  } catch {
    // SecItemAdd levantou (ou levantaria) "Chaves Não Encontradas". Nunca mais
    // tenta: o próximo setSecret de qualquer chave não reabre o diálogo.
    secureStoragePoisoned = true;
    return { ok: false, error: SECURE_STORAGE_ERROR };
  }
}

/**
 * Persist ONE key's change by merging over the CURRENT disk contents (raw
 * blobs, no decryption), then writing atomically (tmp + rename).
 *
 * Never dump the in-memory cache wholesale: with two app instances alive
 * (dev restarts!), the stale one would rewrite the file without keys the
 * newer one saved — that bug silently ate stored API keys. Merging at the
 * raw level also preserves entries this instance cannot decrypt.
 *
 * Cipher happens before the exclusive vault lock so a blocked Keychain hop
 * does not also pin the lock file.
 */
function persistDelta(key: string, plainValue: string | null): SecretWriteResult {
  let blobToStore: string | null;
  if (plainValue === null) {
    if (!isSecureStorageAvailable()) {
      return { ok: false, error: SECURE_STORAGE_ERROR };
    }
    blobToStore = null;
  } else {
    const encrypted = encryptSecret(plainValue);
    if (!encrypted.ok) return encrypted;
    blobToStore = encrypted.blob;
  }
  try {
    withVaultLock(() => {
      const raw = readRawFromDisk();
      if (blobToStore === null) {
        delete raw[key];
      } else {
        raw[key] = blobToStore;
      }
      publishEncryptedVault(raw);
    });
    return { ok: true };
  } catch {
    return { ok: false, error: SECRET_PERSISTENCE_ERROR };
  }
}

// ── Generic secret vault (arbitrary keys) ───────────────────────────────────
// Used for per-account secrets: `acctkey:<id>` (api keys) and
// `acctcred:<id>` (Claude subscription credential blobs). Same encrypted file.

export function getSecret(key: string): string | null {
  const store = ensureCache();
  if (store.has(key)) return store.get(key) ?? null;
  if (!isSecureStorageAvailable()) return null;
  let raw: Record<string, string>;
  try {
    raw = readRawFromDisk();
  } catch {
    return null;
  }
  const blob = raw[key];
  if (typeof blob !== 'string') return null;
  const plain = decryptBlob(key, blob);
  if (plain) store.set(key, plain);
  return plain;
}

/**
 * Presence only — reads the encrypted vault index without Keychain decrypt.
 * Boot/getInfo must use this so SecItemCopyMatching never blocks the UI/mic.
 */
export function hasSecret(key: string): boolean {
  if (ensureCache().has(key)) return true;
  try {
    const raw = readRawFromDisk();
    return Object.prototype.hasOwnProperty.call(raw, key);
  } catch {
    return false;
  }
}

/** Raw index keys only — never decrypts. Used by the multi-PC export walker. */
export function listSecretKeys(): string[] {
  try {
    return Object.keys(readRawFromDisk());
  } catch {
    return [];
  }
}

export type VaultState = 'empty' | 'readable' | 'foreign-or-locked' | 'partial';

/**
 * Saúde do cofre para a UI multi-PC. `safeStorage` amarra a cifra ao keychain
 * da máquina: um `secrets.enc` copiado de outro Mac tem o índice íntegro mas
 * nenhum blob legível — a UI deve dizer "vault de outra máquina", não "redefina
 * a chave". Sonda com o mesmo backoff do decrypt: nunca abre o SecurityAgent
 * em loop para responder um booleano.
 */
export function vaultState(): VaultState {
  const keys = listSecretKeys();
  if (keys.length === 0) return 'empty';
  let readable = 0;
  let denied = 0;
  for (const key of keys) {
    if (cache?.has(key)) {
      readable += 1;
      continue;
    }
    if (isSecretDecryptDenied(key)) {
      denied += 1;
      continue;
    }
    if (getSecret(key) !== null) readable += 1;
    else if (isSecretDecryptDenied(key)) denied += 1;
  }
  if (readable > 0 && denied > 0) return 'partial';
  if (readable > 0) return 'readable';
  if (denied > 0) return 'foreign-or-locked';
  return 'empty';
}

/**
 * Cache-only lookup. Unlike `hasSecret`/`getSecret`, this never touches disk or
 * macOS Keychain and is therefore safe on the Electron boot path.
 */
export function hasCachedSecret(key: string): boolean {
  return cache?.has(key) ?? false;
}

export function setSecret(key: string, value: string): SecretWriteResult {
  const store = ensureCache();
  if (value === '') return deleteSecret(key);
  if (!isSecureStorageAvailable()) {
    return { ok: false, error: SECURE_STORAGE_ERROR };
  }
  const result = persistDelta(key, value);
  if (!result.ok) return result;
  decryptDeniedUntil.delete(key);
  store.set(key, value);
  return { ok: true };
}

export function deleteSecret(key: string): SecretWriteResult {
  const store = ensureCache();
  const result = persistDelta(key, null);
  if (!result.ok) return result;
  decryptDeniedUntil.delete(key);
  store.delete(key);
  return { ok: true };
}

export function hasKey(adapterId: string): boolean {
  return hasSecret(adapterId);
}

export function getKey(adapterId: string): string | null {
  return getSecret(adapterId);
}

/** Masked preview for the UI — never returns the raw key. */
export function maskedKey(adapterId: string): string | null {
  const key = getKey(adapterId);
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Store (or clear, when key === '') a provider's API key. */
export function setKey(adapterId: string, key: string): SecretWriteResult {
  const store = ensureCache();
  if (key === '') return deleteSecret(adapterId);
  if (!isSecureStorageAvailable()) {
    return { ok: false, error: SECURE_STORAGE_ERROR };
  }
  const result = persistDelta(adapterId, key);
  if (!result.ok) return result;
  store.set(adapterId, key);
  return { ok: true };
}

/** Test-only reset. */
export function resetSecretsCacheForTests(): void {
  cache = null;
  decryptDeniedUntil.clear();
  secureStoragePoisoned = false;
}
