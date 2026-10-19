/**
 * F-1584: a falha de um serviço de mídia vira uma frase que diz o que houve e
 * o que fazer. Antes o Estúdio e os agentes recebiam `replicate-video HTTP
 * 422: {"detail":"- input.duration: …"}` — status cru e JSON truncado.
 *
 * O detalhe do serviço (a frase dele, não o corpo inteiro) continua no fim,
 * porque é ele que diz QUAL parâmetro foi recusado. Nunca entra cabeçalho,
 * chave nem URL assinada: só o texto do corpo de erro, cortado.
 */

import type { MediaErrorKind } from '../../shared/media-types';

const DETAIL_MAX = 300;

/** Nome do serviço para a frase: `replicate-video` → `Replicate`. */
export function mediaServiceName(provider: string): string {
  const id = provider.toLowerCase();
  if (id.startsWith('replicate')) return 'Replicate';
  if (id.startsWith('google') || id.startsWith('gemini')) return 'Google';
  if (id.startsWith('openai')) return 'OpenAI';
  if (id.startsWith('elevenlabs')) return 'ElevenLabs';
  if (id.startsWith('xai')) return 'xAI';
  return provider;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

/**
 * Corpo de erro em JSON; o `/v1beta/interactions` do Google o embrulha num
 * array (`[{"error":{…}}]`, visto ao vivo em 19/10/2026, F-1587).
 */
function parseErrorBody(raw: string): Record<string, unknown> | null {
  try {
    const json = JSON.parse(raw) as unknown;
    const first = Array.isArray(json) ? (json[0] as unknown) : json;
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Motivo estruturado do Google (`error.details[].reason`), como
 * `API_KEY_INVALID`; `undefined` nos outros serviços.
 */
export function providerErrorReason(body: string): string | undefined {
  const error = parseErrorBody(body.trim())?.error;
  const details = error && typeof error === 'object' ? (error as Record<string, unknown>).details : undefined;
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    const reason = (detail as Record<string, unknown> | null)?.reason;
    if (typeof reason === 'string' && reason) return reason;
  }
  return undefined;
}

/**
 * A frase de erro do corpo: Replicate (`detail`/`title`), Google
 * (`error.message`), OpenAI (`error.message`), ElevenLabs
 * (`detail.message`). Corpo que não é JSON vai cortado como veio.
 */
export function providerErrorDetail(body: string): string {
  const raw = body.trim();
  if (!raw) return '';
  const json = parseErrorBody(raw);
  if (json) {
    const error = json.error;
    const detail = json.detail;
    const candidates = [
      typeof detail === 'string' ? detail : undefined,
      detail && typeof detail === 'object'
        ? (detail as Record<string, unknown>).message
        : undefined,
      error && typeof error === 'object'
        ? (error as Record<string, unknown>).message
        : undefined,
      typeof error === 'string' ? error : undefined,
      json.message,
      json.title,
    ];
    const found = candidates.find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (found) return clip(found);
  }
  // Corpo não-JSON (HTML de proxy, texto puro): segue cortado.
  return clip(raw);
}

export function mediaHttpErrorKind(
  status: number,
  reason?: string,
  detail = '',
): MediaErrorKind {
  // O Google recusa chave inválida com 400, não 401/403.
  if (reason === 'API_KEY_INVALID') return 'key';
  // A xAI também (docs.x.ai/developers/debugging, e visto ao vivo em
  // 19/10/2026, F-1599): `{"code":"invalid-argument","error":"Incorrect API
  // key provided…"}`. O `code` é o mesmo de qualquer parâmetro errado.
  if (status === 400 && /\bincorrect api key\b/iu.test(detail)) return 'key';
  if (status === 401 || status === 403) return 'key';
  if (status === 402) return 'billing';
  if (status === 404) return 'not-found';
  // Cota zero (modelo só do plano pago do Gemini, F-1587): esperar não
  // resolve, falta ativar a cobrança.
  if (status === 429 && /\blimit: 0\b/u.test(detail)) return 'billing';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'unavailable';
  return 'invalid-request';
}

export function describeMediaHttpError(
  provider: string,
  status: number,
  detail: string,
  reason?: string,
): string {
  const service = mediaServiceName(provider);
  const tail = detail ? ` Resposta do serviço: ${detail}` : '';
  switch (mediaHttpErrorKind(status, reason, detail)) {
    case 'key':
      return `${service} recusou a chave (HTTP ${status}). Confira ou troque a chave em Ajustes → Serviços de mídia.${tail}`;
    case 'billing':
      return `${service} recusou por falta de saldo ou de cobrança ativa (HTTP ${status}). Adicione crédito na conta do serviço.${tail}`;
    case 'not-found':
      return `${service} não encontrou o modelo ou o pedido (HTTP ${status}); o modelo pode ter sido desligado. Escolha outro modelo.${tail}`;
    case 'rate-limit':
      return `${service} limitou os pedidos ou a cota acabou (HTTP ${status}). Espere um pouco e tente de novo.${tail}`;
    case 'unavailable':
      return `${service} está com problema (HTTP ${status}). Tente de novo em alguns minutos.${tail}`;
    default:
      return `${service} não aceitou o pedido (HTTP ${status}); nada foi gerado.${tail}`;
  }
}

export class MediaProviderHttpError extends Error {
  readonly kind: MediaErrorKind;

  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
    readonly reason?: string,
  ) {
    super(describeMediaHttpError(provider, status, detail, reason));
    this.name = 'MediaProviderHttpError';
    this.kind = mediaHttpErrorKind(status, reason, detail);
  }
}

/** Corpo de erro lido uma vez, sem deixar uma falha de leitura esconder o status. */
export async function mediaHttpError(
  res: Response,
  provider: string,
): Promise<MediaProviderHttpError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    // corpo ilegível — o status já identifica a falha
  }
  return new MediaProviderHttpError(
    provider,
    res.status,
    providerErrorDetail(body),
    providerErrorReason(body),
  );
}
