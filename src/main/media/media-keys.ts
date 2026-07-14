import {
  getSecret,
  hasCachedSecret,
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
  // Provider/tool capability snapshots are queried during boot. Read only the
  // encrypted index here; decrypting a cold value would synchronously enter
  // the macOS Keychain and stall Electron's main thread.
  const own = hasSecret(mediaSecretKey(def.id));
  const shared = hasSecret(`${VOICE_SECRET_PREFIX}${def.envVar}`);
  const paired =
    (def.id === 'google-image' && hasSecret(mediaSecretKey('google-video'))) ||
    (def.id === 'google-video' && hasSecret(mediaSecretKey('google-image'))) ||
    (def.id === 'replicate-image' && hasSecret(mediaSecretKey('replicate-video'))) ||
    (def.id === 'replicate-video' && hasSecret(mediaSecretKey('replicate-image')));
  return own || shared || paired || Boolean(process.env[def.envVar]?.trim());
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
  // Prefer a cached value. On a cold boot, return a generic mask based on the
  // encrypted index and never decrypt Keychain data for a status render.
  const cached = (key: string): string | null =>
    hasCachedSecret(key) ? getSecret(key)?.trim() || null : null;
  const key = def
    ? cached(mediaSecretKey(def.id)) ||
      (def.id === 'google-video' && cached(mediaSecretKey('google-image'))) ||
      (def.id === 'google-image' && cached(mediaSecretKey('google-video'))) ||
      (def.id === 'replicate-image' && cached(mediaSecretKey('replicate-video'))) ||
      (def.id === 'replicate-video' && cached(mediaSecretKey('replicate-image'))) ||
      cached(`${VOICE_SECRET_PREFIX}${def.envVar}`) ||
      (process.env[def.envVar]?.trim() ?? null)
    : cached(mediaSecretKey(providerId));
  if (!key) {
    return def
      ? hasMediaKey(def)
        ? '••••'
        : null
      : hasSecret(mediaSecretKey(providerId))
        ? '••••'
        : null;
  }
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
