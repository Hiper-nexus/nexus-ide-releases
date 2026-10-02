/**
 * Regras puras da tela de códigos de licença do painel admin (licenças de
 * cortesia / administrativas resgatadas no app em "Tenho um código").
 * Sem DOM e sem rede: o que a tela mostra e envia é decidido aqui e testado.
 * Os limites são os mesmos da API (admin.ts), da migration 0005 e do script de emissão.
 */

export const CODE_LIMITS = Object.freeze({ periodDays: 36500, maxUses: 100, expiresInDays: 3650, note: 200 });

export const CODE_STATUS_LABELS = Object.freeze({
  active: 'Ativo',
  exhausted: 'Esgotado',
  expired: 'Prazo vencido',
  revoked: 'Revogado',
});

const INTEGER = /^[0-9]+$/;
const MINTED_CODE = /^NEXUS-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const fmt = new Intl.NumberFormat('pt-BR');

const MESSAGES = Object.freeze({
  periodDays: `Duração: use um número inteiro de 1 a ${fmt.format(CODE_LIMITS.periodDays)} dias, ou deixe em branco para licença vitalícia.`,
  maxUses: `Usos: informe um número inteiro de 1 a ${CODE_LIMITS.maxUses}.`,
  expiresInDays: `Validade do código: use um número inteiro de 1 a ${fmt.format(CODE_LIMITS.expiresInDays)} dias, ou deixe em branco para não expirar.`,
  note: `A nota pode ter até ${CODE_LIMITS.note} caracteres.`,
});

function wholeNumber(value, max) {
  if (typeof value !== 'string' || !INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

/** Valores do formulário (strings) → corpo do POST /v1/admin/license-codes, ou o primeiro erro com o campo. */
export function codeFormToBody(values) {
  const body = {};
  const periodDays = String(values.periodDays ?? '');
  if (periodDays !== '') {
    const parsed = wholeNumber(periodDays, CODE_LIMITS.periodDays);
    if (parsed === null) return { ok: false, field: 'periodDays', error: MESSAGES.periodDays };
    body.periodDays = parsed;
  }
  const usesRaw = String(values.maxUses ?? '');
  const maxUses = usesRaw === '' ? 1 : wholeNumber(usesRaw, CODE_LIMITS.maxUses);
  if (maxUses === null) return { ok: false, field: 'maxUses', error: MESSAGES.maxUses };
  body.maxUses = maxUses;
  const expires = String(values.expiresInDays ?? '');
  if (expires !== '') {
    const parsed = wholeNumber(expires, CODE_LIMITS.expiresInDays);
    if (parsed === null) return { ok: false, field: 'expiresInDays', error: MESSAGES.expiresInDays };
    body.expiresInDays = parsed;
  }
  const note = String(values.note ?? '').trim();
  if (note.length > CODE_LIMITS.note) return { ok: false, field: 'note', error: MESSAGES.note };
  body.note = note;
  return { ok: true, body };
}

/** Situação do código na lista: revogado > prazo vencido > esgotado > ativo. */
export function codeStatus(code, now = Date.now()) {
  if (code.revokedAt) return 'revoked';
  if (code.expiresAt && Date.parse(code.expiresAt) <= now) return 'expired';
  if (code.uses >= code.maxUses) return 'exhausted';
  return 'active';
}

export function durationLabel(periodDays) {
  if (periodDays === null) return 'Vitalícia';
  return periodDays === 1 ? '1 dia' : `${fmt.format(periodDays)} dias`;
}

export function usesLabel(code) {
  return `${code.uses} de ${code.maxUses}`;
}

/** O servidor só guarda o hash e os 4 últimos caracteres: é tudo que dá para mostrar depois. */
export function maskedCode(suffix) {
  return `NEXUS-••••-••••-${suffix}`;
}

/** O código em claro só existe na resposta do POST: exibe apenas se tiver o formato exato. */
export function mintedCodeFrom(data) {
  const value = data && typeof data === 'object' ? data.code : null;
  return typeof value === 'string' && MINTED_CODE.test(value) ? value : null;
}

const isIso = (value) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

/** Valida a lista antes de desenhar: resposta inesperada vira erro claro, nunca tela quebrada. */
export function parseCodesResponse(data) {
  const fail = () => { throw new Error('O serviço não retornou uma lista de códigos válida. Atualize novamente.'); };
  if (!data || !Array.isArray(data.codes)) return fail();
  for (const code of data.codes) {
    const valid = code && typeof code.id === 'string' && code.id
      && typeof code.suffix === 'string' && code.suffix.length === 4
      && code.plan === 'pro'
      && (code.periodDays === null || Number.isInteger(code.periodDays))
      && Number.isInteger(code.maxUses) && Number.isInteger(code.uses) && code.uses >= 0
      && typeof code.note === 'string'
      && isIso(code.expiresAt) && isIso(code.revokedAt) && typeof code.createdAt === 'string';
    if (!valid) return fail();
  }
  return data.codes;
}
