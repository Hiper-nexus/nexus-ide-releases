import { brazilDay } from './activity.js';
import { INTERVAL_SPECS, intervalSpec, isBillingInterval, type BillingInterval } from './billing-catalog.js';
import { CLASSIFIED } from './classified.js';
import { PRO_MONTHLY_PRICE } from './stripe.js';

const DAY_MS = 86_400_000;
const BRAZIL_OFFSET_MS = 3 * 60 * 60 * 1000;
const ENTRIES_LIMIT = 100;
const EVENTS_LIMIT = 50;
/** Janela máxima do 1º ciclo de um cupom `duration: once` (por mês do ciclo); após a 1ª renovação, period_end - resgate passa de ~60 dias/mês. */
const ONCE_CYCLE_DAYS_PER_MONTH = 35;

export const FINANCE_PERIODS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90, '12m': 365 } as const);
export type FinancePeriod = keyof typeof FINANCE_PERIODS;

/** `undefined` (parâmetro ausente) vale o padrão de 30 dias; qualquer outro valor fora da lista é inválido (`null`). */
export function parseFinancePeriod(raw: string | undefined): FinancePeriod | null {
  if (raw === undefined) return '30d';
  return Object.hasOwn(FINANCE_PERIODS, raw) ? raw as FinancePeriod : null;
}

const INTERVAL_LABELS: Record<BillingInterval, string> = { month: 'Mensal', quarter: 'Trimestral', semiannual: 'Semestral', year: 'Anual' };
const WALLET = [
  { key: 'paid', label: 'Assinantes Pagos (Stripe)' },
  { key: 'trial', label: 'Em Teste (Trial)' },
  { key: 'courtesy', label: 'Cortesia / Licença' },
  { key: 'past_due', label: 'Em Atraso (Grace)' },
  { key: 'expired', label: 'Expirados / Inativos' },
] as const;
type WalletKey = typeof WALLET[number]['key'];

