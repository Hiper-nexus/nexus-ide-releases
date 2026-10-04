/**
 * Oferta de checkout do Pro: quatro períodos pelo valor mensal vezes os meses,
 * e o corpo do POST. Sem DOM. Um valor que não fecha essa conta fica indisponível.
 */

export const INTERVALS = Object.freeze([
  Object.freeze({ id: 'month', months: 1, label: 'Mensal', cadence: 'por mês' }),
  Object.freeze({ id: 'quarter', months: 3, label: 'Trimestral', cadence: 'a cada 3 meses' }),
  Object.freeze({ id: 'semiannual', months: 6, label: 'Semestral', cadence: 'a cada 6 meses' }),
  Object.freeze({ id: 'year', months: 12, label: 'Anual', cadence: 'por ano' }),
]);

const MONTHLY_CENTS = 5999;
const COUPON_CODE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function normalizeCouponCode(raw) {
  const code = String(raw ?? '').trim().replace(/\s+/g, '').toUpperCase();
  return COUPON_CODE.test(code) ? code : null;
}

/** Código vazio é checkout sem cupom. Qualquer outra coisa fora do formato falha antes da rede. */
export function clientCouponError(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  return normalizeCouponCode(text) ? null : 'Cupom inválido.';
}

export function offersFromBilling(billing) {
  const monthly = Number.isInteger(billing?.amount) && billing.currency === 'brl' && billing.interval === 'month'
    ? billing.amount
    : MONTHLY_CENTS;
  const listed = Array.isArray(billing?.intervals) ? billing.intervals : [];
  return INTERVALS.map((spec) => {
    const found = listed.find((item) => item && item.id === spec.id);
    const amount = monthly * spec.months;
    const amountMatches = !found || found.amount === amount;
    const available = spec.id === 'month'
      ? Boolean(billing?.available) && amountMatches
      : Boolean(found?.available) && amountMatches && found.amount === amount;
    return {
      id: spec.id,
      months: spec.months,
      label: spec.label,
      cadence: spec.cadence,
      amount,
      available,
    };
  });
}

export function offerLabel(offer) {
  const base = `${offer.label} · ${money.format(offer.amount / 100)} ${offer.cadence}`;
  return offer.available ? base : `${base} · indisponível`;
}

export function checkoutBody({ interval, coupon, attemptId }) {
  const body = { plan: 'pro', attemptId, interval: interval || 'month' };
  const code = normalizeCouponCode(coupon ?? '');
  if (code) body.coupon = code;
  return body;
}
