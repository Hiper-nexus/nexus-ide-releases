/**
 * Financeiro do /admin/ (GET /v1/admin/finance?period=7d|30d|90d|12m, cloud-api/src/admin-finance.ts). Sem DOM e sem
 * rede: valida o payload, monta a visão que a tela desenha, filtra a tabela e gera a planilha CSV e o relatório JSON.
 * Valor que o servidor não mandou fica null e aparece como "Sem dado"; nada é estimado em silêncio. Sem o endpoint,
 * buildFallbackFinanceView deriva o que dá do resumo de contas e da medição do app e marca o resultado como estimativa.
 */
import { INTERVALS, offersFromBilling } from './checkout-offer.js';

export const FINANCE_PERIODS = Object.freeze(['7d', '30d', '90d', '12m']);
export const DEFAULT_PERIOD = '30d';
export const PERIOD_LABELS = Object.freeze({ '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias', '90d': 'Últimos 90 dias', '12m': 'Últimos 12 meses' });
export const FINANCE_FILTERS = Object.freeze(['all', 'paid', 'past_due', 'courtesy', 'canceled', 'webhooks']);
export const MISSING = 'Sem dado';

// Cores de categoria dos quatro ciclos: as mesmas na barra segmentada, na lista e no CSV não importam, só na tela.
const INTERVAL_COLORS = { month: '#ff4f8b', quarter: '#38bdf8', semiannual: '#a855f7', year: '#30d158' };
// O catálogo é o preço mensal vezes os meses (checkout-offer.js): a tela nunca fixa preço no HTML.
const CATALOG = offersFromBilling(null).map(({ id, label, months, amount }) => ({ id, label, months, priceCents: amount, color: INTERVAL_COLORS[id] }));
const INTERVAL_IDS = new Set(INTERVALS.map(spec => spec.id));
const INTERVAL_LABEL = Object.fromEntries(CATALOG.map(spec => [spec.id, spec.label]));
const MONTHLY_CENTS = CATALOG[0].priceCents;

export const WALLET_SEGMENTS = Object.freeze([
  Object.freeze({ key: 'paid', label: 'Assinantes Pagos', color: '#7ee2a8' }),
  Object.freeze({ key: 'trial', label: 'Em Teste (Trial)', color: '#f5b942' }),
  Object.freeze({ key: 'courtesy', label: 'Cortesia / Licença', color: '#8ab4ff' }),
  Object.freeze({ key: 'pastDue', label: 'Em Atraso', color: '#ff4f8b' }),
  Object.freeze({ key: 'expired', label: 'Expirados', color: '#928b90' }),
]);

