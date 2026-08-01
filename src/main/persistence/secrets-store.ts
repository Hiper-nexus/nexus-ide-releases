import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { safeStorage } from 'electron';
import { isCurrentProcessSmokeTest } from '../smoke-core';
import { isCurrentProcessRealMissionE2E } from '../../shared/real-mission-e2e';

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

// adapterId → decrypted key (in-memory cache; the disk copy is encrypted).
let cache: Map<string, string> | null = null;
let temporaryFileSequence = 0;
/**
 * The packaged release mission runs with an isolated HOME and deliberately
 * does not touch the operator's login Keychain. Agent identity still needs a
 * private-key vault for the lifetime of that one process, so keep that narrow
 * harness-only material in memory. This branch is never used by the normal
 * app path and nothing from it is written to disk.
 */
const realMissionE2EVolatileSecrets = new Map<string, string>();

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
 * Dev-only escape hatch for unattended sessions: the dev Electron binary is
 * not the signature the Keychain ACL trusts, so ANY vault access raises a
 * synchronous SecurityAgent prompt that freezes the main thread (and CDP)
 * until a human types the login password. With the vault disabled, reads
 * fail closed (null) and writes stay in-memory — CLIs keep their own native
 * auth. Never honored in a packaged build.
 */
function isDevVaultDisabled(): boolean {
  // Release gate: the packaged e2e process must NEVER touch the Keychain.
  // With the login keychain auto-locked (unattended machine overnight), the
  // vault's first SecItemAdd blocks the ENTIRE main thread in a synchronous
  // makeLoginAuthUI XPC wait — scheduler timers die and merge never runs.
  // The gate's CLIs authenticate natively; the vault adds nothing there.
  if (isCurrentProcessRealMissionE2E()) return true;
  return (
    process.env.NEXUS_DEV_NO_VAULT === '1' &&
    process.defaultApp !== undefined
  );
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
 * vault at once on boot/getInfo.
 */
function decryptBlob(blob: string): string | null {
  if (isDevVaultDisabled()) return null;
  try {
    const plain = safeStorage.decryptString(Buffer.from(blob, 'base64'));
    return plain || null;
  } catch {
    return null;
  }
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
 * Persist ONE key's change by merging over the CURRENT disk contents (raw
 * blobs, no decryption), then writing atomically (tmp + rename).
 *
 * Never dump the in-memory cache wholesale: with two app instances alive
 * (dev restarts!), the stale one would rewrite the file without keys the
 * newer one saved — that bug silently ate stored API keys. Merging at the
 * raw level also preserves entries this instance cannot decrypt.
 */
function persistDelta(key: string, plainValue: string | null): SecretWriteResult {
  if (!isSecureStorageAvailable()) {
    return { ok: false, error: SECURE_STORAGE_ERROR };
  }
  try {
    withVaultLock(() => {
      const raw = readRawFromDisk();
      if (plainValue === null) {
        delete raw[key];
      } else {
        raw[key] = safeStorage.encryptString(plainValue).toString('base64');
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
  if (isCurrentProcessRealMissionE2E()) {
    return realMissionE2EVolatileSecrets.get(key) ?? null;
  }
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
  const plain = decryptBlob(blob);
  if (plain) store.set(key, plain);
  return plain;
}

/**
 * Presence only — reads the encrypted vault index without Keychain decrypt.
 * Boot/getInfo must use this so SecItemCopyMatching never blocks the UI/mic.
 */
export function hasSecret(key: string): boolean {
  if (isCurrentProcessRealMissionE2E()) {
    return realMissionE2EVolatileSecrets.has(key);
  }
  if (ensureCache().has(key)) return true;
  try {
    const raw = readRawFromDisk();
    return Object.prototype.hasOwnProperty.call(raw, key);
  } catch {
    return false;
  }
}

/**
 * Cache-only lookup. Unlike `hasSecret`/`getSecret`, this never touches disk or
 * macOS Keychain and is therefore safe on the Electron boot path.
 */
export function hasCachedSecret(key: string): boolean {
  return cache?.has(key) ?? false;
}

export function setSecret(key: string, value: string): SecretWriteResult {
  if (isCurrentProcessRealMissionE2E()) {
    if (value === '') {
      realMissionE2EVolatileSecrets.delete(key);
      cache?.delete(key);
    } else {
      realMissionE2EVolatileSecrets.set(key, value);
      ensureCache().set(key, value);
    }
    return { ok: true };
  }
  const store = ensureCache();
  if (value === '') return deleteSecret(key);
  if (!isSecureStorageAvailable()) {
    return { ok: false, error: SECURE_STORAGE_ERROR };
  }
  const result = persistDelta(key, value);
  if (!result.ok) return result;
  store.set(key, value);
  return { ok: true };
}

export function deleteSecret(key: string): SecretWriteResult {
  if (isCurrentProcessRealMissionE2E()) {
    realMissionE2EVolatileSecrets.delete(key);
    cache?.delete(key);
    return { ok: true };
  }
  const store = ensureCache();
  const result = persistDelta(key, null);
  if (!result.ok) return result;
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
  realMissionE2EVolatileSecrets.clear();
}
