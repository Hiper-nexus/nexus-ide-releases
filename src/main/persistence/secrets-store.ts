import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import { shouldAccessSecureStorage } from '../smoke-core';

/**
 * Secret key vault. API keys are encrypted with Electron safeStorage (backed
 * by the macOS Keychain) and written as opaque base64 blobs to
 * ~/.nexus/secrets.enc — NEVER as plaintext, NEVER in versioned config.
 *
 * This supersedes an earlier home-rolled crypto scheme (which broke twice
 * and leaked a JWT in plaintext — see docs/ARCHITECTURE.md §E.6). If
 * safeStorage is unavailable we refuse to store rather than degrade to
 * plaintext; the value simply lives only for the process lifetime.
 */

const SECRETS_FILE = path.join(os.homedir(), '.nexus', 'secrets.enc');

// adapterId → decrypted key (in-memory cache; the disk copy is encrypted).
let cache: Map<string, string> | null = null;

export function isSecureStorageAvailable(): boolean {
  if (!shouldAccessSecureStorage(process.argv)) return false;
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function loadFromDisk(): Map<string, string> {
  const out = new Map<string, string>();
  if (!isSecureStorageAvailable()) return out;
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    return out;
  }
  for (const [adapterId, blob] of Object.entries(raw)) {
    try {
      const plain = safeStorage.decryptString(Buffer.from(blob, 'base64'));
      if (plain) out.set(adapterId, plain);
    } catch {
      // Undecryptable (e.g. keychain reset) — skip; user can re-enter.
    }
  }
  return out;
}

function ensureCache(): Map<string, string> {
  if (!cache) cache = loadFromDisk();
  return cache;
}

/** Raw (still-encrypted) disk map — used to merge writes without decrypting. */
function readRawFromDisk(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
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
function persistDelta(key: string, plainValue: string | null): void {
  if (!isSecureStorageAvailable()) return;
  const raw = readRawFromDisk();
  if (plainValue === null) {
    delete raw[key];
  } else {
    try {
      raw[key] = safeStorage.encryptString(plainValue).toString('base64');
    } catch (err) {
      console.warn('[secrets] failed to encrypt value:', err);
      return;
    }
  }
  try {
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
    const tmp = `${SECRETS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw), { mode: 0o600 });
    fs.renameSync(tmp, SECRETS_FILE);
  } catch (err) {
    console.warn('[secrets] failed to persist encrypted secrets:', err);
  }
}

// ── Generic secret vault (arbitrary keys) ───────────────────────────────────
// Used for per-account secrets: `acctkey:<id>` (api keys) and
// `acctcred:<id>` (Claude subscription credential blobs). Same encrypted file.

export function getSecret(key: string): string | null {
  return ensureCache().get(key) ?? null;
}

export function hasSecret(key: string): boolean {
  return ensureCache().has(key);
}

export function setSecret(key: string, value: string): { ok: boolean; error?: string } {
  const store = ensureCache();
  if (value === '') {
    store.delete(key);
    persistDelta(key, null);
    return { ok: true };
  }
  if (!isSecureStorageAvailable()) {
    return {
      ok: false,
      error:
        'OS secure storage (Keychain) unavailable — refusing to store in ' +
        'plaintext. Kept for this session only.',
    };
  }
  store.set(key, value);
  persistDelta(key, value);
  return { ok: true };
}

export function deleteSecret(key: string): void {
  ensureCache().delete(key);
  persistDelta(key, null);
}

export function hasKey(adapterId: string): boolean {
  return ensureCache().has(adapterId);
}

export function getKey(adapterId: string): string | null {
  return ensureCache().get(adapterId) ?? null;
}

/** Masked preview for the UI — never returns the raw key. */
export function maskedKey(adapterId: string): string | null {
  const key = getKey(adapterId);
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Store (or clear, when key === '') a provider's API key. */
export function setKey(adapterId: string, key: string): { ok: boolean; error?: string } {
  const store = ensureCache();
  if (key === '') {
    store.delete(adapterId);
    persistDelta(adapterId, null);
    return { ok: true };
  }
  if (!isSecureStorageAvailable()) {
    return {
      ok: false,
      error:
        'OS secure storage (Keychain) is unavailable — refusing to store the ' +
        'key in plaintext. It will be kept only for this session.',
    };
  }
  store.set(adapterId, key);
  persistDelta(adapterId, key);
  return { ok: true };
}

/** Test-only reset. */
export function resetSecretsCacheForTests(): void {
  cache = null;
}
