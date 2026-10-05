/**
 * Regras puras da tela de cupons do painel admin. Sem DOM e sem rede.
 * O código fica visível: o administrador entrega o mesmo texto no checkout.
 */

import { INTERVALS, normalizeCouponCode } from './checkout-offer.js';

export const COUPON_INTERVALS = INTERVALS;
export const COUPON_STATUS_LABELS = Object.freeze({
  active: 'Ativo',
  off: 'Desligado',
  expired: 'Expirado',
  used: 'Esgotado',
});

const INTEGER = /^[0-9]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BRL = /^(\d{1,6})(?:[.,](\d{1,2}))?$/;
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const MESSAGES = Object.freeze({
  code: 'Use letras, números e hífen, de 3 a 32 caracteres.',
  kind: 'Escolha percentual ou valor em reais.',
  percent: 'O desconto percentual precisa ser um número inteiro de 1 a 100.',
  amount: 'Informe um valor em reais, como 10 ou 10,00.',
  intervals: 'Marque pelo menos um período.',
  expires: 'A validade do cupom precisa ser uma data futura.',
  max: 'O limite de usos precisa ser um número inteiro de 1 a 100.000, ou ficar em branco.',
});

function wholeNumber(value, max) {
  if (!INTEGER.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function brlToCents(raw) {
  const match = BRL.exec(String(raw).trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents >= 1 && cents <= 100_000_000 ? cents : null;
}

/** Valores do formulário → corpo do POST /v1/admin/coupons, ou o primeiro erro. */
export function couponFormToBody(values, now = Date.now()) {
  const code = normalizeCouponCode(values.code ?? '');
  if (!code) return { ok: false, field: 'code', error: MESSAGES.code };
  const kind = values.kind;
  if (kind !== 'percent' && kind !== 'amount') return { ok: false, field: 'kind', error: MESSAGES.kind };
  const value = kind === 'percent' ? wholeNumber(String(values.value ?? '').trim(), 100) : brlToCents(values.value ?? '');
  if (value === null) return { ok: false, field: 'value', error: kind === 'percent' ? MESSAGES.percent : MESSAGES.amount };
  const intervals = Array.isArray(values.intervals) ? values.intervals.filter((id) => INTERVALS.some((spec) => spec.id === id)) : [];
  if (intervals.length === 0) return { ok: false, field: 'intervals', error: MESSAGES.intervals };
  const body = { code, kind, value, intervals };
  const expires = String(values.expires ?? '').trim();
  if (expires !== '') {
    if (!DATE.test(expires)) return { ok: false, field: 'expires', error: MESSAGES.expires };
    const expiresAt = `${expires}T23:59:59.999Z`;
    if (Date.parse(expiresAt) <= now) return { ok: false, field: 'expires', error: MESSAGES.expires };
    body.expiresAt = expiresAt;
  }
  const maxRaw = String(values.maxRedemptions ?? '').trim();
  if (maxRaw !== '') {
    const maxRedemptions = wholeNumber(maxRaw, 100_000);
    if (maxRedemptions === null) return { ok: false, field: 'maxRedemptions', error: MESSAGES.max };
    body.maxRedemptions = maxRedemptions;
  }
  return { ok: true, body };
}

/** Desligado vence prazo e limite: a pessoa precisa ver que o código não entra mais. */
export function couponStatus(coupon, now = Date.now()) {
  if (coupon.active !== true) return 'off';
  if (coupon.expiresAt && Date.parse(coupon.expiresAt) <= now) return 'expired';
  if (coupon.maxRedemptions !== null && coupon.uses >= coupon.maxRedemptions) return 'used';
  return 'active';
}

export function couponValueLabel(coupon) {
  return coupon.kind === 'percent' ? `${coupon.value}%` : money.format(coupon.value / 100);
}

export function couponKindLabel(kind) {
  return kind === 'percent' ? 'Percentual' : 'Valor em reais';
}

export function couponIntervalsLabel(intervals) {
  const labels = INTERVALS.filter((spec) => intervals.includes(spec.id)).map((spec) => spec.label);
  return labels.length ? labels.join(', ') : '—';
}

export function couponUsesLabel(coupon) {
  return coupon.maxRedemptions === null ? String(coupon.uses) : `${coupon.uses} de ${coupon.maxRedemptions}`;
}

const isIso = (value) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
const INTERVAL_IDS = new Set(INTERVALS.map((spec) => spec.id));

export function parseCouponsResponse(data) {
  const fail = () => { throw new Error('O serviço não retornou uma lista de cupons válida. Atualize novamente.'); };
  if (!data || !Array.isArray(data.coupons)) return fail();
  for (const coupon of data.coupons) {
    const intervalsOk = Array.isArray(coupon?.intervals) && coupon.intervals.length > 0
      && coupon.intervals.every((id) => INTERVAL_IDS.has(id));
    const valid = coupon && typeof coupon.id === 'string' && coupon.id
      && typeof coupon.code === 'string' && normalizeCouponCode(coupon.code) === coupon.code
      && (coupon.kind === 'percent' || coupon.kind === 'amount')
      && Number.isInteger(coupon.value) && coupon.value >= 1
      && intervalsOk
      && Number.isInteger(coupon.uses) && coupon.uses >= 0
      && (coupon.maxRedemptions === null || (Number.isInteger(coupon.maxRedemptions) && coupon.maxRedemptions >= 1))
      && typeof coupon.active === 'boolean'
      && isIso(coupon.expiresAt) && isIso(coupon.disabledAt) && typeof coupon.createdAt === 'string'
      && !Object.hasOwn(coupon, 'stripeCouponId') && !Object.hasOwn(coupon, 'stripe_coupon_id');
    if (!valid) return fail();
  }
  return data.coupons;
}
