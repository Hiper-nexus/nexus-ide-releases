/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUsageAnalytics,
  shiftDayKey,
  summarizeUsage,
  usageWindowStartDay,
} from '../../../shared/usage-analytics';
import type {
  UsageAnalytics,
  UsageQuery,
  UsageRollupRow,
  UsageSessionActivity,
  UsageSnapshot,
} from '../../../shared/usage-types';
import { setActiveWorkspacePath } from '../../state/active-workspace';
import { EMPTY_USAGE_SNAPSHOT, useUsageStore } from '../../state/usage-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import {
  dayLongLabel,
  dayTickLabel,
  formatSharePercent,
  formatTokenCount,
  formatUsdAmount,
  pluralize,
} from '../../lib/usage-overview';
import { UsageOverview } from './UsageOverview';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = '2026-10-15';
const day = (daysAgo: number) => shiftDayKey(TODAY, -daysAgo);

function row(
  daysAgo: number,
  provider: string,
  model: string,
  costUsd: number,
  cachedInputTokens: number,
): UsageRollupRow {
  return {
    day: day(daysAgo),
    provider,
    model,
    costUsd,
    inputTokens: 1_000,
    cachedInputTokens,
    cacheWriteTokens: 200,
    outputTokens: 5_000,
    cacheSavingsUsd: cachedInputTokens / 1_000_000,
    turns: 3,
  };
}

const ROWS: UsageRollupRow[] = [
  row(0, 'claude', 'claude-opus-5-5', 120.5, 90_000_000),
  row(0, 'claude', 'claude-sonnet-5-5', 8.25, 12_000_000),
  row(0, 'codex', 'gpt-6-astra', 30, 400_000_000),
  row(1, 'claude', 'claude-opus-5-5', 60, 50_000_000),
  row(2, 'codex', 'gpt-6-astra', 12.5, 150_000_000),
  // Dia 3 sem nenhum consumo: serve para o "dia sem uso".
  row(4, 'claude', 'claude-opus-5-5', 300, 700_000_000),
  row(4, 'codex', 'gpt-6-astra', 40, 900_000_000),
  row(9, 'claude', 'claude-sonnet-5-5', 15, 30_000_000),
  row(20, 'claude', 'claude-opus-5-5', 80, 120_000_000),
  row(20, 'codex', 'gpt-6-astra', 20, 250_000_000),
  row(35, 'codex', 'gpt-6-astra', 55, 600_000_000),
  row(60, 'claude', 'claude-opus-5-5', 25, 40_000_000),
  row(60, 'mimo-code', 'mimo-v2', 0.4, 8_000_000),
];

const SESSIONS: UsageSessionActivity[] = [
  { provider: 'claude', cells: [[day(0), 'claude-opus-5-5'], [day(1), 'claude-opus-5-5']] },
  { provider: 'claude', cells: [[day(0), 'claude-sonnet-5-5']] },
  { provider: 'claude', cells: [[day(4), 'claude-opus-5-5']] },
  { provider: 'claude', cells: [[day(9), 'claude-sonnet-5-5']] },
  { provider: 'claude', cells: [[day(20), 'claude-opus-5-5']] },
  { provider: 'claude', cells: [[day(60), 'claude-opus-5-5']] },
  { provider: 'codex', cells: [[day(0), 'gpt-6-astra']] },
  { provider: 'codex', cells: [[day(2), 'gpt-6-astra']] },
  { provider: 'codex', cells: [[day(4), 'gpt-6-astra']] },
  { provider: 'codex', cells: [[day(20), 'gpt-6-astra']] },
  { provider: 'codex', cells: [[day(35), 'gpt-6-astra']] },
  { provider: 'mimo-code', cells: [[day(60), 'mimo-v2']] },
];

const analytics: UsageAnalytics = buildUsageAnalytics(ROWS, SESSIONS, TODAY);

function seed(value: UsageAnalytics | undefined = analytics): void {
  useUsageStore.setState({ snapshot: { ...EMPTY_USAGE_SNAPSHOT, ...(value ? { analytics: value } : {}) } });
}

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<UsageOverview />));
  return { host, root };
}

async function press(host: HTMLElement, group: string, label: string): Promise<void> {
  const button = [...host.querySelectorAll(`[aria-label="${group}"] button`)].find(
    (candidate) => candidate.textContent === label,
  ) as HTMLButtonElement | undefined;
  expect(button, `${group} → ${label}`).toBeDefined();
  await act(async () => button!.click());
}

function control(host: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  const field = [...host.querySelectorAll('label.usage-filter')].find(
    (candidate) => candidate.querySelector('.usage-filter__label')?.textContent === label,
  );
  expect(field, `campo ${label}`).toBeDefined();
  return field!.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
}

