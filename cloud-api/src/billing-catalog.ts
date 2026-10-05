import type { Config } from './config.js';
import { PRO_MONTHLY_PRICE, type StripePrice } from './stripe.js';

/** Períodos contratáveis do Pro. O valor é o mensal vezes os meses: nenhum desconto embutido. */
export const BILLING_INTERVALS = ['month', 'quarter', 'semiannual', 'year'] as const;
export type BillingInterval = typeof BILLING_INTERVALS[number];

export interface IntervalSpec {
  readonly id: BillingInterval;
  readonly months: number;
  readonly amount: number;
  readonly currency: 'brl';
  readonly stripeInterval: 'month' | 'year';
  readonly intervalCount: number;
  readonly label: string;
  readonly unavailable: string;
  readonly mismatch: string;
}

const MONTHLY = PRO_MONTHLY_PRICE.unitAmount;

export const INTERVAL_SPECS: readonly IntervalSpec[] = Object.freeze([
  Object.freeze({
    id: 'month', months: 1, amount: MONTHLY, currency: 'brl', stripeInterval: 'month', intervalCount: 1,
    label: 'mensal',
    unavailable: 'O plano mensal ainda não está disponível para contratação.',
    mismatch: 'Plano Pro temporariamente indisponível. Tente novamente mais tarde.',
  }),
  Object.freeze({
    id: 'quarter', months: 3, amount: MONTHLY * 3, currency: 'brl', stripeInterval: 'month', intervalCount: 3,
    label: 'trimestral',
    unavailable: 'O plano trimestral ainda não está disponível para contratação.',
    mismatch: 'Plano trimestral temporariamente indisponível. Tente novamente mais tarde.',
  }),
  Object.freeze({
    id: 'semiannual', months: 6, amount: MONTHLY * 6, currency: 'brl', stripeInterval: 'month', intervalCount: 6,
    label: 'semestral',
    unavailable: 'O plano semestral ainda não está disponível para contratação.',
    mismatch: 'Plano semestral temporariamente indisponível. Tente novamente mais tarde.',
  }),
  Object.freeze({
    id: 'year', months: 12, amount: MONTHLY * 12, currency: 'brl', stripeInterval: 'year', intervalCount: 1,
    label: 'anual',
    unavailable: 'O plano anual ainda não está disponível para contratação.',
    mismatch: 'Plano anual temporariamente indisponível. Tente novamente mais tarde.',
  }),
]);

const BY_ID = new Map(INTERVAL_SPECS.map(spec => [spec.id, spec]));

export function intervalSpec(id: BillingInterval): IntervalSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error('unknown billing interval');
  return spec;
}

export function isBillingInterval(value: string): value is BillingInterval {
  return BY_ID.has(value as BillingInterval);
}

/** Id do Price na Stripe. Vazio significa que o operador ainda não criou esse preço. */
export function priceIdFor(config: Config, interval: BillingInterval): string {
  if (interval === 'month') return config.STRIPE_PRICE_PRO;
  if (interval === 'quarter') return config.STRIPE_PRICE_PRO_QUARTERLY;
  if (interval === 'semiannual') return config.STRIPE_PRICE_PRO_SEMIANNUAL;
  return config.STRIPE_PRICE_PRO_ANNUAL;
}

export function proIntervalByPriceId(config: Config, priceId: string): BillingInterval | null {
  if (!priceId) return null;
  for (const spec of INTERVAL_SPECS) {
    const configured = priceIdFor(config, spec.id);
    if (configured && configured === priceId) return spec.id;
  }
  return null;
}

/** O que o site pode mostrar. Nunca inclui o id do Price da Stripe. */
export function publicBillingIntervals(config: Config): Array<{ id: BillingInterval; months: number; amount: number; available: boolean }> {
  return INTERVAL_SPECS.map(spec => ({
    id: spec.id,
    months: spec.months,
    amount: spec.amount,
    available: priceIdFor(config, spec.id).length > 0,
  }));
}

/** O Price recuperado da Stripe tem de ser exatamente o contrato público daquele período. */
export function matchesIntervalPrice(price: StripePrice, expectedId: string, interval: BillingInterval): boolean {
  const spec = intervalSpec(interval);
  return price.id === expectedId && price.active && price.currency.toLowerCase() === spec.currency
    && price.unit_amount === spec.amount && price.type === 'recurring'
    && price.recurring?.interval === spec.stripeInterval && price.recurring.interval_count === spec.intervalCount;
}

const COUPON_CODE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

/** Código compartilhável: maiúsculas, sem espaços. `null` quando o formato não serve. */
export function normalizeCouponCode(raw: string): string | null {
  const code = raw.trim().replace(/\s+/g, '').toUpperCase();
  return COUPON_CODE.test(code) ? code : null;
}

export const COUPON_MESSAGES = Object.freeze({
  invalid: 'Cupom inválido.',
  inactive: 'Este cupom não está mais ativo.',
  expired: 'Este cupom expirou.',
  usedUp: 'Este cupom já atingiu o limite de usos.',
  wrongInterval: 'Este cupom não vale para o período escolhido.',
  tooLarge: 'Este cupom é maior que o valor do período escolhido.',
  badCode: 'Use letras, números e hífen, de 3 a 32 caracteres.',
  badPercent: 'O desconto percentual precisa estar entre 1 e 100.',
  duplicate: 'Já existe um cupom com este código.',
  notFound: 'Cupom não encontrado.',
  alreadyOff: 'Este cupom já está desligado.',
  checkoutBusy: 'Não foi possível iniciar o checkout. Tente novamente.',
});

/** Ordem estável para gravar e comparar. Entrada vazia ou desconhecida vira null. */
export function canonicalIntervals(values: readonly string[]): BillingInterval[] | null {
  const picked = new Set<BillingInterval>();
  for (const value of values) {
    if (!isBillingInterval(value)) return null;
    picked.add(value);
  }
  if (picked.size === 0) return null;
  return BILLING_INTERVALS.filter(id => picked.has(id));
}

export function cheapestAmount(intervals: readonly BillingInterval[]): number {
  return Math.min(...intervals.map(id => intervalSpec(id).amount));
}

/** Id estável do Coupon na Stripe: cabe no limite e sai só do id interno. */
export function stripeCouponIdFor(couponId: string): string {
  return `nxc_${couponId.replaceAll('-', '')}`;
}