const CENT_KPIS = ['mrrCents', 'arrCents', 'grossCommitmentCents', 'netCommitmentCents', 'pastDueAtRiskCents', 'estimatedDiscountCents'];
const COUNT_KPIS = ['paidActiveSubscriptions', 'paidActiveSeats', 'pastDueSubscriptions', 'canceledSubscriptions', 'couponRedemptionsTotal', 'codeGrantActive'];
// Série diária no fuso de Brasília; flows por dia (o servidor não manda o MRR total por dia).
const SERIES_FIELDS = ['estimatedNewMrrCents', 'newSubscriptions', 'newPaidSubscriptions', 'webhookEvents', 'invoicePaidEvents', 'newAccounts', 'activeAccounts'];
// Nome no payload → nome na tela.
const ENTRY_CENTS = { catalogAmountCents: 'grossCents', discountCents: 'discountCents', netCommitmentCents: 'netCents', mrrContributionCents: 'mrrCents' };
const WEBHOOK_STATUSES = new Set(['processed', 'ignored', 'pending']);
export const ENTRY_STATUS_LABELS = Object.freeze({
  active: 'Ativa', trialing: 'Em teste', past_due: 'Em atraso', unpaid: 'Não paga', canceled: 'Cancelada',
  incomplete: 'Incompleta', incomplete_expired: 'Expirada', paused: 'Pausada',
});
export const WEBHOOK_STATUS_LABELS = Object.freeze({ processed: 'Processado', ignored: 'Ignorado', pending: 'Pendente' });
const SOURCE_LABELS = { stripe: 'Stripe', code_grant: 'Código de cortesia' };
const WALLET_KEYS = { paid: 'paid', trial: 'trial', courtesy: 'courtesy', past_due: 'pastDue', expired: 'expired' };
const MAX_ROWS = 500;
const EVENT_TYPE = /^[a-z0-9_.]{1,80}$/;
const SOURCE = /^[a-z_]{1,32}$/;
const STATUS = /^[a-z_]{1,32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const compactMoney = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
const number = new Intl.NumberFormat('pt-BR');
const shortDate = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short' });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const text = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);

/** Lê um campo opcional: ausente ou null vira null; presente com tipo errado invalida o payload. */
function optional(value, check) {
  if (value === undefined || value === null) return { ok: true, value: null };
  return check(value) ? { ok: true, value } : { ok: false };
}

function pick(source, keys, check) {
  const out = {};
  for (const key of keys) {
    const read = optional(source?.[key], check);
    if (!read.ok) return null;
    out[key] = read.value;
  }
  return out;
}

export function formatBrlCents(cents) { return isCount(cents) ? money.format(cents / 100) : MISSING; }
export function formatCompactBrl(cents) { return isCount(cents) ? compactMoney.format(cents / 100) : MISSING; }
export function formatCount(value) { return isCount(value) ? number.format(value) : MISSING; }
export function formatPct(value) { return Number.isFinite(value) ? `${value.toFixed(1).replace('.', ',')}%` : MISSING; }
export function formatShortDate(value) { return isDate(value) ? shortDate.format(new Date(value)) : MISSING; }
export const intervalLabel = id => INTERVAL_LABEL[id] ?? 'Sem ciclo';
export const sourceLabel = source => SOURCE_LABELS[source] ?? 'Outra origem';
export const entryStatusLabel = (status, lapsed = false) => (lapsed ? 'Vencida' : ENTRY_STATUS_LABELS[status] ?? status);

/** Ativa no Stripe mas com a vigência já passada: o servidor não conta como paga ativa (admin-finance.ts, paidActive). */
export const isLapsed = (entry, now = Date.now()) => (entry.status === 'active' || entry.status === 'trialing')
  && entry.currentPeriodEnd !== null && Date.parse(entry.currentPeriodEnd) <= now;

/** Em qual aba da tabela a linha aparece; as mesmas regras do servidor (cortesia = codegrant, cancelada inclui unpaid). */
export function entryKind(entry, now = Date.now()) {
  if (entry.source !== null && entry.source !== 'stripe') return 'courtesy';
  if (entry.status === 'past_due') return 'past_due';
  if (['canceled', 'unpaid', 'incomplete_expired'].includes(entry.status) || isLapsed(entry, now)) return 'canceled';
  if (entry.status === 'trialing') return 'trial';
  // Cupom de 100% (líquido zero sobre valor de tabela) não cobra: o servidor não conta como paga (paidActive).
  if (entry.status === 'active') return entry.netCents === 0 && entry.grossCents > 0 ? 'other' : 'paid';
  return 'other';
}

const textOf = max => value => text(value, max) !== null;

function parseEntry(row) {
  if (!isObject(row) || !textOf(255)(row.id) || row.id === '' || typeof row.status !== 'string' || !STATUS.test(row.status)) return null;
  const reads = {
    email: optional(row.customerEmail, textOf(320)), name: optional(row.customerName, textOf(200)),
    subscriptionId: optional(row.stripeSubscriptionId, textOf(255)), accountId: optional(row.accountId, textOf(255)),
    interval: optional(row.interval, value => INTERVAL_IDS.has(value)), intervalLabel: optional(row.intervalLabel, textOf(24)),
    source: optional(row.source, value => SOURCE.test(value)), couponCode: optional(row.couponCode, textOf(40)), seats: optional(row.seats, isCount),
    currentPeriodEnd: optional(row.periodEnd, isDate), graceUntil: optional(row.graceUntil, isDate), updatedAt: optional(row.updatedAt, isDate),
  };
  const cents = pick(row, Object.keys(ENTRY_CENTS), isCount);
  if (!Object.values(reads).every(read => read.ok) || !cents) return null;
  const entry = { id: row.id, status: row.status, ...Object.fromEntries(Object.entries(reads).map(([key, read]) => [key, read.value])) };
  for (const [from, to] of Object.entries(ENTRY_CENTS)) entry[to] = cents[from];
  entry.subscriptionId ??= row.id;
  return { ...entry, lapsed: entry.source !== 'code_grant' && isLapsed(entry), kind: entryKind(entry) };
}

function parseWebhook(row) {
  if (!isObject(row) || !textOf(255)(row.eventId) || row.eventId === '') return null;
  if (typeof row.type !== 'string' || !EVENT_TYPE.test(row.type) || !isDate(row.receivedAt) || !WEBHOOK_STATUSES.has(row.processingStatus)) return null;
  const customer = optional(row.customerEmail, textOf(320)), subscription = optional(row.subscriptionId, textOf(255)), reason = optional(row.ignoredReason, textOf(200));
  if (!customer.ok || !subscription.ok || !reason.ok) return null;
  return { eventId: row.eventId, type: row.type, status: row.processingStatus, createdAt: row.receivedAt, customerEmail: customer.value, subscriptionId: subscription.value, ignoredReason: reason.value };
}

/** Série diária. O dia já vem no fuso de Brasília (AAAA-MM-DD): o rótulo sai do texto, sem converter fuso. */
function parseSeries(rows) {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows) || rows.length > 400) return null;
  const out = [];
  let cumulative = 0;
  for (const row of rows) {
    if (!isObject(row) || typeof row.day !== 'string' || !DAY.test(row.day)) return null;
    const values = pick(row, SERIES_FIELDS, isCount);
    if (!values) return null;
    cumulative += values.estimatedNewMrrCents ?? 0;
    const [, month, day] = row.day.split('-');
    out.push({ day: row.day, label: `${day}/${month}`, ...values, cumulativeNewMrrCents: cumulative });
  }
  return out;
}

