import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';

/**
 * Secret key vault. API keys are encrypted with Electron safeStorage (backed
 * by the macOS Keychain) and written as opaque base64 blobs to
 * ~/.nexus/secrets.enc — NEVER as plaintext, NEVER in versioned config.
 *
 * This supersedes Overclock's OC1-v10 home-rolled crypto (which broke twice
 * and leaked a JWT in plaintext — see docs/ARCHITECTURE.md §E.6). If
 * safeStorage is unavailable we refuse to store rather than degrade to
 * plaintext; the value simply lives only for the process lifetime.
 */

const SECRETS_FILE = path.join(os.homedir(), '.nexus', 'secrets.enc');

// adapterId → decrypted key (in-memory cache; the disk copy is encrypted).
let cache: Map<string, string> | null = null;

export function isSecureStorageAvailable(): boolean {
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

function persist(): void {
  if (!isSecureStorageAvailable() || !cache) return;
  const out: Record<string, string> = {};
  for (const [adapterId, plain] of cache) {
    try {
      out[adapterId] = safeStorage.encryptString(plain).toString('base64');
    } catch {
      // Skip values that fail to encrypt rather than write plaintext.
    }
  }
  try {
    fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(out), { mode: 0o600 });
  } catch (err) {
    console.warn('[secrets] failed to persist encrypted secrets:', err);
  }
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
    persist();
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
  persist();
  return { ok: true };
}

/** Test-only reset. */
export function resetSecretsCacheForTests(): void {
  cache = null;
}
