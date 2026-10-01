import { base64Url, safeEqual } from '../crypto.js';

/**
 * Descadastro por link assinado: o token é o HMAC-SHA256 da conta com NOTICE_SECRET, então quem
 * recebe o e-mail pode descadastrar sem login e ninguém consegue descadastrar a conta de outra pessoa.
 * O prefixo de domínio separa este uso de qualquer outro que reaproveite o mesmo segredo.
 */
const DOMAIN = 'nexus-notices:unsubscribe:';
const TOKEN_LENGTH = 43; // 32 bytes em base64url, sem preenchimento

async function sign(secret: string, accountId: string): Promise<string> {
  if (secret === '') throw new TypeError('NOTICE_SECRET ausente');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${DOMAIN}${accountId}`));
  return base64Url(new Uint8Array(mac));
}

export async function noticeToken(secret: string, accountId: string): Promise<string> {
  return sign(secret, accountId);
}

/** Comparação em tempo constante. Segredo vazio nunca valida: o recurso fica desligado, não aberto. */
export async function verifyNoticeToken(secret: string, accountId: string, token: string): Promise<boolean> {
  if (secret === '' || accountId === '' || token.length !== TOKEN_LENGTH) return false;
  return safeEqual(await sign(secret, accountId), token);
}

export function buildUnsubscribeUrl(publicBaseUrl: string, accountId: string, token: string): string {
  const url = new URL('/v1/notices/unsubscribe', publicBaseUrl);
  url.searchParams.set('a', accountId);
  url.searchParams.set('t', token);
  return url.href;
}
