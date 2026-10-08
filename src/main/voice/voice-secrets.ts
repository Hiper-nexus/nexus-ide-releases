import { bumpDecisionCredentialRevision } from '../decision-models/decision-revision';
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
  // This probe feeds the secret-free runtime snapshot and is called while the
  // renderer asks for voice status. Presence in the encrypted vault is enough;
  // decrypting here enters the macOS Keychain synchronously and can freeze the
  // Electron main thread. The actual value is still resolved lazily by
  // resolveVoiceApiKey when a voice turn starts.
  if (hasStoredVoiceApiKey(envVar)) return true;
  return Boolean(process.env[envVar]?.trim());
}

/** De onde a key resolveu — PRESENÇA apenas, nunca o valor. Mesma cadeia do
 *  resolveVoiceApiKey (secrets store primeiro, env como fallback). */
export type VoiceApiKeySource = 'stored' | 'env' | 'missing';

export function voiceApiKeySource(envVar: string): VoiceApiKeySource {
  // hasSecret only — never decrypt for presence checks (boot hang / Keychain).
  if (hasStoredVoiceApiKey(envVar)) return 'stored';
  if (process.env[envVar]?.trim()) return 'env';
  return 'missing';
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
  const result = setSecret(voiceSecretKey(envVar), key);
  if (result.ok && envVar === 'OPENAI_API_KEY') bumpDecisionCredentialRevision();
  return result;
}

export function isVoiceSecretStorageAvailable(): boolean {
  // Voice config is loaded during boot; do not synchronously ask the Keychain
  // here. Credential writes/reads still perform the strict probe on demand.
  return isSecureStorageAvailable({ probe: false });
}
