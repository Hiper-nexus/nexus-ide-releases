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

const PROVIDER_DISPLAY: Record<string, string> = {
  xai: 'Grok Voice Transcribe 2.0 (xAI)',
  gemini: 'Gemini',
  groq: 'Groq',
  openai: 'OpenAI',
  'local-whisper': 'Whisper local',
};

export function providerOption(provider: ResolvedProvider): string {
  const tag = provider.available ? 'Disponível' : 'Indisponível';
  const model = provider.model ? ` · ${provider.model}` : '';
  const name = PROVIDER_DISPLAY[provider.provider] ?? provider.provider;
  return `${name}${model} · ${tag}`;
}

export function keyStatusText(key: VoiceApiKeyStatus): string {
  if (key.hasStoredKey) return 'Chave salva';
  if (key.hasEnv) return 'Configurada no ambiente';
  if (!key.secureStorageAvailable) return 'Armazenamento seguro indisponível';
  return 'Não configurada';
}

export function keyPlaceholder(key: VoiceApiKeyStatus): string {
  if (key.hasStoredKey) return 'Cole uma nova chave para substituir';
  if (key.hasEnv) return 'Cole uma chave para usar no lugar da configuração do ambiente';
  return 'Cole sua chave de acesso';
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

export function formatRealtimeKeyList(transport: RealtimeTransport): string {
  const chainKeys = realtimeChainEnvVars(transport);
  return chainKeys.length > 1
    ? `${chainKeys.slice(0, -1).join(', ')} ou ${chainKeys.at(-1)}`
    : (chainKeys[0] ?? '');
}

/** Copy for the HUD when Live is on but no hop of the chain has a key. */
export function realtimeMissingCredentialMessage(
  transport: RealtimeTransport,
): string {
  return (
    `Realtime sem chave: configure ${formatRealtimeKeyList(transport)}. ` +
    `Sem isso a Jarvis não fala.`
  );
}

export function liveSmokeFailureMessage(
  reason: JarvisLiveSmokeFailureReason,
  transport: RealtimeTransport,
): string {
  const keyList = formatRealtimeKeyList(transport);
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
