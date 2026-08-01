import type { JarvisLiveSmokeFailureReason } from '../../shared/voice-ipc';
import type {
  ResolvedProvider,
  VoiceApiKeyStatus,
} from '../../shared/voice-ipc';
import type { JarvisLiveTransport } from '../../shared/voice-config';
import {
  REALTIME_FALLBACK_CHAIN,
  REALTIME_PROVIDER_ENV_VAR,
} from '../../shared/voice-config';

type RealtimeTransport = Exclude<JarvisLiveTransport, 'classic'>;

export function providerOption(provider: ResolvedProvider): string {
  const tag = provider.available ? '' : ' (unavailable)';
  const model = provider.model ? ` · ${provider.model}` : '';
  return `${provider.provider}${model}${tag} — ${provider.reason}`;
}

export function keyStatusText(key: VoiceApiKeyStatus): string {
  if (key.hasStoredKey) return `saved ${key.keyMasked ?? '••••'}`;
  if (key.hasEnv) return 'available from environment';
  if (!key.secureStorageAvailable) return 'Keychain unavailable';
  return 'not set';
}

export function keyPlaceholder(key: VoiceApiKeyStatus): string {
  if (key.hasStoredKey) return `Stored ${key.keyMasked ?? 'key'}; paste to replace`;
  if (key.hasEnv) return 'Already set in environment; paste to override';
  return `Paste ${key.envVar}`;
}

/**
 * `realtime_unavailable` significa que NENHUMA rota da cadeia conectou — uma
 * rota sem credencial nem chega a virar candidata. Nomear só a chave do
 * transporte configurado mandava o operador conferir a credencial errada:
 * com Grok escolhido e sem XAI_API_KEY, quem de fato falhava era a OpenAI, e a
 * mensagem ainda dizia "verifique XAI_API_KEY". A cadeia vem de
 * REALTIME_FALLBACK_CHAIN (shared), a mesma que o runtime percorre.
 */
export function realtimeChainEnvVars(transport: RealtimeTransport): string[] {
  return REALTIME_FALLBACK_CHAIN[transport].map(
    (provider) => REALTIME_PROVIDER_ENV_VAR[provider],
  );
}

export function liveSmokeFailureMessage(
  reason: JarvisLiveSmokeFailureReason,
  transport: RealtimeTransport,
): string {
  const chainKeys = realtimeChainEnvVars(transport);
  const keyList =
    chainKeys.length > 1
      ? `${chainKeys.slice(0, -1).join(', ')} ou ${chainKeys.at(-1)}`
      : chainKeys[0];
  const messages: Record<JarvisLiveSmokeFailureReason, string> = {
    busy: 'Já existe um diagnóstico realtime em andamento.',
    invalid_request: 'O diagnóstico realtime recebeu dados inválidos.',
    realtime_unavailable:
      `Realtime indisponível: nenhuma rota da cadeia conectou. ` +
      `Verifique ${keyList}.`,
    provider_error: 'O provider realtime desconectou ou retornou erro.',
    response_timeout: 'Realtime conectou, mas não respondeu em 15 segundos.',
    no_audio_response: 'Realtime respondeu sem produzir áudio.',
    audio_playback_failed:
      'Realtime respondeu, mas o Nexus não conseguiu iniciar a reprodução de áudio.',
    session_closed: 'A sessão realtime foi encerrada durante o diagnóstico.',
  };
  return messages[reason];
}
