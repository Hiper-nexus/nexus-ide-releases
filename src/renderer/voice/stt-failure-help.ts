import type { TranscribeResult } from '../../shared/voice-ipc';

/**
 * Transparência do STT para o operador: qual API atendeu o turno e, quando
 * tudo falhou, o que fazer a respeito — em português, apontando o caminho de
 * correção (chave, preview sem acesso, throttle, fallback local) em vez do
 * erro técnico cru em inglês.
 */

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  xai: 'Grok Voice Transcribe (xAI)',
  groq: 'Groq',
  openai: 'OpenAI',
  'local-whisper': 'Whisper local',
  deepgram: 'Deepgram',
};

export function sttProviderLabel(providerId: string | undefined): string {
  if (!providerId) return 'STT';
  return PROVIDER_LABELS[providerId] ?? providerId;
}

interface SttHelp {
  /** Causa principal (o provider escolhido que não atendeu). */
  cause: string;
  /** Caminho de correção mais acionável dentre as falhas observadas. */
  hint: string | null;
}

const KEYS_SECTION = 'Configurações → Chaves de API';

function classifyAttempt(
  provider: string,
  reason: string,
): { cause: string; hint: string | null } {
  const label = sttProviderLabel(provider);
  if (/not set/i.test(reason)) {
    const env = /([A-Z0-9_]+_API_KEY)\s+not set/i.exec(reason)?.[1] ?? 'a chave do provedor';
    return {
      cause: `${label} sem chave (${env})`,
      hint: `adicione a chave em ${KEYS_SECTION}`,
    };
  }
  if (/invalid key \(401\)/i.test(reason)) {
    return {
      cause: `chave do ${label} inválida (401)`,
      hint: `confira ou gere uma nova chave em ${KEYS_SECTION}`,
    };
  }
  if (/quota\/billing \(402\)|forbidden\/quota \(403\)/i.test(reason)) {
    return {
      cause: `${label} recusou por cota/faturamento`,
      hint: `verifique o plano/limite da conta do ${label} ou ative outra chave em ${KEYS_SECTION}`,
    };
  }
  if (provider === 'gemini' && /interactions:.*(40[34]|empty transcript)/i.test(reason)) {
    return {
      cause:
        'sua chave Gemini não tem acesso ao modelo de transcrição (preview) e a rota alternativa também não respondeu',
      hint: `para ditado instantâneo, ative a Groq em ${KEYS_SECTION} — ela usa Whisper e não depende de preview`,
    };
  }
  if (/throttled \(429/i.test(reason)) {
    return {
      cause: `${label} atingiu o limite de requisições (429)`,
      hint: 'aguarde alguns segundos e tente de novo, ou ative outra chave',
    };
  }
  if (/timeout/i.test(reason)) {
    return {
      cause: `${label} demorou demais para responder`,
      hint: 'verifique a conexão com a internet e tente de novo',
    };
  }
  if (/whisper\.cpp not found|whisper model missing/i.test(reason)) {
    return {
      cause: 'fallback local sem whisper.cpp instalado',
      hint: 'para um ditado sem nenhuma chave: brew install whisper-cpp e um modelo em ~/.nexus/models/whisper',
    };
  }
  if (/network error/i.test(reason)) {
    return {
      cause: `${label} inalcançável (rede/DNS)`,
      hint: 'verifique a conexão com a internet',
    };
  }
  return { cause: `${label}: ${reason}`, hint: null };
}

/**
 * Ordem de preferência dos hints: o mais acionável primeiro. Instalar o
 * whisper.cpp resolve o ditado SEM nenhuma conta; configurar a Groq resolve o
 * caso do preview; o resto depende do usuário já ter chave.
 */
const HINT_PRIORITY = [
  /brew install whisper-cpp/i,
  /ative a Groq/i,
  /Chaves de API/i,
  /aguarde|conexão/i,
];

function rankHint(hint: string): number {
  const idx = HINT_PRIORITY.findIndex((re) => re.test(hint));
  return idx === -1 ? HINT_PRIORITY.length : idx;
}

/**
 * Mensagem de falha acionável: causa principal (head da cadeia) + o hint de
 * correção mais acionável entre todas as tentativas.
 */
export function describeSttFailure(result: TranscribeResult): string {
  const attempts = result.attempts ?? [];
  if (attempts.length === 0) {
    return `A transcrição falhou. Verifique as chaves em ${KEYS_SECTION}.`;
  }
  const helps: SttHelp[] = attempts.map((a) => classifyAttempt(a.provider, a.reason));
  const head = helps[0];
  const withHints = helps.filter((h) => h.hint);
  const hint = withHints.length
    ? withHints.reduce((best, cur) =>
        rankHint(cur.hint ?? '') < rankHint(best.hint ?? '') ? cur : best,
      ).hint
    : null;
  const others =
    helps.length > 1
      ? ` (outras tentativas: ${helps.slice(1).map((h) => h.cause).join('; ')})`
      : '';
  return hint
    ? `Transcrição falhou: ${head.cause}${others}. Como resolver: ${hint}.`
    : `Transcrição falhou: ${head.cause}${others}.`;
}

/** Ramo de sucesso do TranscribeResult (onde provider/fallbackNote existem). */
export type SuccessfulTranscribeResult = Extract<TranscribeResult, { ok: true }>;

/**
 * Nota de transparência do turno bem-sucedido: qual API atendeu. Se houve
 * fallback, a nota do fallback já narra a jornada — esta é para o caso comum
 * em que o provider de cabeça atendeu direto e o operador não sabe quem é.
 */
export function sttSuccessNote(result: SuccessfulTranscribeResult): string {
  if (result.fallbackNote) return result.fallbackNote;
  return `Transcrito com ${sttProviderLabel(result.provider)}`;
}
