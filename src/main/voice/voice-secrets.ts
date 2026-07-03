import {
  getSecret,
  hasSecret,
  isSecureStorageAvailable,
  setSecret,
} from '../persistence/secrets-store';

const VOICE_SECRET_PREFIX = 'voice-env:';

function voiceSecretKey(envVar: string): string {
  return `${VOICE_SECRET_PREFIX}${envVar}`;
}

export function getVoiceApiKey(envVar: string): string | null {
  return getSecret(voiceSecretKey(envVar));
}

export function resolveVoiceApiKey(envVar: string): string | undefined {
  const stored = getVoiceApiKey(envVar)?.trim();
  if (stored) return stored;
  const inherited = process.env[envVar]?.trim();
  return inherited || undefined;
}

export function hasVoiceCredential(envVar: string): boolean {
  return resolveVoiceApiKey(envVar) !== undefined;
}

export function hasStoredVoiceApiKey(envVar: string): boolean {
  return hasSecret(voiceSecretKey(envVar));
}

export function maskedVoiceApiKey(envVar: string): string | null {
  const key = getVoiceApiKey(envVar);
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export function setVoiceApiKey(
  envVar: string,
  key: string,
): { ok: boolean; error?: string } {
  return setSecret(voiceSecretKey(envVar), key);
}

export function isVoiceSecretStorageAvailable(): boolean {
  return isSecureStorageAvailable();
}