function parseRows(rows, parse) {
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return null;
  const out = rows.map(parse);
  return out.every(Boolean) ? out : null;
}

function intervalsView(byInterval) {
  const known = Array.isArray(byInterval);
  const totalMrr = known ? byInterval.reduce((sum, row) => sum + (row.mrrCents ?? 0), 0) : 0;
  return CATALOG.map(spec => {
    const row = known ? byInterval.find(item => item.interval === spec.id) : undefined;
    const subscriptions = known ? row?.subscriptions ?? 0 : null, mrrCents = known ? row?.mrrCents ?? 0 : null;
    // O servidor manda a fatia pronta (por MRR, ou por contagem quando o MRR é zero); sem ela, divide pelo MRR.
    const share = !known ? 0 : row?.share ?? (totalMrr > 0 ? mrrCents / totalMrr : 0);
    return { ...spec, subscriptions, mrrCents, share };
  });
}

function parseIntervals(rows) {
  if (rows === undefined || rows === null) return null;
  if (!Array.isArray(rows)) return undefined;
  const out = [];
  for (const row of rows) {
    if (!isObject(row) || !INTERVAL_IDS.has(row.interval) || out.some(item => item.interval === row.interval)) return undefined;
    if (!isCount(row.activeCount) || !isCount(row.mrrCents)) return undefined;
    const share = Number.isFinite(row.sharePct) && row.sharePct >= 0 && row.sharePct <= 100 ? row.sharePct / 100 : null;
    out.push({ interval: row.interval, subscriptions: row.activeCount, mrrCents: row.mrrCents, share });
  }
  return out;
}

/** walletBreakdown: [{ key, count }]. Chave desconhecida ou contagem inválida invalida; ausente vira "Sem dado". */
function parseWallet(rows) {
  if (rows === undefined || rows === null) return {};
  if (!Array.isArray(rows)) return null;
  const out = {};
  for (const row of rows) {
    if (!isObject(row) || !Object.hasOwn(WALLET_KEYS, row.key) || !isCount(row.count)) return null;
    out[WALLET_KEYS[row.key]] = row.count;
  }
  return out;
}

