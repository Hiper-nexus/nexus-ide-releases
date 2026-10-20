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

/**
 * Pares que dividem a mesma chave: Gemini (google-image ↔ google-video),
 * REPLICATE_API_TOKEN e, desde o F-1599, a XAI_API_KEY (xai-image ↔ xai-video).
 */
const PAIRED_PROVIDER: Partial<Record<MediaProviderId, MediaProviderId>> = {
  'google-image': 'google-video',
  'google-video': 'google-image',
  'replicate-image': 'replicate-video',
  'replicate-video': 'replicate-image',
  'xai-image': 'xai-video',
  'xai-video': 'xai-image',
  'higgsfield-image': 'higgsfield-video',
  'higgsfield-video': 'higgsfield-image',
};

export function mediaSecretKey(providerId: MediaProviderId): string {
  return `${MEDIA_SECRET_PREFIX}${providerId}`;
}

/** Vault first, env-var fallback (dev convenience). */
export function resolveMediaKey(def: MediaProviderDef): string | undefined {
  const stored = getSecret(mediaSecretKey(def.id))?.trim();
  if (stored) return stored;
  const paired = PAIRED_PROVIDER[def.id];
  if (paired) {
    const pairedKey = getSecret(mediaSecretKey(paired))?.trim();
    if (pairedKey) return pairedKey;
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
  const pairedId = PAIRED_PROVIDER[def.id];
  const paired = pairedId !== undefined && hasSecret(mediaSecretKey(pairedId));
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
  const pairedId = def ? PAIRED_PROVIDER[def.id] : undefined;
  const key = def
    ? cached(mediaSecretKey(def.id)) ||
      (pairedId !== undefined && cached(mediaSecretKey(pairedId))) ||
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
