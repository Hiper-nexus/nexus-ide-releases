import { hasVoiceCredential, resolveVoiceApiKey } from '../voice/voice-secrets';

/** A mesma chave de Chaves de API → OpenAI. Não há um segundo cofre. */
export const LUNA_KEY_ENV = 'OPENAI_API_KEY';

export function hasLunaCredential(): boolean {
  return hasVoiceCredential(LUNA_KEY_ENV);
}

export function resolveLunaApiKey(): string | undefined {
  return resolveVoiceApiKey(LUNA_KEY_ENV);
}