async function setField(el: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

/** O React escuta `focusout` para o onBlur. */
async function blur(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

async function clickSvg(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function key(host: HTMLElement, name: string): Promise<void> {
  const svg = host.querySelector('.usage-chart__svg')!;
  await act(async () => {
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

const text = (host: ParentNode, selector: string) => host.querySelector(selector)?.textContent ?? null;

/** Tudo que a tela mostra, lido do DOM. */
function read(host: HTMLElement) {
  const panel = host.querySelector('.usage-overview')!;
  return {
    hero: text(panel, '.usage-overview__hero'),
    sub: text(panel, '.usage-overview__hero-sub'),
    providers: [...panel.querySelectorAll('.usage-provider')].map((item) => ({
      id: (item as HTMLElement).dataset.provider!,
      cost: text(item, '.usage-provider__cost'),
      meta: text(item, '.usage-provider__meta'),
      sessions: text(item, '.usage-provider__sessions'),
    })),
    totals: Object.fromEntries(
      [...panel.querySelectorAll('.usage-totals__item')].map((item) => [text(item, 'dt'), text(item, 'dd')]),
    ),
    header: [...panel.querySelectorAll('.usage-breakdown thead th')].map((cell) => cell.textContent),
    rows: [...panel.querySelectorAll('.usage-breakdown tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((cell) => cell.textContent),
    ),
    stats: Object.fromEntries(
      [...panel.querySelectorAll('.usage-chart__stat')].map((item) => [
        text(item, 'dt'),
        [...item.querySelectorAll('dd')].map((dd) => dd.textContent),
      ]),
    ),
    points: panel.querySelectorAll('.usage-chart__hit').length,
    series: [...panel.querySelectorAll('.usage-chart__series')].map((item) => (item as SVGElement).dataset.series),
    readout: text(panel, '.usage-chart__readout'),
    pinned: panel.querySelector('.usage-chart__pin') !== null,
  };
}

/** A tela esperada de um recorte, a partir das mesmas linhas (o oráculo). */
function expectedFor(query: UsageQuery, metric: 'cost' | 'tokens' = 'cost') {
  const summary = summarizeUsage(analytics, query);
  const byProvider =
    metric === 'cost'
      ? summary.byProvider
      : [...summary.byProvider].sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd);
  return { summary, byProvider };
}

const usd = formatUsdAmount;
const tokens = formatTokenCount;
/** `$1,234.56` → 1234.56 */
const money = (value: string | null) => Number((value ?? '').replace(/[^0-9.]/gu, ''));

describe('UsageOverview — filtros recalculam o painel inteiro', () => {
  let mounted: { host: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
    setActiveWorkspacePath(null);
    useWorkspaceStore.setState({ current: null });
    seed();
  });

  afterEach(() => {
    if (mounted) act(() => mounted!.root.unmount());
    mounted = null;
    document.body.innerHTML = '';
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const open = () => {
    mounted = mount();
    return mounted.host;
  };

  const showAllRows = async (host: HTMLElement) => {
    const more = [...host.querySelectorAll('.usage-overview__more')][0] as HTMLButtonElement | undefined;
    if (more && more.getAttribute('aria-expanded') === 'false') await act(async () => more.click());
  };

  it.each([7, 30, 90] as const)('%i dias: total, lista, totais, tabela e gráfico saem das mesmas linhas', async (days) => {
    const host = open();
    await press(host, 'Período', `${days} dias`);
    const { summary, byProvider } = expectedFor({ from: usageWindowStartDay(TODAY, days), to: TODAY });
    const screen = read(host);

    expect(screen.hero).toBe(usd(summary.totals.costUsd));
    expect(screen.sub).toBe(
      `${tokens(summary.totals.processedTokens)} tokens · ${pluralize(summary.totals.sessions, 'sessão', 'sessões')} · estimativa de API em ${days} dias`,
    );
    expect(screen.providers.map((item) => [item.id, item.cost])).toEqual(
      byProvider.map((item) => [item.provider, usd(item.costUsd)]),
    );
    expect(screen.providers.map((item) => item.meta)).toEqual(
      byProvider.map((item) => `${formatSharePercent(item.costShare)} do custo · ${tokens(item.totalTokens)} tokens`),
    );
    expect(screen.totals).toEqual({
      'Tokens processados': tokens(summary.totals.processedTokens),
      'Input em cache': tokens(summary.totals.cachedInputTokens),
      'Input sem cache': tokens(summary.totals.uncachedInputTokens),
      Output: tokens(summary.totals.outputTokens),
      'Economia de cache': usd(summary.totals.cacheSavingsUsd),
    });
    await showAllRows(host);
    expect(read(host).rows).toEqual(
      summary.byModel.map((item) => [item.model, usd(item.costUsd), formatSharePercent(item.costShare), tokens(item.totalTokens)]),
    );
    expect(screen.points).toBe(days);
    expect(screen.series).toEqual(expect.arrayContaining(byProvider.map((item) => item.provider)));
    expect(screen.series).toHaveLength(byProvider.length);

    // A soma das ferramentas e dos modelos fecha com o total mostrado (±1 centavo por linha).
    const heroValue = money(screen.hero);
    expect(Math.abs(screen.providers.reduce((sum, item) => sum + money(item.cost), 0) - heroValue)).toBeLessThan(0.02);
    expect(Math.abs(read(host).rows.reduce((sum, cells) => sum + money(cells[1]!), 0) - heroValue)).toBeLessThan(0.05);
  });

  it('âncora: os números do preset de 30 dias batem com a soma feita à mão das linhas', async () => {
    const host = open();
    // 30 dias = offsets 0..29: claude 120.5+8.25+60+300+15+80 = 583.75; codex 30+12.5+40+20 = 102.5.
    expect(read(host).hero).toBe('$686.25');
    expect(read(host).providers.map((item) => [item.id, item.cost])).toEqual([
      ['claude', '$583.75'],
      ['codex', '$102.50'],
    ]);
    expect(read(host).providers.map((item) => item.sessions)).toEqual(['5 sessões', '4 sessões']);
  });

  it('intervalo personalizado: escolher duas datas recalcula tudo e uma ponta empurra a outra', async () => {
    const host = open();
    await press(host, 'Período', 'Personalizado');
    expect((control(host, 'De') as HTMLInputElement).value).toBe(usageWindowStartDay(TODAY, 30));
    expect((control(host, 'Até') as HTMLInputElement).value).toBe(TODAY);

    await setField(control(host, 'De'), day(10));
    await setField(control(host, 'Até'), day(3));
    const range = { from: day(10), to: day(3) };
    const { summary } = expectedFor(range);
    const screen = read(host);
    expect(screen.hero).toBe(usd(summary.totals.costUsd));
    expect(screen.points).toBe(8);
    expect(screen.sub).toContain(`estimativa de API de ${dayTickLabel(range.from)} a ${dayTickLabel(range.to)}`);
    expect(screen.sub).toContain(pluralize(summary.totals.sessions, 'sessão', 'sessões'));
    // O dia 3 não teve consumo, o 4 teve: o gráfico nasce no dia 10 e termina no 3, sem "hoje".
    const ticks = [...host.querySelectorAll('.usage-chart__tick')].map((item) => item.textContent);
    expect(ticks[0]).toBe(dayTickLabel(range.from));
    expect(ticks).not.toContain('hoje');

    // De nunca passa de Até: fora do limite o valor não sobe para o painel, o campo marca
    // erro e, ao sair, volta ao valor que vale. Fora dos 90 dias, a mesma regra.
    const from = control(host, 'De') as HTMLInputElement;
    await setField(from, day(1));
    expect(read(host).points).toBe(8);
    expect(from.value).toBe(day(1));
    expect(from.getAttribute('aria-invalid')).toBe('true');
    await blur(from);
    expect(from.value).toBe(day(10));
    expect(from.hasAttribute('aria-invalid')).toBe(false);
    await setField(from, '2025-01-01');
    expect(read(host).points).toBe(8);
    await blur(from);
    expect(from.value).toBe(day(10));
    // Campo apagado pela metade não muda nada.
    const before = read(host).hero;
    await setField(control(host, 'Até'), '');
    expect(read(host).hero).toBe(before);
  });

  it('digitar a data tecla a tecla não mexe no painel até a data ficar completa e dentro do limite', async () => {
    const host = open();
    await press(host, 'Período', 'Personalizado');
    await setField(control(host, 'De'), day(10));
    await setField(control(host, 'Até'), day(3));
    const until = control(host, 'Até') as HTMLInputElement;
    const heroBefore = read(host).hero;
    // Segmento apagado, dia intermediário antes do "De" e ano com um dígito só: nada sobe.
    const monthPrefix = day(3).slice(0, 8);
    const yearTail = day(3).slice(4);
    for (const typed of ['', `${monthPrefix}01`, `0002${yearTail}`]) {
      await setField(until, typed);
      expect(read(host).hero).toBe(heroBefore);
      expect((control(host, 'De') as HTMLInputElement).value).toBe(day(10));
    }
    // O campo guarda o que a pessoa digitou: o React não o reescreve no meio da digitação.
    expect(until.value).toBe(`0002${yearTail}`);
    // Completa e dentro do limite: aí sim, e o "De" fica onde estava.
    await setField(until, day(5));
    expect(read(host).points).toBe(6);
    expect((control(host, 'De') as HTMLInputElement).value).toBe(day(10));
  });

  it('o campo Dia só fixa uma data completa do período e o resto volta ao sair do campo', async () => {
    const host = open();
    const field = control(host, 'Dia') as HTMLInputElement;
    const total = read(host).hero;
    const target = day(4);
    for (const typed of [`0002${target.slice(4)}`, `0020${target.slice(4)}`, `0202${target.slice(4)}`]) {
      await setField(field, typed);
      expect(read(host).hero).toBe(total);
      expect(read(host).pinned).toBe(false);
    }
    expect(field.value).toBe(`0202${target.slice(4)}`);
    await setField(field, target);
    expect(read(host).hero).toBe('$340.00');
    // Fora do período (e fora do limite do campo): não fixa, e ao sair volta ao dia fixado.
    await setField(field, day(40));
    expect(read(host).hero).toBe('$340.00');
    await blur(field);
    expect(field.value).toBe(target);
    // Apagar o campo é uma escolha: solta o dia.
    await setField(field, '');
    expect(read(host).hero).toBe(total);
  });

  it('fixar um dia no gráfico mostra só ele no painel e mantém o período no gráfico', async () => {
    const host = open();
    const target = day(4);
    const hits = [...host.querySelectorAll('.usage-chart__hit')];
    expect(hits).toHaveLength(30);
    await clickSvg(hits[30 - 1 - 4]!);

    const single = summarizeUsage(analytics, { from: target, to: target });
    const screen = read(host);
    expect(screen.hero).toBe(usd(single.totals.costUsd));
    expect(screen.hero).toBe('$340.00');
    expect(screen.sub).toBe(
      `${tokens(single.totals.processedTokens)} tokens · ${pluralize(single.totals.sessions, 'sessão', 'sessões')} · estimativa de API em ${dayLongLabel(target)}`,
    );
    expect(screen.providers.map((item) => item.id)).toEqual(['claude', 'codex']);
    expect(screen.totals['Tokens processados']).toBe(tokens(single.totals.processedTokens));
    expect(screen.pinned).toBe(true);
    expect(screen.points).toBe(30);
    expect(screen.readout).toContain('dia fixado');
    expect((control(host, 'Dia') as HTMLInputElement).value).toBe(target);
    // O pico do período continua sendo do período, não do dia fixado.
    expect(screen.stats['Pico em um dia']![1]).toContain(dayLongLabel(target));

    // Clicar de novo no mesmo dia solta a escolha.
    await clickSvg([...host.querySelectorAll('.usage-chart__hit')][30 - 1 - 4]!);
    expect(read(host).hero).toBe('$686.25');
    expect(read(host).pinned).toBe(false);
  });

  it('o campo Dia e a tabela por dia fixam o mesmo dia, e Limpar filtros volta ao período', async () => {
    const host = open();
    await setField(control(host, 'Dia'), day(2));
    expect(read(host).hero).toBe(usd(summarizeUsage(analytics, { from: day(2), to: day(2) }).totals.costUsd));
    expect(read(host).hero).toBe('$12.50');
    expect(read(host).providers.map((item) => item.id)).toEqual(['codex']);

    await press(host, 'Detalhar por', 'Dia');
    const picks = [...host.querySelectorAll('.usage-breakdown__pick')] as HTMLButtonElement[];
    const pressedPick = picks.find((item) => item.getAttribute('aria-pressed') === 'true');
    expect(pressedPick?.textContent).toBe(dayLongLabel(day(2)));
    // A tabela por dia lista o PERÍODO (os dias com uso), com o dia fixado marcado.
    expect(picks.map((item) => item.textContent)).toEqual(
      [0, 1, 2, 4, 9, 20].map((offset) => dayLongLabel(day(offset))),
    );
    await act(async () => picks.find((item) => item.textContent === dayLongLabel(day(4)))!.click());
    expect(read(host).hero).toBe('$340.00');
    expect((control(host, 'Dia') as HTMLInputElement).value).toBe(day(4));

    await act(async () => ([...host.querySelectorAll('button')].find((b) => b.textContent === 'Limpar filtros') as HTMLButtonElement).click());
    expect(read(host).hero).toBe('$686.25');
    expect((control(host, 'Dia') as HTMLInputElement).value).toBe('');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Limpar filtros')).toBe(false);
  });

  it('dia sem consumo explica e oferece limpar, sem mostrar zeros nem totais', async () => {
    const host = open();
    await setField(control(host, 'Dia'), day(3));
    const panel = host.querySelector('.usage-overview')!;
    expect(panel.textContent).toContain(`Sem consumo em ${dayLongLabel(day(3))}`);
    expect(panel.querySelector('.usage-overview__hero')).toBeNull();
    expect(panel.querySelector('.usage-totals')).toBeNull();
    // O gráfico segue à mão para escolher outro dia.
    expect(panel.querySelectorAll('.usage-chart__hit')).toHaveLength(30);
    await act(async () => ([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Limpar filtros') as HTMLButtonElement).click());
    expect(read(host).hero).toBe('$686.25');
  });

  it('ferramenta: filtra total, lista, gráfico, modelos e tabela, e a cor da ferramenta não muda', async () => {
    const host = open();
    const colorOf = (id: string, h: HTMLElement) =>
      (h.querySelector(`.usage-provider[data-provider="${id}"] .usage-provider__dot`) as HTMLElement | null)?.style.getPropertyValue('--usage-series');
    const claudeColor = colorOf('claude', host);
    expect(claudeColor).toBe('var(--series-2)');

    await setField(control(host, 'Ferramenta'), 'codex');
    const { summary } = expectedFor({ from: usageWindowStartDay(TODAY, 30), to: TODAY, provider: 'codex' });
    const screen = read(host);
    expect(screen.hero).toBe(usd(summary.totals.costUsd));
    expect(screen.hero).toBe('$102.50');
    expect(screen.providers.map((item) => item.id)).toEqual(['codex']);
    expect(screen.series).toEqual(['codex']);
    expect(screen.sub).toContain(pluralize(summary.totals.sessions, 'sessão', 'sessões'));
    expect(screen.rows).toEqual([['gpt-6-astra', '$102.50', '100,0%', tokens(summary.totals.processedTokens)]]);
    expect([...(control(host, 'Modelo') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Todos', 'gpt-6-astra']);
    expect(colorOf('codex', host)).toBe('var(--series-1)');
    // O gráfico só soma o que sobrou: nenhum ponto do dia tem custo de outra ferramenta.
    const costOnDay = summarizeUsage(analytics, { from: day(4), to: day(4), provider: 'codex' }).totals.costUsd;
    expect(costOnDay).toBe(40);

    await setField(control(host, 'Ferramenta'), '');
    expect(read(host).hero).toBe('$686.25');
    expect(read(host).providers.map((item) => item.id)).toEqual(['claude', 'codex']);
    expect(colorOf('claude', host)).toBe(claudeColor);
  });

  it('modelo: escolher um modelo escolhe a ferramenta dele, e trocar a ferramenta solta o modelo', async () => {
    const host = open();
    const modelSelect = control(host, 'Modelo') as HTMLSelectElement;
    // Com mais de uma ferramenta, os modelos vêm agrupados por ela.
    expect([...modelSelect.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['Claude Code', 'Codex']);
    const sonnet = [...modelSelect.options].find((option) => option.textContent === 'claude-sonnet-5-5')!;
    await setField(modelSelect, sonnet.value);

    const { summary } = expectedFor({ from: usageWindowStartDay(TODAY, 30), to: TODAY, provider: 'claude', model: 'claude-sonnet-5-5' });
    let screen = read(host);
    expect((control(host, 'Ferramenta') as HTMLSelectElement).value).toBe('claude');
    expect(screen.hero).toBe(usd(summary.totals.costUsd));
    expect(screen.hero).toBe('$23.25');
    expect(screen.providers.map((item) => item.id)).toEqual(['claude']);
    expect(screen.rows).toEqual([['claude-sonnet-5-5', '$23.25', '100,0%', tokens(summary.totals.processedTokens)]]);
    expect(screen.sub).toContain(pluralize(summary.totals.sessions, 'sessão', 'sessões'));

    await setField(control(host, 'Ferramenta'), 'codex');
    expect((control(host, 'Modelo') as HTMLSelectElement).value).toBe('');
    screen = read(host);
    expect(screen.hero).toBe('$102.50');
  });

  it('Tokens vira a medida do painel inteiro; no Custo os tokens continuam escritos', async () => {
    const host = open();
    // Modo Custo: tokens aparecem escritos no resumo, na lista e no destaque do gráfico.
    const cost = expectedFor({ from: usageWindowStartDay(TODAY, 30), to: TODAY });
    expect(read(host).sub).toContain(`${tokens(cost.summary.totals.processedTokens)} tokens`);
    expect(read(host).providers[0]!.meta).toContain('tokens');
    expect(read(host).stats['Total do período']).toEqual([usd(cost.summary.totals.costUsd), `${tokens(cost.summary.totals.processedTokens)} tokens`]);

    await press(host, 'Medida', 'Tokens');
    const { summary, byProvider } = expectedFor({ from: usageWindowStartDay(TODAY, 30), to: TODAY }, 'tokens');
    const screen = read(host);
    expect(screen.hero).toBe(`${tokens(summary.totals.processedTokens)} tokens`);
    expect(screen.sub).toBe(
      `${usd(summary.totals.costUsd)} em API (estimativa) · ${pluralize(summary.totals.sessions, 'sessão', 'sessões')} · 30 dias`,
    );
    // Ordenado pela medida: o Codex move mais tokens que o Claude e passa à frente.
    expect(byProvider.map((item) => item.provider)).toEqual(['codex', 'claude']);
    expect(screen.providers.map((item) => item.id)).toEqual(['codex', 'claude']);
    expect(screen.providers.map((item) => item.cost)).toEqual(byProvider.map((item) => tokens(item.totalTokens)));
    expect(screen.providers.map((item) => item.meta)).toEqual(
      byProvider.map((item) => `${formatSharePercent(item.tokenShare)} dos tokens · ${usd(item.costUsd)}`),
    );
    expect(screen.header).toEqual(['Modelo', 'Custo', '% dos tokens', 'Tokens']);
    expect(screen.rows[0]![0]).toBe('gpt-6-astra');
    expect(host.querySelector('.usage-overview__chart h3')?.textContent).toBe('Tokens por dia');
    // Total, pico e média do período, em tokens, com o custo ao lado.
    const active = summary.days.filter((item) => item.totalTokens > 0);
    const peak = active.reduce((best, item) => (item.totalTokens > best.totalTokens ? item : best));
    const totalTokens = summary.totals.processedTokens;
    expect(screen.stats['Total do período']).toEqual([`${tokens(totalTokens)} tokens`, usd(summary.totals.costUsd)]);
    expect(screen.stats['Pico em um dia']).toEqual([
      `${tokens(peak.totalTokens)} tokens`,
      `${dayLongLabel(peak.day)} · ${usd(peak.costUsd)}`,
    ]);
    expect(screen.stats['Média por dia com uso']![0]).toBe(`${tokens(totalTokens / active.length)} tokens`);
    expect(screen.stats['Média por dia com uso']![1]).toContain(`${active.length} de 30 dias com uso`);
    // Os tokens do gráfico fecham com o total: a soma dos pontos é o Tokens processados.
    expect(summary.days.reduce((sum, item) => sum + item.totalTokens, 0)).toBe(totalTokens);
  });

  it('filtro que ficou sem dado no período novo some, e a tela diz o que está valendo', async () => {
    const host = open();
    await press(host, 'Período', '90 dias');
    await setField(control(host, 'Ferramenta'), 'mimo-code');
    expect(read(host).providers.map((item) => item.id)).toEqual(['mimo-code']);
    await press(host, 'Período', '7 dias');
    expect((control(host, 'Ferramenta') as HTMLSelectElement).value).toBe('');
    const week = expectedFor({ from: usageWindowStartDay(TODAY, 7), to: TODAY });
    expect(read(host).hero).toBe(usd(week.summary.totals.costUsd));
    expect([...(control(host, 'Ferramenta') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'claude', 'codex']);
    // Dia fixado fora do período novo também solta.
    await setField(control(host, 'Dia'), day(2));
    await press(host, 'Período', '7 dias');
    expect((control(host, 'Dia') as HTMLInputElement).value).toBe(day(2));
    await press(host, 'Período', 'Personalizado');
    await setField(control(host, 'De'), day(30));
    await setField(control(host, 'Até'), day(10));
    expect((control(host, 'Dia') as HTMLInputElement).value).toBe('');
    expect(read(host).pinned).toBe(false);
  });

  it('período sem consumo ensina, mantém o seletor de datas e oferece ver 90 dias', async () => {
    const host = open();
    await press(host, 'Período', 'Personalizado');
    await setField(control(host, 'De'), day(8));
    await setField(control(host, 'Até'), day(7));
    const panel = host.querySelector('.usage-overview')!;
    expect(panel.textContent).toContain(`Sem consumo de ${dayTickLabel(day(8))} a ${dayTickLabel(day(7))} neste projeto`);
    expect(control(host, 'De')).toBeDefined();
    expect(panel.querySelector('.usage-overview__hero')).toBeNull();
    await act(async () => ([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Ver 90 dias') as HTMLButtonElement).click());
    expect(read(host).hero).toBe(usd(expectedFor({ from: usageWindowStartDay(TODAY, 90), to: TODAY }).summary.totals.costUsd));
  });

  it('teclado: setas leem um dia, Enter fixa, Esc fecha a leitura e depois solta o dia', async () => {
    const host = open();
    await key(host, 'ArrowLeft');
    expect(read(host).readout).toContain(dayLongLabel(TODAY));
    await key(host, 'ArrowLeft');
    expect(read(host).readout).toContain(dayLongLabel(day(1)));
    await key(host, 'Enter');
    expect(read(host).hero).toBe('$60.00');
    expect(read(host).readout).toContain('dia fixado');
    // A leitura ainda está aberta: o primeiro Esc fecha só ela; o dia segue fixado.
    await key(host, 'Escape');
    expect(read(host).hero).toBe('$60.00');
    expect(read(host).readout).toContain('dia fixado');
    await key(host, 'Escape');
    expect(read(host).hero).toBe('$686.25');
    expect(read(host).pinned).toBe(false);
    // Home e End vão às pontas do período.
    await key(host, 'Home');
    expect(read(host).readout).toContain(dayLongLabel(usageWindowStartDay(TODAY, 30)));
    await key(host, 'End');
    expect(read(host).readout).toContain(dayLongLabel(TODAY));
  });

  it('gráfico: pico, média por dia com uso e dia fixado ficam marcados e escritos', async () => {
    const host = open();
    const svg = host.querySelector('.usage-chart__svg')!;
    // O pico é do dia mais caro (11 out, $340) e a média só conta os dias com uso.
    const peak = svg.querySelector('.usage-chart__peak')!;
    expect(peak).not.toBeNull();
    expect(svg.querySelector('.usage-chart__average text')?.textContent).toBe(`média ${usd(686.25 / 6)}`);
    expect(read(host).stats['Pico em um dia']![0]).toBe('$340.00');
    expect(read(host).stats['Média por dia com uso']![1]).toContain('6 de 30 dias com uso');
    // Um fio neutro soma as ferramentas; cada dia com uso ganha um ponto.
    expect(svg.querySelector('.usage-chart__total')).not.toBeNull();
    expect(svg.querySelectorAll('.usage-chart__dots circle')).toHaveLength(6);
    // Texto para quem não vê o gráfico.
    const summaryId = svg.getAttribute('aria-describedby')!;
    expect(document.getElementById(summaryId)?.textContent).toContain('maior dia');
    expect(document.getElementById(summaryId)?.textContent).toContain('6 de 30 dias com uso');
  });

  it('voltar ao período antigo não ressuscita a ferramenta nem o dia que tinham saído', async () => {
    const host = open();
    await press(host, 'Período', '90 dias');
    const all90 = read(host).hero;
    await setField(control(host, 'Ferramenta'), 'mimo-code');
    expect(read(host).providers.map((item) => item.id)).toEqual(['mimo-code']);
    await press(host, 'Período', '7 dias');
    expect((control(host, 'Ferramenta') as HTMLSelectElement).value).toBe('');
    await press(host, 'Período', '90 dias');
    // O filtro foi solto de verdade: não volta sozinho com o período.
    expect((control(host, 'Ferramenta') as HTMLSelectElement).value).toBe('');
    expect(read(host).hero).toBe(all90);

    await press(host, 'Período', '30 dias');
    const all30 = read(host).hero;
    await setField(control(host, 'Dia'), day(20));
    expect(read(host).hero).not.toBe(all30);
    await press(host, 'Período', '7 dias');
    await press(host, 'Período', '30 dias');
    expect((control(host, 'Dia') as HTMLInputElement).value).toBe('');
    expect(read(host).hero).toBe(all30);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Limpar filtros')).toBe(false);
  });

  it('editar De/Até até o intervalo ficar sem consumo mantém os campos montados e o foco neles', async () => {
    const host = open();
    await press(host, 'Período', 'Personalizado');
    const until = control(host, 'Até') as HTMLInputElement;
    const from = control(host, 'De') as HTMLInputElement;
    until.focus();
    await setField(from, day(8));
    expect(host.querySelector('.usage-overview__hero')).not.toBeNull();
    // [dia 8, dia 7] não teve consumo: o painel troca de ramo, os campos não.
    await setField(until, day(7));
    expect(host.querySelector('.usage-overview__hero')).toBeNull();
    expect(host.querySelector('.usage-overview')!.textContent).toContain('Sem consumo de');
    expect(control(host, 'Até')).toBe(until);
    expect(control(host, 'De')).toBe(from);
    expect(document.activeElement).toBe(until);
  });

  it('o foco não cai no body quando o botão que o tinha some: Limpar filtros → Dia; Ver o período inteiro → gráfico', async () => {
    const host = open();
    await setField(control(host, 'Dia'), day(2));
    const labelled = (text: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;
    await act(async () => labelled('Limpar filtros').click());
    expect(document.activeElement).toBe(control(host, 'Dia'));

    await clickSvg([...host.querySelectorAll('.usage-chart__hit')][30 - 1 - 4]!);
    await act(async () => labelled('Ver o período inteiro').click());
    expect(read(host).pinned).toBe(false);
    expect(document.activeElement).toBe(host.querySelector('.usage-chart__svg'));
  });

  it('a lista por ferramenta se chama pela medida escolhida', async () => {
    const host = open();
    expect(host.querySelector('ul.usage-overview__providers')?.getAttribute('aria-label')).toBe('Custo por ferramenta');
    await press(host, 'Medida', 'Tokens');
    expect(host.querySelector('ul.usage-overview__providers')?.getAttribute('aria-label')).toBe('Tokens por ferramenta');
  });

  it('um intervalo de um dia rotula o eixo no centro e não chama de "hoje" o que não é hoje', async () => {
    const host = open();
    await press(host, 'Período', 'Personalizado');
    await setField(control(host, 'De'), day(4));
    await setField(control(host, 'Até'), day(4));
    expect(read(host).points).toBe(1);
    const ticks = [...host.querySelectorAll('.usage-chart__tick')];
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.getAttribute('text-anchor')).toBe('middle');
    expect(ticks[0]!.textContent).toBe(dayTickLabel(day(4)));
    expect(read(host).hero).toBe('$340.00');
  });

  it('rotina de acessibilidade: grupos, campos e gráfico têm nome e estado', async () => {
    const host = open();
    for (const group of ['Medida', 'Período', 'Filtros do painel', 'Detalhar por']) {
      expect(host.querySelector(`[role="group"][aria-label="${group}"]`), group).not.toBeNull();
    }
    // Todo campo é um <label> com texto visível.
    for (const field of ['Dia', 'Ferramenta', 'Modelo']) {
      const input = control(host, field);
      expect(input.closest('label')?.textContent).toContain(field);
    }
    const pressedLabels = (group: string) =>
      [...host.querySelectorAll(`[aria-label="${group}"] button[aria-pressed="true"]`)].map((b) => b.textContent);
    expect(pressedLabels('Medida')).toEqual(['Custo']);
    expect(pressedLabels('Período')).toEqual(['30 dias']);
    await press(host, 'Período', 'Personalizado');
    expect(pressedLabels('Período')).toEqual(['Personalizado']);
    expect(host.querySelector('[role="group"][aria-label="Intervalo de datas"]')).not.toBeNull();
    // Gráfico: nome, descrição e foco por teclado; tabela com legenda e cabeçalhos de linha.
    const svg = host.querySelector('.usage-chart__svg')!;
    expect(document.getElementById(svg.getAttribute('aria-labelledby')!)?.textContent).toBe('Custo diário');
    expect(svg.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('.usage-breakdown caption')?.textContent).toContain('por modelo');
    expect(host.querySelectorAll('.usage-breakdown tbody th[scope="row"]').length).toBeGreaterThan(0);
    expect(host.querySelector('.usage-overview__hero-wrap')?.getAttribute('aria-live')).toBe('polite');
    // Ids únicos: nenhum aria-labelledby/describedby aponta para dois nós.
    const ids = [...host.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('UsageOverview — dados fora do comum', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT, status: 'idle' });
    vi.useRealTimers();
  });

  it('uso sem custo (plano grátis) ainda tem pico: o dia de mais tokens, com o dólar zerado escrito', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
    const free = buildUsageAnalytics(
      [
        { ...row(2, 'mimo-code', 'mimo-v2', 0, 3_000_000), cachedInputTokens: 3_000_000 },
        { ...row(5, 'mimo-code', 'mimo-v2', 0, 9_000_000), cachedInputTokens: 9_000_000 },
      ],
      [{ provider: 'mimo-code', cells: [[day(2), 'mimo-v2'], [day(5), 'mimo-v2']] }],
      TODAY,
    );
    seed(free);
    const { host, root } = mount();
    const screen = read(host);
    expect(screen.stats['Pico em um dia']![0]).toBe('$0.00');
    expect(screen.stats['Pico em um dia']![1]).toBe(
      `${dayLongLabel(day(5))} · ${tokens(summarizeUsage(free, { from: day(5), to: day(5) }).totals.processedTokens)} tokens`,
    );
    expect(screen.stats['Média por dia com uso']![1]).toContain('2 de 30 dias com uso');
    act(() => root.unmount());
  });

  it('modelo que só tem evento sem consumo (mensagem sintética) não vira opção nem linha de tabela', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
    const withSynthetic = buildUsageAnalytics(
      [
        row(1, 'claude', 'claude-opus-5-5', 10, 5_000_000),
        { ...row(1, 'claude', '<synthetic>', 0, 0), inputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheSavingsUsd: 0 },
      ],
      [{ provider: 'claude', cells: [[day(1), 'claude-opus-5-5'], [day(1), '<synthetic>']] }],
      TODAY,
    );
    seed(withSynthetic);
    const { host, root } = mount();
    const options = [...(control(host, 'Modelo') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['Todos', 'claude-opus-5-5']);
    expect(read(host).rows.map((cells) => cells[0])).toEqual(['claude-opus-5-5']);
    act(() => root.unmount());
  });
});

describe('UsageOverview — virada do dia com a tela aberta', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT });
    useWorkspaceStore.setState({ current: null });
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('depois da meia-noite pede leitura nova em vez de seguir chamando ontem de "hoje"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 23, 59, 30));
    const WORKSPACE = '/projeto/aberto';
    setActiveWorkspacePath(WORKSPACE);
    useWorkspaceStore.setState({ current: { path: WORKSPACE, name: 'aberto', lastOpenedAt: 1 } });
    const tomorrow = shiftDayKey(TODAY, 1);
    const next = buildUsageAnalytics(
      [...ROWS, { ...row(0, 'claude', 'claude-opus-5-5', 11, 1_000_000), day: tomorrow }],
      SESSIONS,
      tomorrow,
    );
    const snapshot = vi.fn(async () => ({ ...EMPTY_USAGE_SNAPSHOT, analytics: next }));
    Object.defineProperty(window, 'nexus', { configurable: true, value: { usage: { snapshot, onChanged: () => () => {} } } });
    useUsageStore.setState({ snapshot: { ...EMPTY_USAGE_SNAPSHOT, analytics } });
    const { host, root } = mount();

    const lastTick = () => [...host.querySelectorAll('.usage-chart__tick')].at(-1)?.textContent;
    expect(lastTick()).toBe('hoje');
    expect(snapshot).not.toHaveBeenCalled();
    expect(host.querySelector('.usage-chart__hit:last-of-type')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
    // A leitura nova chegou: o eixo termina no dia novo e o custo de "hoje" entrou.
    expect(read(host).hero).toBe(usd(summarizeUsage(next, { from: usageWindowStartDay(tomorrow, 30), to: tomorrow }).totals.costUsd));
    expect(lastTick()).toBe('hoje');
    expect([...host.querySelectorAll('.usage-chart__tick')][0]?.textContent).toBe(dayTickLabel(usageWindowStartDay(tomorrow, 30)));
    act(() => root.unmount());
  });
});

describe('UsageOverview — estados de leitura', () => {
  const WORKSPACE = '/projeto/aberto';

  afterEach(() => {
    document.body.innerHTML = '';
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT, status: 'idle' });
    useWorkspaceStore.setState({ current: null });
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    vi.restoreAllMocks();
  });

  it('lendo mostra o estado e o esqueleto; falhou mostra o erro; "Tentar de novo" lê de novo e o painel chega', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
    setActiveWorkspacePath(WORKSPACE);
    useWorkspaceStore.setState({ current: { path: WORKSPACE, name: 'aberto', lastOpenedAt: 1 } });
    const calls: Array<{ resolve: (value: UsageSnapshot | null) => void; reject: (error: unknown) => void }> = [];
    const snapshot = vi.fn(
      () =>
        new Promise<UsageSnapshot | null>((resolve, reject) => {
          calls.push({ resolve, reject });
        }),
    );
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { usage: { snapshot, onChanged: () => () => {} } },
    });
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT, status: 'idle' });
    const { host, root } = mount();
    const panel = () => host.querySelector('.usage-overview')!;

    // Antes de qualquer leitura: explica e oferece ler.
    expect(panel().textContent).toContain('Ainda sem leitura de custo');
    expect(panel().getAttribute('aria-busy')).toBe('false');

    await act(async () => {
      void useUsageStore.getState().hydrate(WORKSPACE);
    });
    expect(panel().querySelector('[role="status"]')?.textContent).toBe('Lendo o custo deste projeto…');
    expect(panel().getAttribute('aria-busy')).toBe('true');
    expect(panel().querySelector('.settings-skeleton')).not.toBeNull();
    expect(panel().querySelector('.usage-overview__hero')).toBeNull();

    // Falhou: erro anunciado, sem zero inventado, com ação.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => {
      calls[0]!.reject(new Error('sqlite indisponível'));
    });
    expect(panel().getAttribute('aria-busy')).toBe('false');
    expect(panel().querySelector('[role="alert"]')?.textContent).toContain('Não foi possível ler o custo');
    expect(panel().querySelector('.usage-overview__hero')).toBeNull();

    await act(async () => {
      ([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Tentar de novo') as HTMLButtonElement).click();
    });
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(panel().querySelector('[role="status"]')?.textContent).toBe('Lendo o custo deste projeto…');
    await act(async () => {
      calls[1]!.resolve({ ...EMPTY_USAGE_SNAPSHOT, analytics });
    });
    expect(read(host).hero).toBe(usd(expectedFor({ from: usageWindowStartDay(TODAY, 30), to: TODAY }).summary.totals.costUsd));
    act(() => root.unmount());
    vi.useRealTimers();
  });
});
