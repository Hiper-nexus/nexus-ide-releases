import {
  getSecret,
  hasSecret,
  setSecret,
} from '../persistence/secrets-store';
import type { MediaProviderId } from '../../shared/media-types';
import type { MediaProviderDef } from './media-providers';

/**
 * Media API keys — safeStorage/Keychain-backed edge (mirrors voice-secrets).
 * Vault key: `mediakey:<providerId>`; env-var fallback for dev. The agent
 * process NEVER sees these values — generation runs in main and only the
 * output file path crosses the MCP boundary.
 */

const MEDIA_SECRET_PREFIX = 'mediakey:';

export function mediaSecretKey(providerId: MediaProviderId): string {
  return `${MEDIA_SECRET_PREFIX}${providerId}`;
}

/** Vault first, env-var fallback (dev convenience). */
export function resolveMediaKey(def: MediaProviderDef): string | undefined {
  const stored = getSecret(mediaSecretKey(def.id))?.trim();
  if (stored) return stored;
  const inherited = process.env[def.envVar]?.trim();
  return inherited || undefined;
}

export function hasMediaKey(def: MediaProviderDef): boolean {
  return resolveMediaKey(def) !== undefined;
}

export function setMediaKey(
  providerId: MediaProviderId,
  key: string,
): { ok: boolean; error?: string } {
  return setSecret(mediaSecretKey(providerId), key);
}

export function hasStoredMediaKey(providerId: MediaProviderId): boolean {
  return hasSecret(mediaSecretKey(providerId));
}

export function maskedMediaKey(providerId: MediaProviderId): string | null {
  const key = getSecret(mediaSecretKey(providerId));
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
