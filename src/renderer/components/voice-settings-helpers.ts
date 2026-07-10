import type { JarvisLiveSmokeFailureReason } from '../../shared/voice-ipc';
import type {
  ResolvedProvider,
  VoiceApiKeyStatus,
} from '../../shared/voice-ipc';
import type { JarvisLiveTransport } from '../../shared/voice-config';

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

export function liveSmokeFailureMessage(
  reason: JarvisLiveSmokeFailureReason,
  transport: RealtimeTransport,
): string {
  const providerKey =
    transport === 'gemini-live' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  const messages: Record<JarvisLiveSmokeFailureReason, string> = {
    busy: 'Já existe um diagnóstico realtime em andamento.',
    invalid_request: 'O diagnóstico realtime recebeu dados inválidos.',
    realtime_unavailable: `Realtime indisponível; verifique ${providerKey}.`,
    provider_error: 'O provider realtime desconectou ou retornou erro.',
    response_timeout: 'Realtime conectou, mas não respondeu em 15 segundos.',
    no_audio_response: 'Realtime respondeu sem produzir áudio.',
    audio_playback_failed:
      'Realtime respondeu, mas o Nexus não conseguiu iniciar a reprodução de áudio.',
    session_closed: 'A sessão realtime foi encerrada durante o diagnóstico.',
  };
  return messages[reason];
}
