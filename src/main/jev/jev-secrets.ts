import {
  getSecret,
  hasSecret,
  isSecureStorageAvailable,
  setSecret,
} from '../persistence/secrets-store';
import { JEV_ENV_VAR } from '../../shared/jev-ipc';

const JEV_SECRET_PREFIX = 'jev-env:';

function jevSecretKey(): string {
  return `${JEV_SECRET_PREFIX}${JEV_ENV_VAR}`;
}

export function getJevApiKey(): string | null {
  return getSecret(jevSecretKey());
}

export function resolveJevApiKey(): string | undefined {
  const stored = getJevApiKey()?.trim();
  if (stored) return stored;
  const inherited = process.env[JEV_ENV_VAR]?.trim();
  return inherited || undefined;
}

/** Presence via vault only — hasSecret, never decrypt (boot/status paths). */
export function hasStoredJevApiKey(): boolean {
  return hasSecret(jevSecretKey());
}

export function hasJevCredential(): boolean {
  if (hasStoredJevApiKey()) return true;
  return Boolean(process.env[JEV_ENV_VAR]?.trim());
}

/** De onde a key resolveu — PRESENÇA apenas, nunca o valor. */
export type JevApiKeySource = 'stored' | 'env' | 'missing';

export function jevApiKeySource(): JevApiKeySource {
  if (hasStoredJevApiKey()) return 'stored';
  if (process.env[JEV_ENV_VAR]?.trim()) return 'env';
  return 'missing';
}

export function maskedJevApiKey(): string | null {
  const key = getJevApiKey();
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export function setJevApiKey(key: string): { ok: boolean; error?: string } {
  return setSecret(jevSecretKey(), key);
}

export function isJevSecretStorageAvailable(): boolean {
  // Same doctrine as voice: no synchronous Keychain probe on status paths.
  return isSecureStorageAvailable({ probe: false });
}
