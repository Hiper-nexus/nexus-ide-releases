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
  // google-image ↔ google-video share the same Gemini AI Studio key.
  if (def.id === 'google-video') {
    const imageKey = getSecret(mediaSecretKey('google-image'))?.trim();
    if (imageKey) return imageKey;
  }
  if (def.id === 'google-image') {
    const videoKey = getSecret(mediaSecretKey('google-video'))?.trim();
    if (videoKey) return videoKey;
  }
  // replicate-image ↔ replicate-video share REPLICATE_API_TOKEN.
  if (def.id === 'replicate-image') {
    const videoKey = getSecret(mediaSecretKey('replicate-video'))?.trim();
    if (videoKey) return videoKey;
  }
  if (def.id === 'replicate-video') {
    const imageKey = getSecret(mediaSecretKey('replicate-image'))?.trim();
    if (imageKey) return imageKey;
  }
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
  // Prefer the fully resolved key (shared google/replicate vault slots +
  // voice-env + process env) so Settings shows a mask when the provider is
  // actually usable, not only when its own mediakey: slot is filled.
  const key = def
    ? resolveMediaKey(def)
    : getSecret(mediaSecretKey(providerId))?.trim() || null;
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