function walletView(wallet) {
  const values = WALLET_SEGMENTS.map(segment => ({ ...segment, value: wallet?.[segment.key] ?? null }));
  const total = values.reduce((sum, segment) => sum + (segment.value ?? 0), 0);
  return { segments: values.map(segment => ({ ...segment, share: total > 0 && segment.value !== null ? segment.value / total : 0 })), total };
}

/** Linhas do demonstrativo (DRE simplificado), as mesmas na tela e no relatório JSON. */
export function statementLines(view) {
  const { kpis, report } = view;
  return [
    { key: 'gross', sign: '(+)', label: 'Compromisso Bruto Contratado', kind: 'money', value: kpis.grossCommitmentCents },
    { key: 'discount', sign: '(−)', label: 'Descontos de Cupons Estimados', kind: 'discount', value: kpis.estimatedDiscountCents },
    { key: 'net', sign: '(=)', label: 'Compromisso Líquido Vigente', kind: 'total', value: kpis.netCommitmentCents },
    { key: 'mrr', sign: '', label: 'Receita Recorrente Mensal (MRR)', kind: 'money', value: kpis.mrrCents },
    { key: 'arr', sign: '', label: 'Receita Recorrente Anual Projetada (ARR)', kind: 'money', value: kpis.arrCents },
    { key: 'risk', sign: '', label: 'Valor em Risco (Inadimplência / Past Due)', kind: 'risk', value: kpis.pastDueAtRiskCents },
    { key: 'paidEvents', sign: '', label: 'Eventos de Pagamento (invoice.paid)', kind: 'count', value: report.invoicePaidEventsInPeriod },
    { key: 'conversion', sign: '', label: 'Taxa de Conversão Trial → Pago', kind: 'pct', value: kpis.trialConversionRatePct },
  ];
}

export function statementValue(line) {
  if (line.kind === 'count') return line.value === null ? MISSING : `${formatCount(line.value)} no período`;
  if (line.kind === 'pct') return formatPct(line.value);
  if (line.kind === 'discount') return isCount(line.value) && line.value > 0 ? `- ${formatBrlCents(line.value)}` : formatBrlCents(line.value);
  return formatBrlCents(line.value);
}

/**
 * Valida GET /v1/admin/finance. Estrutura fora do contrato devolve null (a tela cai no fallback e diz por quê).
 * Obrigatórios: período conhecido e kpis.mrrCents. O resto é opcional e, ausente, vira "Sem dado" ou lista vazia.
 */
export function parseFinancePayload(data) {
  if (!isObject(data) || !isObject(data.kpis)) return null;
  const key = isObject(data.period) ? data.period.key : data.period;
  if (!FINANCE_PERIODS.includes(key) || !isCount(data.kpis.mrrCents)) return null;
  const cents = pick(data.kpis, CENT_KPIS, isCount), counts = pick(data.kpis, COUNT_KPIS, isCount);
  const conversion = optional(data.kpis.trialConversionRatePct, value => Number.isFinite(value) && value >= 0 && value <= 100);
  const wallet = parseWallet(data.walletBreakdown);
  const intervals = parseIntervals(data.byInterval), series = parseSeries(data.series);
  const entries = parseRows(data.entries, parseEntry), webhooks = parseRows(data.recentWebhookEvents, parseWebhook);
  const summary = isObject(data.reportSummary) ? data.reportSummary : {};
  const paidEvents = optional(summary.invoicePaidEventsInPeriod, isCount), note = optional(summary.basisNote, value => text(value, 600) !== null);
  if (!cents || !counts || !conversion.ok || !wallet || intervals === undefined || !series || !entries || !webhooks || !paidEvents.ok || !note.ok) return null;
  const day = value => (typeof value === 'string' && DAY.test(value) ? value : null);
  const from = isObject(data.period) ? day(data.period.from) : null, to = isObject(data.period) ? day(data.period.to) : null;
  return {
    source: 'server', notice: null, generatedAt: isDate(data.asOf) ? data.asOf : null,
    period: { key, label: PERIOD_LABELS[key], from, to },
    kpis: { ...cents, ...counts, trialConversionRatePct: conversion.value },
    intervals: intervalsView(intervals), wallet: walletView(wallet), series, entries, webhooks,
    report: { invoicePaidEventsInPeriod: paidEvents.value, basisNote: note.value ?? 'Valores calculados pelo servidor a partir das assinaturas e eventos da Stripe registrados no banco.' },
  };
}