const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();
const round1 = (value: number) => Math.round(value * 10) / 10;
const pct = (part: number, whole: number) => whole > 0 ? round1(part / whole * 100) : 0;
const sum = <T>(items: readonly T[], pick: (item: T) => number) => items.reduce((total, item) => total + pick(item), 0);
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`) + BRAZIL_OFFSET_MS;
/** Mesmo corte de brazilDay (UTC-3) para agrupar em SQL. */
const SQL_DAY = (column: string) => `date((${column}-${BRAZIL_OFFSET_MS})/1000,'unixepoch')`;

interface SubscriptionQueryRow {
  id: string; stripe_subscription_id: string; plan: string; billing_interval: string | null; status: string; seats: number;
  current_period_end: number | null; grace_until: number | null; created_at: number; updated_at: number;
  account_id: string | null; customer_email: string | null; customer_name: string | null;
  coupon_code: string | null; coupon_kind: 'percent' | 'amount' | null; coupon_value: number | null;
  coupon_redeemed_at: number | null;
}

/** Uma assinatura já classificada. As cifras do catálogo só existem para Stripe `pro`: team e cortesia valem 0. */
interface Line {
  row: SubscriptionQueryRow;
  source: 'stripe' | 'code_grant';
  interval: BillingInterval | null;
  months: number;
  seats: number;
  catalogAmountCents: number;
  /** Cupom só aparece enquanto o 1º ciclo (o do resgate) não venceu. */
  couponCode: string | null;
  /** MRR bruto do catálogo, antes do cupom. */
  grossMrrCents: number;
  /** MRR recorrente: preço de catálogo (cupom `once` não é recorrente); 0 quando o ciclo vigente é 100% descontado. */
  mrrContributionCents: number;
  discountCents: number;
  netCommitmentCents: number;
  paidActive: boolean;
  pastDue: boolean;
  canceled: boolean;
  courtesyActive: boolean;
}

function classify(row: SubscriptionQueryRow, now: number): Line {
  const source = row.stripe_subscription_id.startsWith('codegrant:') ? 'code_grant' : 'stripe';
  const current = row.current_period_end === null || row.current_period_end > now;
  const seats = Math.max(1, row.seats);
  // Assinatura legada (pré-0008) não guarda o ciclo: preço de tabela mensal, mas continua contada.
  const interval = source === 'stripe' && row.plan === 'pro' ? (row.billing_interval !== null && isBillingInterval(row.billing_interval) ? row.billing_interval : 'month') : null;
  const spec = interval ? intervalSpec(interval) : null;
  const catalogAmountCents = spec ? spec.amount * seats : 0;
  const months = spec?.months ?? 1;
  const grossMrrCents = spec ? Math.round(spec.amount / spec.months * seats) : 0;
  const periodEnd = row.current_period_end ?? now;
  const onceCouponActive = current && row.coupon_redeemed_at !== null
    && row.coupon_redeemed_at <= periodEnd
    && periodEnd - row.coupon_redeemed_at <= months * ONCE_CYCLE_DAYS_PER_MONTH * DAY_MS;
  const couponCode = onceCouponActive ? row.coupon_code : null;
  let discountCents = 0;
  if (onceCouponActive && row.coupon_kind === 'percent' && row.coupon_value !== null) discountCents = Math.round(catalogAmountCents * (row.coupon_value / 100));
  else if (onceCouponActive && row.coupon_kind === 'amount' && row.coupon_value !== null) discountCents = Math.min(catalogAmountCents, row.coupon_value);
  const netCommitmentCents = Math.max(0, catalogAmountCents - discountCents);
  return {
    row, source, interval, seats, months, catalogAmountCents, couponCode, discountCents, grossMrrCents, netCommitmentCents,
    mrrContributionCents: spec && netCommitmentCents > 0 ? grossMrrCents : 0,
    // Teste (trialing) ainda não cobrou e cupom de 100% não gera receita: nenhum dos dois é assinatura paga ativa.
    paidActive: source === 'stripe' && row.status === 'active' && current && (row.plan !== 'pro' || netCommitmentCents > 0),
    pastDue: source === 'stripe' && row.status === 'past_due',
    canceled: source === 'stripe' && ['canceled', 'unpaid', 'incomplete_expired'].includes(row.status),
    courtesyActive: source === 'code_grant' && row.status === 'active' && current,
  };
}

// Posse de uma assinatura por conta: própria ou do time (mesma regra do CLASSIFIED).
const OWNED = "((s.owner_type='account' AND s.account_id=c.id) OR (s.owner_type='team' AND s.team_id IN (SELECT team_id FROM team_members WHERE account_id=c.id)))";
const owns = (condition: string) => `EXISTS(SELECT 1 FROM subscriptions s WHERE ${OWNED} AND ${condition})`;
const STRIPE_SOURCE = "s.stripe_subscription_id NOT GLOB 'codegrant:*'";
const CURRENT = '(s.current_period_end IS NULL OR s.current_period_end>?1)';
// Prioridade por conta (não admin): pago > cortesia > atraso > teste > expirado. Suspensão não cancela cobrança,
// então conta suspensa que paga continua "paga"; sem pagar, suspensa vale inativa.
// Valor de tabela por ciclo (centavos) para detectar cupom que zera a assinatura inteira.
const LATEST_REDEMPTION_ID = '(SELECT r2.id FROM coupon_redemptions r2 WHERE r2.stripe_subscription_id=s.stripe_subscription_id ORDER BY r2.created_at DESC,r2.id LIMIT 1)';
const CATALOG_AMOUNT_SQL = `CASE COALESCE(s.billing_interval,'month') ${INTERVAL_SPECS.map(spec => `WHEN '${spec.id}' THEN ${spec.amount}`).join(' ')} ELSE ${intervalSpec('month').amount} END*max(1,s.seats)`;
const CYCLE_MONTHS_SQL = `CASE COALESCE(s.billing_interval,'month') ${INTERVAL_SPECS.map(spec => `WHEN '${spec.id}' THEN ${spec.months}`).join(' ')} ELSE 1 END`;
const ONCE_CYCLE_ACTIVE_SQL = `${CURRENT} AND r.created_at<=COALESCE(s.current_period_end,?1) AND COALESCE(s.current_period_end,?1)-r.created_at<=(${CYCLE_MONTHS_SQL}*${ONCE_CYCLE_DAYS_PER_MONTH * DAY_MS})`;
const FULLY_DISCOUNTED = `s.plan='pro' AND EXISTS(SELECT 1 FROM coupon_redemptions r JOIN discount_coupons d ON d.id=r.coupon_id WHERE r.id=${LATEST_REDEMPTION_ID} AND ${ONCE_CYCLE_ACTIVE_SQL} AND ((d.kind='percent' AND d.value>=100) OR (d.kind='amount' AND d.value>=${CATALOG_AMOUNT_SQL})))`;
const WALLET_SQL = `${CLASSIFIED}, wallet AS (
    SELECT c.trial_started_at, CASE
      WHEN ${owns(`${STRIPE_SOURCE} AND s.status='active' AND ${CURRENT} AND NOT (${FULLY_DISCOUNTED})`)} THEN 'paid'
      WHEN ${owns(`s.stripe_subscription_id GLOB 'codegrant:*' AND s.status='active' AND ${CURRENT}`)} THEN 'courtesy'
      WHEN ${owns(`${STRIPE_SOURCE} AND s.status='past_due'`)} THEN 'past_due'
      WHEN (c.suspended_at IS NULL AND c.trial_expires_at>?1) OR ${owns(`${STRIPE_SOURCE} AND s.status='trialing' AND ${CURRENT}`)} THEN 'trial'
      ELSE 'expired' END AS kind
    FROM classified c WHERE c.is_admin=0
  ) SELECT count(*) AS total,${WALLET.map(({ key }) => `count(CASE WHEN kind='${key}' THEN 1 END) AS ${key}`).join(',')},
    count(CASE WHEN trial_started_at IS NOT NULL AND kind='paid' THEN 1 END) AS converted_trial,
    count(CASE WHEN trial_started_at IS NOT NULL AND kind<>'trial' THEN 1 END) AS resolved_trial FROM wallet`;

const SUBSCRIPTIONS_SQL = `SELECT s.id,s.stripe_subscription_id,s.plan,s.billing_interval,s.status,s.seats,s.current_period_end,s.grace_until,s.created_at,s.updated_at,
    a.id AS account_id,a.email AS customer_email,a.name AS customer_name,d.code AS coupon_code,d.kind AS coupon_kind,d.value AS coupon_value,r.created_at AS coupon_redeemed_at
  FROM subscriptions s
  LEFT JOIN teams t ON t.id=s.team_id
  LEFT JOIN accounts a ON a.id=COALESCE(s.account_id,t.owner_account_id)
  LEFT JOIN coupon_redemptions r ON r.id=${LATEST_REDEMPTION_ID}
  LEFT JOIN discount_coupons d ON d.id=r.coupon_id
  ORDER BY s.updated_at DESC,s.id ASC`;

const EVENTS_SQL = `SELECT e.event_id,e.type,e.processed_at,e.created_at,json_extract(e.payload,'$.subscription') AS subscription_id,json_extract(e.payload,'$.ignored') AS ignored,a.email AS customer_email
  FROM stripe_events e
  LEFT JOIN subscriptions s ON s.stripe_subscription_id=json_extract(e.payload,'$.subscription')
  LEFT JOIN teams t ON t.id=s.team_id
  LEFT JOIN accounts a ON a.id=COALESCE(s.account_id,t.owner_account_id)
  ORDER BY e.created_at DESC,e.event_id ASC LIMIT ${EVENTS_LIMIT}`;

type DayCounts = Map<string, number>;
const byDay = (rows: ReadonlyArray<{ day: string; n: number }>): DayCounts => new Map(rows.map(row => [row.day, row.n]));

/**
 * Financeiro do admin. Valores em centavos de BRL, calculados pelo catálogo oficial sobre as assinaturas
 * espelhadas no banco (não há ledger de faturas). A janela é de dias corridos no fuso de Brasília, terminando hoje.
 * ponytail: lê todas as linhas de `subscriptions` para classificar em JS (arredondamento por assinatura);
 * com dezenas de milhares de assinaturas, mover as somas para SQL e deixar só o LIMIT 100 das entradas.
 */
export async function buildFinance(db: D1Database, adminEmailsJson: string, period: FinancePeriod, now: number) {
  const days = FINANCE_PERIODS[period];
  const fromDay = brazilDay(now - (days - 1) * DAY_MS), toDay = brazilDay(now);
  const periodStartMs = dayStartMs(fromDay), periodEndMs = periodStartMs + days * DAY_MS;

  const [subscriptions, coupons, events, newAccounts, activeAccounts, wallet, recent] = await Promise.all([
    db.prepare(SUBSCRIPTIONS_SQL).all<SubscriptionQueryRow>(),
    db.prepare('SELECT count(*) AS total,count(CASE WHEN created_at>=?1 THEN 1 END) AS in_period FROM coupon_redemptions').bind(periodStartMs).first<{ total: number; in_period: number }>(),
    db.prepare(`SELECT ${SQL_DAY('created_at')} AS day,count(*) AS n,count(CASE WHEN type='invoice.paid' THEN 1 END) AS paid FROM stripe_events WHERE created_at>=?1 AND created_at<?2 GROUP BY day`).bind(periodStartMs, periodEndMs).all<{ day: string; n: number; paid: number }>(),
    db.prepare(`SELECT ${SQL_DAY('created_at')} AS day,count(*) AS n FROM accounts WHERE role<>'admin' AND created_at>=?1 AND created_at<?2 GROUP BY day`).bind(periodStartMs, periodEndMs).all<{ day: string; n: number }>(),
    db.prepare('SELECT d.day AS day,count(*) AS n FROM account_activity_days d JOIN accounts a ON a.id=d.account_id WHERE a.role<>\'admin\' AND d.day>=?1 AND d.day<=?2 GROUP BY d.day').bind(fromDay, toDay).all<{ day: string; n: number }>(),
    db.prepare(WALLET_SQL).bind(now, adminEmailsJson).first<Record<'total' | WalletKey | 'converted_trial' | 'resolved_trial', number>>(),
    db.prepare(EVENTS_SQL).all<{ event_id: string; type: string; processed_at: number | null; created_at: number; subscription_id: string | null; ignored: string | null; customer_email: string | null }>(),
  ]);

  const lines = subscriptions.results.map(row => classify(row, now));
  const active = lines.filter(line => line.paidActive);
  const pastDue = lines.filter(line => line.pastDue);
  const mrrCents = sum(active, line => line.mrrContributionCents);
  const grossCommitmentCents = sum(active, line => line.catalogAmountCents);
  const netCommitmentCents = sum(active, line => line.netCommitmentCents);
  const estimatedDiscountCents = sum(active, line => line.discountCents);
  // MRR é o catálogo; o desconto `once` só reduz o compromisso líquido do ciclo vigente.
  const grossRecurringMrrCents = sum(active, line => line.grossMrrCents);

  const counts = wallet ?? { total: 0, paid: 0, trial: 0, courtesy: 0, past_due: 0, expired: 0, converted_trial: 0, resolved_trial: 0 };
  const eventDays = new Map(events.results.map(row => [row.day, row]));
  const newDays = byDay(newAccounts.results), activeDays = byDay(activeAccounts.results);
  const createdByDay = new Map<string, Line[]>();
  for (const line of lines) {
    if (line.row.created_at < periodStartMs || line.row.created_at >= periodEndMs) continue;
    const day = brazilDay(line.row.created_at);
    createdByDay.set(day, [...(createdByDay.get(day) ?? []), line]);
  }
  const series = Array.from({ length: days }, (_, offset) => {
    const day = brazilDay(periodStartMs + offset * DAY_MS);
    const created = createdByDay.get(day) ?? [];
    // Só conta quem cobra de fato agora: sem teste, cancelada, em atraso, incompleta ou 100% de cupom.
    const paid = created.filter(line => line.paidActive);
    return {
      day, newSubscriptions: created.length, newPaidSubscriptions: paid.length,
      webhookEvents: eventDays.get(day)?.n ?? 0, invoicePaidEvents: eventDays.get(day)?.paid ?? 0,
      newAccounts: newDays.get(day) ?? 0, activeAccounts: activeDays.get(day) ?? 0,
      estimatedNewMrrCents: sum(paid, line => line.mrrContributionCents),
    };
  });

  const byInterval = INTERVAL_SPECS.map(spec => {
    const mine = active.filter(line => line.interval === spec.id);
    return {
      interval: spec.id, label: INTERVAL_LABELS[spec.id], months: spec.months, catalogPriceCents: spec.amount,
      monthlyEquivalentCents: PRO_MONTHLY_PRICE.unitAmount, activeCount: mine.length, seats: sum(mine, line => line.seats),
      mrrCents: sum(mine, line => line.mrrContributionCents), arrCents: sum(mine, line => line.mrrContributionCents) * 12,
      grossCommitmentCents: sum(mine, line => line.catalogAmountCents), sharePct: 0,
    };
  });
  const countedInterval = sum(byInterval, row => row.activeCount);
  for (const row of byInterval) row.sharePct = mrrCents > 0 ? pct(row.mrrCents, mrrCents) : pct(row.activeCount, countedInterval);

  const entries = lines.slice(0, ENTRIES_LIMIT).map(line => ({
    id: line.row.id, stripeSubscriptionId: line.row.stripe_subscription_id, kind: 'subscription' as const, source: line.source,
    customerEmail: line.row.customer_email?.includes('@') ? line.row.customer_email : null, customerName: line.row.customer_name,
    accountId: line.row.account_id, plan: line.row.plan, interval: line.interval,
    intervalLabel: line.source === 'code_grant' ? 'Cortesia' : line.interval ? INTERVAL_LABELS[line.interval] : 'Equipe',
    status: line.row.status, seats: line.seats, catalogAmountCents: line.catalogAmountCents, mrrContributionCents: line.mrrContributionCents,
    couponCode: line.couponCode, discountCents: line.discountCents, netCommitmentCents: line.netCommitmentCents,
    periodEnd: iso(line.row.current_period_end), graceUntil: iso(line.row.grace_until),
    createdAt: new Date(line.row.created_at).toISOString(), updatedAt: new Date(line.row.updated_at).toISOString(),
  }));

  const webhookEventsInPeriod = sum(events.results, row => row.n);
  const invoicePaidEventsInPeriod = sum(events.results, row => row.paid);
  const couponRedemptionsTotal = coupons?.total ?? 0, couponRedemptionsInPeriod = coupons?.in_period ?? 0;
  const pastDueAtRiskCents = sum(pastDue, line => line.netCommitmentCents);
  const canceledSubscriptions = lines.filter(line => line.canceled).length;

  return {
    currency: 'BRL' as const,
    asOf: new Date(now).toISOString(),
    period: { key: period, days, from: fromDay, to: toDay, timeZone: 'America/Sao_Paulo' as const },
    kpis: {
      mrrCents, arrCents: mrrCents * 12, grossCommitmentCents, netCommitmentCents,
      paidActiveSubscriptions: active.length, paidActiveSeats: sum(active, line => line.seats),
      pastDueSubscriptions: pastDue.length, pastDueAtRiskCents, canceledSubscriptions,
      codeGrantActive: lines.filter(line => line.courtesyActive).length,
      couponRedemptionsTotal, couponRedemptionsInPeriod, estimatedDiscountCents,
      // Só contas que iniciaram teste e já o resolveram; compra direta e teste em aberto ficam fora.
      trialConversionRatePct: pct(counts.converted_trial, counts.resolved_trial),
    },
    byInterval,
    walletBreakdown: WALLET.map(({ key, label }) => ({ key, label, count: counts[key], sharePct: pct(counts[key], counts.total) })),
    series,
    entries,
    recentWebhookEvents: recent.results.map(row => ({
      eventId: row.event_id, type: row.type, subscriptionId: row.subscription_id,
      customerEmail: row.customer_email?.includes('@') ? row.customer_email : null,
      processingStatus: row.processed_at === null ? 'pending' as const : row.ignored !== null ? 'ignored' as const : 'processed' as const,
      ignoredReason: row.ignored, receivedAt: new Date(row.created_at).toISOString(), processedAt: iso(row.processed_at),
    })),
    reportSummary: {
      basisNote: 'Receita recorrente mensal (MRR) calculada pelo catálogo oficial (R$ 59,99/mês equivalente) sobre assinaturas Stripe pagas ativas vigentes; cupons (duration: once) reduzem apenas o compromisso líquido do primeiro ciclo enquanto ele não vence. Eventos invoice.paid refletem confirmações de webhook processadas no banco (sem ledger de valores por fatura).',
      grossRecurringMrrCents, estimatedCouponDiscountCents: estimatedDiscountCents, netRecurringMrrCents: mrrCents,
      projectedArrCents: mrrCents * 12, grossCommitmentCents, netCommitmentCents, pastDueAtRiskCents,
      totalAccounts: counts.total, activeTrialAccounts: counts.trial, paidAccounts: counts.paid, courtesyAccounts: counts.courtesy,
      pastDueAccounts: counts.past_due, canceledSubscriptions, couponRedemptionsTotal, couponRedemptionsInPeriod,
      webhookEventsInPeriod, invoicePaidEventsInPeriod,
    },
  };
}
