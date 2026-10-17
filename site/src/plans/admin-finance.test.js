import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERIOD, MISSING, avatarTone, buildFallbackFinanceView, csvCell, entryKind, filterFinanceRows, financeCsv, financeFileName,
  financeFilterCounts, financeReport, financeTotals, formatBrlCents, formatPct, initialsOf, parseFinancePayload,
  seriesTotals, statementLines, statementValue,
} from './admin-finance.js';
import {
  ICONS, donutArcs, icon, monotonePath, niceMax, renderRevenueAreaChart, renderStackedBar, renderWalletDonutChart,
  revenueGeometry, sparklinePath,
} from '../admin-charts.js';

const NBSP = / /g;
const brl = cents => formatBrlCents(cents).replace(NBSP, ' ');

// Formato de cloud-api/src/admin-finance.ts (buildFinance), com valores de exemplo.
function payload(overrides = {}) {
  return {
    currency: 'BRL', asOf: '2026-10-15T12:00:00.000Z',
    period: { key: '30d', days: 30, from: '2026-09-16', to: '2026-10-15', timeZone: 'America/Sao_Paulo' },
    kpis: {
      mrrCents: 23996, arrCents: 287952, grossCommitmentCents: 113962, netCommitmentCents: 107963, paidActiveSubscriptions: 4,
      paidActiveSeats: 4, pastDueSubscriptions: 1, pastDueAtRiskCents: 5999, canceledSubscriptions: 2, codeGrantActive: 2,
      couponRedemptionsTotal: 3, couponRedemptionsInPeriod: 1, estimatedDiscountCents: 5999, trialConversionRatePct: 12.5,
    },
    byInterval: [
      { interval: 'month', label: 'Mensal', months: 1, catalogPriceCents: 5999, monthlyEquivalentCents: 5999, activeCount: 2, seats: 2, mrrCents: 11998, arrCents: 143976, grossCommitmentCents: 11998, sharePct: 50 },
      { interval: 'quarter', label: 'Trimestral', months: 3, catalogPriceCents: 17997, monthlyEquivalentCents: 5999, activeCount: 0, seats: 0, mrrCents: 0, arrCents: 0, grossCommitmentCents: 0, sharePct: 0 },
      { interval: 'semiannual', label: 'Semestral', months: 6, catalogPriceCents: 35994, monthlyEquivalentCents: 5999, activeCount: 0, seats: 0, mrrCents: 0, arrCents: 0, grossCommitmentCents: 0, sharePct: 0 },
      { interval: 'year', label: 'Anual', months: 12, catalogPriceCents: 71988, monthlyEquivalentCents: 5999, activeCount: 2, seats: 2, mrrCents: 11998, arrCents: 143976, grossCommitmentCents: 143976, sharePct: 50 },
    ],
    walletBreakdown: [
      { key: 'paid', label: 'Assinantes Pagos (Stripe)', count: 4, sharePct: 19 }, { key: 'trial', label: 'Em Teste (Trial)', count: 9, sharePct: 42.9 },
      { key: 'courtesy', label: 'Cortesia / Licença', count: 2, sharePct: 9.5 }, { key: 'past_due', label: 'Em Atraso (Grace)', count: 1, sharePct: 4.8 },
      { key: 'expired', label: 'Expirados / Inativos', count: 5, sharePct: 23.8 },
    ],
    series: [
      { day: '2026-10-14', newSubscriptions: 1, newPaidSubscriptions: 1, webhookEvents: 2, invoicePaidEvents: 1, newAccounts: 3, activeAccounts: 7, estimatedNewMrrCents: 5999 },
      { day: '2026-10-15', newSubscriptions: 2, newPaidSubscriptions: 1, webhookEvents: 5, invoicePaidEvents: 2, newAccounts: 1, activeAccounts: 9, estimatedNewMrrCents: 1500 },
    ],
    entries: [
      { id: 'row_1', stripeSubscriptionId: 'sub_1Q8xMarina', kind: 'subscription', source: 'stripe', customerEmail: 'marina@exemplo.com.br', customerName: 'Marina Duarte', accountId: 'acc_1', plan: 'pro', interval: 'month', intervalLabel: 'Mensal', status: 'active', seats: 1, catalogAmountCents: 5999, mrrContributionCents: 5999, couponCode: 'PARCEIRO10', discountCents: 600, netCommitmentCents: 5399, periodEnd: '2026-11-02T00:00:00.000Z', graceUntil: null, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' },
      { id: 'row_2', stripeSubscriptionId: 'sub_1Q8xCaio', kind: 'subscription', source: 'stripe', customerEmail: 'caio.lins@exemplo.com', customerName: null, accountId: 'acc_2', plan: 'pro', interval: 'year', intervalLabel: 'Anual', status: 'past_due', seats: 1, catalogAmountCents: 71988, mrrContributionCents: 5999, couponCode: null, discountCents: 0, netCommitmentCents: 71988, periodEnd: null, graceUntil: '2026-10-20T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' },
      { id: 'row_3', stripeSubscriptionId: 'codegrant:7KQ2', kind: 'subscription', source: 'code_grant', customerEmail: 'julia@exemplo.com', customerName: 'Júlia Assunção', accountId: 'acc_3', plan: 'pro', interval: null, intervalLabel: 'Cortesia', status: 'active', seats: 1, catalogAmountCents: 0, mrrContributionCents: 0, couponCode: null, discountCents: 0, netCommitmentCents: 0, periodEnd: null, graceUntil: null, createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' },
      { id: 'row_4', stripeSubscriptionId: 'sub_1Q8xOtavio', kind: 'subscription', source: 'stripe', customerEmail: 'otavio@exemplo.com', customerName: 'Otávio Reis', accountId: null, plan: 'pro', interval: 'quarter', intervalLabel: 'Trimestral', status: 'unpaid', seats: 1, catalogAmountCents: 17997, mrrContributionCents: 5999, couponCode: null, discountCents: 0, netCommitmentCents: 17997, periodEnd: null, graceUntil: null, createdAt: '2026-05-02T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' },
    ],
    recentWebhookEvents: [
      { eventId: 'evt_1', type: 'invoice.paid', subscriptionId: 'sub_1Q8xMarina', customerEmail: 'marina@exemplo.com.br', processingStatus: 'processed', ignoredReason: null, receivedAt: '2026-10-14T10:00:00.000Z', processedAt: '2026-10-14T10:00:01.000Z' },
      { eventId: 'evt_2', type: 'customer.subscription.updated', subscriptionId: null, customerEmail: null, processingStatus: 'pending', ignoredReason: null, receivedAt: '2026-10-14T11:00:00.000Z', processedAt: null },
    ],
    reportSummary: { basisNote: 'Compromisso pelo preço de catálogo menos cupons.', invoicePaidEventsInPeriod: 3, webhookEventsInPeriod: 7, netRecurringMrrCents: 23396 },
    ...overrides,
  };
}

test('formatação em reais, contagem e percentual; sem valor vira "Sem dado"', () => {
  assert.equal(brl(5999), 'R$ 59,99');
  assert.equal(brl(71988), 'R$ 719,88');
  assert.equal(formatBrlCents(null), MISSING);
  assert.equal(formatBrlCents(-1), MISSING);
  assert.equal(formatPct(12.5), '12,5%');
  assert.equal(formatPct(null), MISSING);
});

test('parseFinancePayload aceita o contrato e monta ciclos, carteira, tabela e eventos', () => {
  const view = parseFinancePayload(payload());
  assert.ok(view);
  assert.equal(view.source, 'server');
  assert.equal(view.period.key, '30d');
  assert.equal(view.period.label, 'Últimos 30 dias');
  assert.equal(view.kpis.mrrCents, 23996);
  assert.equal(view.kpis.trialConversionRatePct, 12.5);
  // os quatro ciclos sempre aparecem, com o preço de catálogo; ciclo ausente no payload é zero, não "sem dado"
  assert.deepEqual(view.intervals.map(row => [row.id, row.priceCents, row.subscriptions]), [['month', 5999, 2], ['quarter', 17997, 0], ['semiannual', 35994, 0], ['year', 71988, 2]]);
  assert.deepEqual(view.intervals.map(row => row.color), ['#ff4f8b', '#38bdf8', '#a855f7', '#30d158']);
  assert.equal(view.intervals[0].share, 0.5);
  assert.equal(view.generatedAt, '2026-10-15T12:00:00.000Z');
  assert.deepEqual([view.period.from, view.period.to], ['2026-09-16', '2026-10-15']);
  assert.equal(view.wallet.total, 21);
  assert.deepEqual(view.wallet.segments.map(segment => [segment.key, segment.value]), [['paid', 4], ['trial', 9], ['courtesy', 2], ['pastDue', 1], ['expired', 5]]);
  // abas com as regras do servidor: codegrant é cortesia, unpaid conta como cancelada
  assert.deepEqual(view.entries.map(entry => entry.kind), ['paid', 'past_due', 'courtesy', 'canceled']);
  assert.deepEqual(view.entries.map(entry => [entry.subscriptionId, entry.grossCents, entry.netCents, entry.mrrCents]).slice(0, 2), [['sub_1Q8xMarina', 5999, 5399, 5999], ['sub_1Q8xCaio', 71988, 71988, 5999]]);
  assert.equal(view.entries[0].name, 'Marina Duarte');
  // ativa no Stripe com a vigência vencida: fora de "Pagos Ativos", como no servidor
  const lapsed = parseFinancePayload(payload({ entries: [{ ...payload().entries[0], periodEnd: '2020-01-01T00:00:00.000Z' }] })).entries[0];
  assert.deepEqual([lapsed.lapsed, lapsed.kind], [true, 'canceled']);
  assert.equal(view.entries[0].currentPeriodEnd, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(view.webhooks.map(event => [event.status, event.createdAt]), [['processed', '2026-10-14T10:00:00.000Z'], ['pending', '2026-10-14T11:00:00.000Z']]);
  // série diária: rótulo do próprio dia (sem converter fuso) e MRR novo acumulado no período
  assert.deepEqual(view.series.map(point => [point.label, point.cumulativeNewMrrCents]), [['14/10', 5999], ['15/10', 7499]]);
  assert.equal(view.report.invoicePaidEventsInPeriod, 3);
});

test('parseFinancePayload aceita o período como texto e listas ausentes', () => {
  const view = parseFinancePayload({ period: '12m', kpis: { mrrCents: 0 } });
  assert.ok(view);
  assert.equal(view.period.key, '12m');
  assert.deepEqual([view.entries, view.webhooks, view.series], [[], [], []]);
  assert.equal(view.kpis.arrCents, null);
  assert.equal(view.intervals.every(row => row.subscriptions === null), true, 'sem byInterval, a contagem é desconhecida');
  assert.equal(view.wallet.total, 0);
});

test('parseFinancePayload recusa o que está fora do contrato, para a tela cair no fallback', () => {
  const broken = [
    null, [], {}, { period: '30d' }, { period: '1y', kpis: { mrrCents: 1 } }, payload({ kpis: { mrrCents: '10' } }),
    payload({ kpis: { ...payload().kpis, arrCents: -5 } }), payload({ kpis: { ...payload().kpis, trialConversionRatePct: 140 } }),
    payload({ byInterval: [{ interval: 'week', activeCount: 1, mrrCents: 1 }] }),
    payload({ byInterval: [{ interval: 'month', activeCount: 1, mrrCents: 1 }, { interval: 'month', activeCount: 1, mrrCents: 1 }] }),
    payload({ entries: [{ id: 'row_x', status: '<img onerror>' }] }),
    payload({ entries: [{ id: 'row_x', status: 'active', customerEmail: 42 }] }),
    payload({ entries: [{ id: 'row_x', status: 'active', catalogAmountCents: -1 }] }),
    payload({ recentWebhookEvents: [{ eventId: 'evt', type: '<script>', processingStatus: 'processed', receivedAt: '2026-10-14T10:00:00.000Z' }] }),
    payload({ recentWebhookEvents: [{ eventId: 'evt', type: 'invoice.paid', processingStatus: 'hacked', receivedAt: '2026-10-14T10:00:00.000Z' }] }),
    payload({ series: [{ day: 'ontem' }] }), payload({ walletBreakdown: [{ key: 'paid', count: 1.5 }] }), payload({ walletBreakdown: [{ key: 'vip', count: 1 }] }),
    payload({ reportSummary: { basisNote: 'x'.repeat(601) } }),
  ];
  for (const data of broken) assert.equal(parseFinancePayload(data), null, JSON.stringify(data)?.slice(0, 120));
});

test('fallback honesto: MRR pelo catálogo das assinaturas Stripe ativas e o resto sem dado', () => {
  const view = buildFallbackFinanceView(
    { accounts: 30, trial: 12, active: 7, expired: 9, suspended: 2 },
    { paidAccounts: 5 },
    { coupons: [{ uses: 2 }, { uses: 1 }], codes: [{ uses: 1 }, { uses: 'x' }], period: '90d', reason: 'HTTP 404' },
  );
  assert.equal(view.source, 'fallback');
  assert.match(view.notice, /HTTP 404/);
  assert.match(view.notice, /estimado pelo preço de catálogo/);
  assert.equal(view.period.key, '90d');
  assert.equal(view.kpis.mrrCents, 5 * 5999);
  assert.equal(view.kpis.arrCents, 5 * 5999 * 12);
  assert.equal(view.kpis.couponRedemptionsTotal, 3);
  assert.equal(view.kpis.codeGrantActive, 1);
  assert.equal(view.kpis.pastDueAtRiskCents, null);
  assert.equal(view.kpis.trialConversionRatePct, null);
  assert.deepEqual(view.wallet.segments.map(segment => segment.value), [5, 12, 2, null, 9]);
  assert.equal(view.intervals.every(row => row.subscriptions === null && row.priceCents > 0), true);
  // sem nada carregado continua desenhável: tudo null, nenhuma exceção
  const empty = buildFallbackFinanceView(null, null);
  assert.equal(empty.period.key, DEFAULT_PERIOD);
  assert.equal(empty.kpis.mrrCents, null);
  assert.equal(empty.wallet.total, 0);
  assert.equal(statementLines(empty).every(line => statementValue(line) === MISSING), true);
});

test('demonstrativo: descontos com sinal negativo, contagem do período e percentual', () => {
  const view = parseFinancePayload(payload());
  const values = Object.fromEntries(statementLines(view).map(line => [line.key, statementValue(line).replace(NBSP, ' ')]));
  assert.equal(values.gross, 'R$ 1.139,62');
  assert.equal(values.discount, '- R$ 59,99');
  assert.equal(values.net, 'R$ 1.079,63');
  assert.equal(values.paidEvents, '3 no período');
  assert.equal(values.conversion, '12,5%');
});

test('filtros da tabela: abas, contadores, busca sem acento e totais', () => {
  const view = parseFinancePayload(payload());
  assert.deepEqual(financeFilterCounts(view), { all: 4, paid: 1, past_due: 1, courtesy: 1, canceled: 1, webhooks: 2 });
  assert.deepEqual(filterFinanceRows(view, { filter: 'paid' }).map(row => row.id), ['row_1']);
  assert.deepEqual(filterFinanceRows(view, { query: 'JULIA' }).map(row => row.id), ['row_3'], 'busca ignora caixa e acento');
  assert.deepEqual(filterFinanceRows(view, { query: 'parceiro' }).map(row => row.id), ['row_1'], 'busca pelo cupom');
  assert.deepEqual(filterFinanceRows(view, { query: 'sub_1q8xcaio' }).map(row => row.id), ['row_2'], 'busca pelo id sub_ da Stripe');
  assert.deepEqual(filterFinanceRows(view, { filter: 'webhooks', query: 'subscription' }).map(row => row.eventId), ['evt_2']);
  assert.deepEqual(filterFinanceRows(view, { filter: 'webhooks', query: 'sub_1Q8xMarina' }).map(row => row.eventId), ['evt_1']);
  assert.deepEqual(financeTotals(filterFinanceRows(view, {})), { grossCents: 5999 + 71988 + 0 + 17997, netCents: 5399 + 71988 + 0 + 17997, mrrCents: 5999 * 3 });
});

test('somas do período para o rodapé do gráfico, sem somar contas ativas por dia', () => {
  const totals = seriesTotals(parseFinancePayload(payload()).series);
  assert.deepEqual(totals, { estimatedNewMrrCents: 7499, newSubscriptions: 3, newPaidSubscriptions: 2, webhookEvents: 7, invoicePaidEvents: 3, newAccounts: 4 });
  assert.equal(Object.hasOwn(totals, 'activeAccounts'), false);
  assert.equal(seriesTotals([]).webhookEvents, 0);
});

test('CSV seguro: fórmula vira texto, aspas são escapadas e o separador é ;', () => {
  for (const evil of ['=HYPERLINK("x")', '+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) assert.equal(csvCell(evil).replace(/^"|"$/g, '').startsWith("'"), true, evil);
  assert.equal(csvCell('Ana "Dev"'), '"Ana ""Dev"""');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('Marina'), 'Marina');
  const view = parseFinancePayload(payload({ entries: [{ id: 'row_1', stripeSubscriptionId: 'sub_1', customerName: '=cmd|" /C calc"!A0', customerEmail: 'x@y.z', interval: 'month', intervalLabel: 'Mensal', source: 'stripe', status: 'active', catalogAmountCents: 5999, discountCents: 0, netCommitmentCents: 5999, mrrContributionCents: 5999 }] }));
  const csv = financeCsv(view);
  assert.equal(csv.startsWith('﻿Cliente;E-mail;'), true);
  const [, row] = csv.trim().split('\r\n');
  assert.equal(row.startsWith(`"'=cmd|"" /C calc""!A0";x@y.z;Stripe;Mensal;Ativa;59,99;;0,00;59,99;59,99;`), true, row);
  assert.match(row, /;sub_1;30d$/);
});

test('relatório JSON declara a origem e não perde linhas', () => {
  const view = parseFinancePayload(payload());
  const report = financeReport(view, '2026-10-15T12:00:00.000Z');
  assert.equal(report.source, 'server');
  assert.equal(report.amountsIn, 'centavos');
  assert.equal(report.statement.length, 8);
  assert.equal(report.subscriptions.length, 4);
  assert.equal(report.subscriptions[0].tab, 'paid');
  assert.equal(report.subscriptions[0].subscriptionId, 'sub_1Q8xMarina');
  assert.equal(JSON.parse(JSON.stringify(report)).kpis.mrrCents, 23996);
  assert.equal(financeFileName(view, 'csv', new Date('2026-10-15T12:00:00Z')), 'nexus-financeiro-30d-2026-10-15.csv');
  assert.equal(financeReport(buildFallbackFinanceView(null, null)).source, 'fallback');
});

test('avatar: iniciais do nome ou do e-mail e tom estável', () => {
  assert.equal(initialsOf('Marina Duarte Lins', 'm@x.com'), 'ML');
  assert.equal(initialsOf('Júlia', 'j@x.com'), 'JÚ');
  assert.equal(initialsOf('', 'caio.lins@exemplo.com'), 'CA');
  assert.equal(initialsOf(null, null), '?');
  assert.equal(avatarTone('acc_1'), avatarTone('acc_1'));
  assert.equal(avatarTone('acc_1') >= 0 && avatarTone('acc_1') < 6, true);
});

// Documento mínimo para os renderizadores: grava atributos, filhos e texto. Sem innerHTML de propósito.
function fakeDocument() {
  const make = (tag, ns) => {
    const node = {
      tag, ns, attrs: {}, children: [], dataset: {}, textContent: '', className: '', listeners: {}, style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return this.attrs[name] ?? null; },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      get classList() { return { toggle: (name, on) => { this.attrs[`class:${name}`] = String(on); } }; },
    };
    Object.defineProperty(node, 'innerHTML', { set() { throw new Error('innerHTML proibido'); } });
    return node;
  };
  return { createElementNS: (ns, tag) => make(tag, ns), createElement: tag => make(tag, null) };
}
const walk = (node, out = []) => { out.push(node); for (const child of node.children ?? []) walk(child, out); return out; };

test('geometria: teto redondo, curva monotônica e arcos do anel', () => {
  assert.deepEqual([niceMax(0), niceMax(7), niceMax(23996), niceMax(140)], [1, 10, 25000, 200]);
  assert.equal(monotonePath([]), '');
  assert.equal(monotonePath([[0, 10]]), 'M0,10');
  const flat = monotonePath([[0, 10], [10, 10], [20, 10]]);
  assert.doesNotMatch(flat, /NaN/);
  assert.equal(flat.match(/C/g).length, 2);
  // a curva nunca sai do intervalo dos pontos: nenhuma coordenada y de controle passa de 0..100
  const ys = monotonePath([[0, 100], [10, 0], [20, 100], [30, 100]]).match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 1);
  assert.equal(ys.every(y => y >= 0 && y <= 100), true, ys.join(','));
  const { arcs, circumference, total } = donutArcs([3, 1, 0], { radius: 50, gap: 0 });
  assert.equal(total, 4);
  assert.equal(arcs[0].share, 0.75);
  assert.equal(arcs[2].length, 0);
  assert.equal(arcs[1].dashoffset, -Math.round(circumference * 0.75 * 100) / 100);
  assert.equal(sparklinePath([1]), '');
  assert.match(sparklinePath([1, 3, 2]), /^M/);
});

test('geometria do gráfico de receita: barras só onde há valor, grade e rótulos sem sobrepor', () => {
  const points = Array.from({ length: 30 }, (_, index) => ({ label: `d${index}`, area: index * 100, bar: index % 3 ? 0 : 50 }));
  const geo = revenueGeometry(points, { width: 640, height: 240 });
  assert.equal(geo.bars.length, 10);
  assert.equal(geo.grid.length, 5);
  assert.equal(geo.max, 5000);
  assert.match(geo.area, /Z$/);
  assert.equal(geo.labels.at(-1).text, 'd29', 'o último bucket sempre tem rótulo');
  const gaps = geo.labels.slice(1).map((label, index) => label.x - geo.labels[index].x);
  assert.equal(gaps.every(gap => gap >= 40), true, gaps.join(','));
});

test('renderizadores montam SVG por createElementNS e escrevem texto por textContent', () => {
  const doc = fakeDocument(), box = doc.createElement('div');
  box.clientWidth = 520;
  renderRevenueAreaChart(box, {
    points: [{ label: '15/09', area: 100, bar: 20 }, { label: '<b>22/09</b>', area: 200, bar: null }],
    areaLabel: 'MRR', barLabel: 'MRR novo', format: value => `R$ ${value}`,
  }, { doc });
  const nodes = walk(box);
  const svg = nodes.find(node => node.tag === 'svg');
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.ok(nodes.some(node => node.tag === 'linearGradient'));
  assert.ok(nodes.some(node => node.tag === 'path' && /url\(#adm-grad-/.test(node.attrs.fill ?? '')));
  assert.equal(nodes.filter(node => node.tag === 'rect').every(rect => rect.attrs.rx === '3'), true);
  assert.ok(nodes.some(node => node.tag === 'text' && node.textContent === '<b>22/09</b>'), 'rótulo vindo de dado entra como texto literal');
  assert.match(nodes.find(node => node.className === 'adm-chart-readout').textContent, /<b>22\/09<\/b> · MRR: R\$ 200 · MRR novo: sem dado/);
  const frame = nodes.find(node => node.className === 'adm-chart-frame');
  let prevented = false;
  frame.listeners.keydown({ key: 'Home', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(nodes.find(node => node.className === 'adm-chart-readout').textContent, /^15\/09/);

  const empty = doc.createElement('div');
  renderRevenueAreaChart(empty, { points: [], areaLabel: 'a', barLabel: 'b', format: String, emptyMessage: 'Série chega com o relatório do servidor.' }, { doc });
  assert.equal(walk(empty).some(node => node.textContent === 'Série chega com o relatório do servidor.'), true);

  const ring = doc.createElement('div');
  renderWalletDonutChart(ring, { segments: [{ key: 'paid', label: 'Pagos', color: '#7ee2a8', value: 3 }, { key: 'trial', label: 'Teste', color: '#f5b942', value: 1 }, { key: 'pastDue', label: 'Atraso', color: '#ff4f8b', value: null }], total: 4 }, { doc });
  const circles = walk(ring).filter(node => node.tag === 'circle');
  assert.equal(circles.length, 3, 'trilho + duas fatias com valor');
  assert.ok(circles.slice(1).every(circle => /^\d+(\.\d+)? \d+(\.\d+)?$/.test(circle.attrs['stroke-dasharray'])));
  assert.equal(walk(ring).find(node => node.attrs.class === 'adm-donut-total').textContent, '4');

  const stacked = doc.createElement('div');
  renderStackedBar(stacked, [{ id: 'month', label: 'Mensal', color: '#ff4f8b', share: 0.25 }, { id: 'year', label: 'Anual', color: '#30d158', share: 0.75 }, { id: 'quarter', label: 'Trimestral', color: '#38bdf8', share: 0 }], { doc });
  const bar = stacked.children[0];
  assert.equal(bar.className, 'adm-stacked-bar');
  assert.deepEqual(bar.children.map(seg => seg.style.props['--share']), ['25', '75']);
});

test('ícones: todo nome usado na tela existe e sai decorativo', () => {
  const doc = fakeDocument();
  for (const name of ['dashboard', 'wallet', 'funnel', 'users', 'gift', 'tag', 'bug', 'panelClose', 'calendar', 'download', 'fileText', 'database']) assert.ok(ICONS[name], name);
  const svg = icon('wallet', { doc });
  assert.equal(svg.attrs['aria-hidden'], 'true');
  assert.equal(svg.attrs.stroke, 'currentColor');
  assert.equal(svg.children.length, 2);
});

test('admin.js só procura ids que existem em /admin/ (renomear um id no HTML quebra aqui, não em produção)', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../../admin/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../admin.js', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  const wanted = new Set([...script.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1]));
  for (const list of script.matchAll(/for \(const id of \[([^\]]+)\]\)/g)) for (const id of list[1].matchAll(/'([^']+)'/g)) wanted.add(id[1]);
  assert.ok(wanted.size > 60, `poucos ids encontrados: ${wanted.size}`);
  for (const id of wanted) assert.ok(ids.has(id), `#${id} sumiu do admin/index.html`);
});

test('entryKind: trialing é teste, e ativa com cupom de 100% (líquido zero sobre valor de tabela) não é paga', () => {
  const stripe = { source: 'stripe', currentPeriodEnd: null };
  assert.equal(entryKind({ ...stripe, status: 'trialing' }), 'trial');
  assert.equal(entryKind({ ...stripe, status: 'active', grossCents: 71988, netCents: 0 }), 'other');
  assert.equal(entryKind({ ...stripe, status: 'active', grossCents: 71988, netCents: 57590 }), 'paid');
  // Equipe não tem preço de catálogo: bruto zero continua paga.
  assert.equal(entryKind({ ...stripe, status: 'active', grossCents: 0, netCents: 0 }), 'paid');
});
