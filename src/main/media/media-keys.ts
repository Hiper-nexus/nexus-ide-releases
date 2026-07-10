import {
  getSecret,
  hasSecret,
  setSecret,
} from '../persistence/secrets-store';
import type { MediaProviderId } from '../../shared/media-types';
import type { MediaProviderDef } from './media-providers';
import { findMediaProvider } from './media-providers';

/**
 * Media API keys — safeStorage/Keychain-backed edge (mirrors voice-secrets).
 * Vault key: `mediakey:<providerId>`; env-var fallback for dev. The agent
 * process NEVER sees these values — generation runs in main and only the
 * output file path crosses the MCP boundary.
 */

const MEDIA_SECRET_PREFIX = 'mediakey:';
const VOICE_SECRET_PREFIX = 'voice-env:';

export function mediaSecretKey(providerId: MediaProviderId): string {
  return `${MEDIA_SECRET_PREFIX}${providerId}`;
}

/** Vault first, env-var fallback (dev convenience). */
export function resolveMediaKey(def: MediaProviderDef): string | undefined {
  const stored = getSecret(mediaSecretKey(def.id))?.trim();
  if (stored) return stored;
  // Provider credentials are app-wide. A Gemini/OpenAI key already saved in
  // Voice must immediately enable the matching media provider instead of
  // forcing the user to duplicate the same secret under another UI section.
  const sharedProviderKey = getSecret(`${VOICE_SECRET_PREFIX}${def.envVar}`)?.trim();
  if (sharedProviderKey) return sharedProviderKey;
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
  const def = findMediaProvider(providerId);
  const key =
    getSecret(mediaSecretKey(providerId)) ??
    (def ? getSecret(`${VOICE_SECRET_PREFIX}${def.envVar}`) : null);
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