/**
 * Sem /v1/admin/finance (deploy em transição, 404 ou erro), deriva o que dá do resumo de contas (/v1/admin/overview),
 * da medição do app (/v1/admin/activity), dos cupons e dos códigos já consultados. O MRR sai do preço de catálogo vezes
 * as assinaturas Stripe ativas, antes de cupons, e a tela diz isso; o que não tem fonte fica null.
 */
export function buildFallbackFinanceView(overview, activity, { coupons = null, codes = null, period = DEFAULT_PERIOD, reason = '' } = {}) {
  const key = FINANCE_PERIODS.includes(period) ? period : DEFAULT_PERIOD;
  const paid = isCount(activity?.paidAccounts) ? activity.paidAccounts : null;
  const count = name => (isCount(overview?.[name]) ? overview[name] : null);
  const active = count('active');
  const mrrCents = paid === null ? null : paid * MONTHLY_CENTS;
  const sumUses = list => (Array.isArray(list) ? list.reduce((sum, item) => sum + (isCount(item?.uses) ? item.uses : 0), 0) : null);
  const why = reason ? ` (${reason})` : '';
  return {
    source: 'fallback',
    notice: `O relatório financeiro do servidor não respondeu${why}. Estes números saem do resumo de contas, da medição do app, dos cupons e dos códigos; o MRR é estimado pelo preço de catálogo antes de cupons. Campos sem fonte aparecem como "${MISSING}".`,
    generatedAt: null,
    period: { key, label: PERIOD_LABELS[key], from: null, to: null },
    kpis: {
      mrrCents, arrCents: mrrCents === null ? null : mrrCents * 12, grossCommitmentCents: null, netCommitmentCents: null,
      pastDueAtRiskCents: null, estimatedDiscountCents: null, paidActiveSubscriptions: paid, paidActiveSeats: null,
      pastDueSubscriptions: null, canceledSubscriptions: null, couponRedemptionsTotal: sumUses(coupons), codeGrantActive: sumUses(codes),
      trialConversionRatePct: null,
    },
    intervals: intervalsView(null),
    wallet: walletView({
      paid, trial: count('trial'), courtesy: paid === null || active === null ? null : Math.max(0, active - paid),
      pastDue: null, expired: count('expired'),
    }),
    series: [], entries: [], webhooks: [],
    report: { invoicePaidEventsInPeriod: null, basisNote: 'Estimativa local: assinaturas Stripe ativas vezes o preço mensal de catálogo, sem cupons. Cortesia é acesso Pro sem cobrança Stripe ativa. Atraso, cancelamentos e eventos de pagamento dependem do relatório do servidor.' },
  };
}

const needle = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Linhas da tabela para a aba e a busca. A aba de webhooks troca o conjunto: eventos em vez de assinaturas. */
export function filterFinanceRows(view, { filter = 'all', query = '' } = {}) {
  const term = needle(query).trim();
  if (filter === 'webhooks') {
    return view.webhooks.filter(event => !term || [event.eventId, event.type, event.customerEmail, event.subscriptionId].some(field => needle(field).includes(term)));
  }
  return view.entries.filter(entry => (filter === 'all' || entry.kind === filter)
    && (!term || [entry.name, entry.email, entry.couponCode, entry.subscriptionId, entry.id].some(field => needle(field).includes(term))));
}

export function financeFilterCounts(view) {
  const counts = { all: view.entries.length, paid: 0, past_due: 0, courtesy: 0, canceled: 0, webhooks: view.webhooks.length };
  for (const entry of view.entries) if (Object.hasOwn(counts, entry.kind) && entry.kind !== 'all') counts[entry.kind]++;
  return counts;
}

export function financeTotals(rows) {
  const sum = key => rows.reduce((total, row) => total + (isCount(row[key]) ? row[key] : 0), 0);
  return { grossCents: sum('grossCents'), netCents: sum('netCents'), mrrCents: sum('mrrCents') };
}

