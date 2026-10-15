import type { JarvisLiveSmokeFailureReason } from '../../shared/voice-ipc';
import type {
  RealtimeFailure,
  ResolvedProvider,
  VoiceApiKeyStatus,
} from '../../shared/voice-ipc';
import type {
  JarvisLiveTransport,
  RealtimeProviderKey,
} from '../../shared/voice-config';
import {
  REALTIME_FALLBACK_CHAIN,
  REALTIME_PROVIDER_ENV_VAR,
} from '../../shared/voice-config';

type RealtimeTransport = Exclude<JarvisLiveTransport, 'classic'>;

/** Rótulo de cada transporte realtime. Fonte única: o chip e o helper usam esta. */
export const REALTIME_TRANSPORT_LABEL: Record<RealtimeTransport, string> = {
  'grok-realtime': 'Grok Voice',
  'gemini-live': 'Gemini Live',
  'openai-realtime': 'OpenAI Realtime',
};

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

/**
 * Como o chip de conexão é derivado. Antes ele era `realtimeReady ? conectado :
 * conectando`, o que deixava o cliente do Windows olhando para "Grok Voice
 * conectando" parado, sem nenhuma pista do motivo: a falha do provider vivia
 * num console.warn do Main.
 *
 * Ordem de decisão (a primeira que casa vence):
 *   1. Conectou        -> online, nomeando a rota REAL (pode ser degradação)
 *   2. Houve falha     -> error / no-key, com o motivo por categoria
 *   3. Status de erro  -> error, sem categoria (caminho que não classifies)
 *   4. Nada tentou     -> standby (pronto, conecta quando você falar)
 *   5. Qualquer outro  -> connecting
 */
export type LiveConnectionTone =
  | 'online'
  | 'error'
  | 'no-key'
  | 'standby'
  | 'connecting';

export interface LiveConnectionView {
  tone: LiveConnectionTone;
  /** Frase curta do estado. Nunca caixa-alta, nunca jargão de socket. */
  label: string;
  /** Segunda linha: o que fazer a respeito. Só quando há algo a dizer. */
  detail: string;
}

const REALTIME_PROVIDER_NAME: Record<RealtimeProviderKey, string> = {
  grok: 'Grok Voice',
  openai: 'OpenAI Realtime',
  gemini: 'Gemini Live',
};

function providerName(key: RealtimeProviderKey | null | undefined): string {
  return key ? (REALTIME_PROVIDER_NAME[key] ?? key) : 'o realtime';
}

/**
 * Traduz a CATEGORIA (nunca o texto do provedor) em uma frase que aponta a
 * ação. Uma categoria sem provedor nomeado não diz nada acionável, então cada
 * mensagem cita a rota ou o modelo que caiu.
 */
export function realtimeFailureMessage(
  failure: RealtimeFailure,
  transport: RealtimeTransport,
): string {
  const who = providerName(failure.provider);
  const keyList = formatRealtimeKeyList(transport);
  const suffix = failure.status ? ` (HTTP ${failure.status})` : '';
  switch (failure.category) {
    case 'auth_rejected':
      return `${who} recusou a chave${suffix}. Troque a credencial dessa rota.`;
    case 'model_rejected':
      return failure.model
        ? `${who} não reconhece o modelo ${failure.model}${suffix}. Escolha um modelo da lista.`
        : `${who} recusou o modelo pedido${suffix}. Escolha um modelo da lista.`;
    case 'timeout':
      return `${who} não respondeu a tempo. Tente de novo; se repetir, é a rede.`;
    case 'closed_before_setup':
      return `${who} fechou a conexão antes de começar. Tente de novo em instantes.`;
    case 'network':
      return `Não consegui falar com ${who}. Verifique a conexão.`;
    case 'provider_error':
      return `${who} recusou a conexão${suffix}.`;
    case 'no_key':
      return `Sem chave para o realtime. Configure ${keyList}.`;
    case 'vault_unreadable':
      return `A chave salva de ${who} não pôde ser lida. Salve a chave de novo.`;
  }
}

/** Falha sem credencial tem glifo próprio: não é "erro", é "falta configuração". */
function isMissingCredential(failure: RealtimeFailure): boolean {
  return failure.category === 'no_key' || failure.category === 'vault_unreadable';
}

/**
 * O Main recusa a sessão de voz fora de um projeto autorizado e devolve o erro
 * cru. "voice session requires an authorized project scope" é jargão de Main:
 * não diz o que a pessoa precisa fazer. Traduzimos para a ação.
 */
export function liveTestErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('requires an authorized project scope')) {
    return 'Abra um projeto para testar a voz.';
  }
  if (message.includes('voice capture disabled')) {
    return 'A captura de voz está desligada nesta janela.';
  }
  return message;
}

export function liveConnectionView(input: {
  transport: RealtimeTransport;
  /** Transporte realtime ligado e com sessão: fora disso a voz é clássica. */
  configured: boolean;
  /** Live ligado no transporte clássico (FSM por lote, sem socket). */
  classicLive: boolean;
  realtimeReady: boolean;
  failure?: RealtimeFailure | null;
  connectedProvider?: RealtimeProviderKey | null;
  /** True quando uma tentativa de conexão já aconteceu nesta sessão. */
  attempted: boolean;
}): LiveConnectionView {
  const transportLabel = REALTIME_TRANSPORT_LABEL[input.transport];
  // A rota que conectou pode não ser a configurada: dizer "Grok Voice conectado"
  // quando quem conectou foi o Gemini seria mentira. A cabeça da cadeia é a
  // rota oficial (shared), a mesma que o runtime percorre.
  const head = REALTIME_FALLBACK_CHAIN[input.transport][0];
  const failedOver = Boolean(
    input.connectedProvider && input.connectedProvider !== head,
  );

  if (input.realtimeReady) {
    const who = providerName(input.connectedProvider);
    return {
      tone: 'online',
      label: `${who} conectado`,
      detail: failedOver
        ? `${transportLabel} não respondeu e a sessão entrou por ${who}. O TTS clássico só entra como fallback.`
        : `Wake word e conversa seguem direto pelo ${who}. O TTS clássico só entra como fallback.`,
    };
  }

  if (input.failure) {
    const missing = isMissingCredential(input.failure);
    return {
      tone: missing ? 'no-key' : 'error',
      label: missing
        ? `${transportLabel} sem credencial`
        : `${transportLabel} não conectou`,
      detail: realtimeFailureMessage(input.failure, input.transport),
    };
  }

  if (!input.configured) {
    return input.classicLive
      ? {
          tone: 'standby',
          label: 'Jarvis Live clássico',
          detail: 'A sessão contínua está ativa, mas usa o pipeline clássico de voz.',
        }
      : {
          tone: 'standby',
          label: 'Jarvis em modo manual',
          detail: 'Ative Jarvis Live para manter uma sessão de voz contínua.',
        };
  }

  if (!input.attempted) {
    return {
      tone: 'standby',
      label: 'Pronto — conecta quando você falar',
      detail: `${transportLabel} abre no primeiro turno de voz.`,
    };
  }

  return {
    tone: 'connecting',
    label: `${transportLabel} conectando`,
    detail: `O canal ${transportLabel} será usado assim que a sessão terminar de conectar.`,
  };
}