/** Somas do período para o rodapé do gráfico (só os fluxos; contas ativas por dia não somam). */
export function seriesTotals(series) {
  const sum = field => series.reduce((total, point) => total + (point[field] ?? 0), 0);
  return Object.fromEntries(['estimatedNewMrrCents', 'newSubscriptions', 'newPaidSubscriptions', 'webhookEvents', 'invoicePaidEvents', 'newAccounts'].map(field => [field, sum(field)]));
}

// Planilha: ";" e vírgula decimal, como o Excel em português abre com dois cliques. BOM para os acentos.
const CSV_SEPARATOR = ';';
const csvMoney = cents => (isCount(cents) ? (cents / 100).toFixed(2).replace('.', ',') : '');

/** Célula de texto segura: fórmula vira texto ('=, +, -, @, tab, CR no início) e aspas são escapadas. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let cell = String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[";\n\r,]/.test(cell) || cell !== cell.trim() ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function financeCsv(view) {
  const header = ['Cliente', 'E-mail', 'Origem', 'Ciclo', 'Status', 'Bruto (R$)', 'Cupom', 'Desconto (R$)', 'Líquido (R$)', 'MRR (R$)', 'Vigência até', 'Atualizado em', 'Assinatura', 'Período'];
  const rows = view.entries.map(entry => [
    csvCell(entry.name), csvCell(entry.email), csvCell(sourceLabel(entry.source)), csvCell(entry.intervalLabel ?? (entry.interval ? intervalLabel(entry.interval) : '')),
    csvCell(entryStatusLabel(entry.status, entry.lapsed)), csvMoney(entry.grossCents), csvCell(entry.couponCode), csvMoney(entry.discountCents),
    csvMoney(entry.netCents), csvMoney(entry.mrrCents), csvCell(entry.currentPeriodEnd), csvCell(entry.updatedAt), csvCell(entry.subscriptionId), csvCell(view.period.key),
  ].join(CSV_SEPARATOR));
  return `﻿${[header.map(csvCell).join(CSV_SEPARATOR), ...rows].join('\r\n')}\r\n`;
}

/** Relatório completo para arquivar: o mesmo conteúdo da tela, com a origem dos números declarada. */
export function financeReport(view, generatedAt = new Date().toISOString()) {
  return {
    title: 'Nexus Cloud · Demonstrativo financeiro', generatedAt, source: view.source, notice: view.notice,
    period: view.period, currency: 'BRL', amountsIn: 'centavos', kpis: view.kpis,
    statement: statementLines(view).map(({ key, sign, label, kind, value }) => ({ key, sign, label, kind, value })),
    intervals: view.intervals.map(({ id, label, months, priceCents, subscriptions, mrrCents }) => ({ id, label, months, priceCents, subscriptions, mrrCents })),
    wallet: view.wallet.segments.map(({ key, label, value }) => ({ key, label, value })),
    series: view.series, subscriptions: view.entries.map(({ kind, ...entry }) => ({ ...entry, tab: kind })), webhooks: view.webhooks,
    basisNote: view.report.basisNote,
  };
}

export function financeFileName(view, extension, now = new Date()) {
  return `nexus-financeiro-${view.period.key}-${now.toISOString().slice(0, 10)}.${extension}`;
}

/** Iniciais do avatar: primeira e última palavra do nome, ou o começo do e-mail. */
export function initialsOf(name, email) {
  const words = String(name ?? '').trim().split(/\s+/).filter(word => /\p{L}|\d/u.test(word));
  if (words.length) return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words.at(-1)[0]).toLocaleUpperCase('pt-BR');
  const local = String(email ?? '').split('@')[0].replace(/[^\p{L}\d]/gu, '');
  return local ? local.slice(0, 2).toLocaleUpperCase('pt-BR') : '?';
}

/** Tom estável do avatar (0..5) a partir do id: a mesma pessoa tem a mesma cor em todas as tabelas. */
export function avatarTone(seed) {
  let hash = 0;
  for (const char of String(seed ?? '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 6;
}
