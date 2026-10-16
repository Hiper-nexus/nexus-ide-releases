import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import '../../styles/usage-overview.css';
import {
  USAGE_ANALYTICS_MAX_DAYS,
  USAGE_DEFAULT_WINDOW,
  USAGE_WINDOW_OPTIONS,
  type UsageAnalytics,
  type UsageMetric,
  type UsageWindowDays,
} from '../../../shared/usage-types';
import {
  clampUsageRange,
  localDayKey,
  summarizeUsage,
  usageWindowStartDay,
} from '../../../shared/usage-analytics';
import { useUsageStore } from '../../state/usage-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useMinuteTick } from '../../lib/use-minute-tick';
import { EmptyState } from '../ActionCard';
import { ProviderLogo } from '../ProviderLogo';
import {
  assignUsageSeries,
  dayLongLabel,
  formatRangeLabel,
  formatSharePercent,
  formatTokenCount,
  formatUsdAmount,
  pluralize,
  usageMeasureTexts,
  usageMeasureValue,
  usageProviderLabel,
  usageSeriesStyle,
} from '../../lib/usage-overview';
import { UsageDailyChart, chartSeriesFor } from './UsageDailyChart';

/**
 * Topo de Uso e custos, na composição do painel "Usage" do T3: à esquerda o
 * total e a lista de ferramentas (que é a legenda do gráfico), à direita o
 * gráfico diário, embaixo Totais e Detalhamento. Fonte: `UsageSnapshot.analytics`
 * do projeto aberto — equivalente de API pública, nunca fatura.
 *
 * Medida (Custo | Tokens), período (7/30/90 dias ou intervalo), dia, ferramenta
 * e modelo valem para o painel inteiro. Tudo sai de `summarizeUsage` sobre as
 * mesmas linhas do rollup, então total, gráfico, lista e tabela fecham entre si.
 * O período dá o eixo do gráfico; o dia fixado (clique no gráfico, na tabela ou
 * no campo Dia) estreita os números para ele, e o gráfico segue mostrando o
 * período com o dia realçado.
 */

type BreakdownMode = 'model' | 'day';

type Period =
  | { readonly kind: 'preset'; readonly days: UsageWindowDays }
  | { readonly kind: 'custom'; readonly from: string; readonly to: string };

type PeriodKey = UsageWindowDays | 'custom';

const METRICS: readonly { key: UsageMetric; label: string }[] = [
  { key: 'cost', label: 'Custo' },
  { key: 'tokens', label: 'Tokens' },
];

const BREAKDOWNS: readonly { key: BreakdownMode; label: string }[] = [
  { key: 'model', label: 'Modelo' },
  { key: 'day', label: 'Dia' },
];

const PERIODS: readonly { key: PeriodKey; label: string }[] = [
  ...USAGE_WINDOW_OPTIONS.map((days) => ({ key: days as PeriodKey, label: `${days} dias` })),
  { key: 'custom', label: 'Personalizado' },
];

/** Linhas visíveis do Detalhamento antes de "Mostrar todas". */
const BREAKDOWN_PREVIEW = 10;

/** Valor de um `<input type="date">` completo; campo pela metade vem vazio. */
const DAY_VALUE = /^\d{4}-\d{2}-\d{2}$/;

/** `<option>` de modelo carrega ferramenta e modelo: o nome sozinho pode repetir. */
function modelOptionValue(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}|${encodeURIComponent(model)}`;
}

function parseModelOption(value: string): { provider: string; model: string } | null {
  const [provider, model] = value.split('|');
  if (!provider || !model) return null;
  return { provider: decodeURIComponent(provider), model: decodeURIComponent(model) };
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="usage-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className="usage-segmented__btn"
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Campo de data nativo com rascunho. O Chromium dispara `input` a cada dígito
 * digitado (o 1º dígito do ano vira 0002-10-14), então o valor cru fica no
 * campo e só uma data COMPLETA e dentro de [min, max] sobe para o painel; ao
 * sair do campo, o que não valeu volta para o valor que está valendo.
 */
function DateField({
  label,
  value,
  min,
  max,
  allowClear = false,
  onCommit,
  inputRef,
}: {
  label: string;
  value: string;
  min: string;
  max: string;
  /** Campo vazio é uma escolha ("sem dia fixado"), não um dígito que falta. */
  allowClear?: boolean;
  onCommit: (day: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [draft, setDraft] = useState(value);
  // O painel mudou o valor por outro caminho (preset, gráfico, limpar): o campo acompanha.
  useEffect(() => setDraft(value), [value]);
  const valid = (day: string) => DAY_VALUE.test(day) && day >= min && day <= max;
  return (
    <label className="usage-filter">
      <span className="usage-filter__label">{label}</span>
      <input
        ref={inputRef}
        type="date"
        className="settings-input usage-filter__control"
        min={min}
        max={max}
        value={draft}
        aria-invalid={draft !== '' && !valid(draft) ? true : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next === '' ? allowClear : valid(next)) onCommit(next);
        }}
        onBlur={() => setDraft(value)}
      />
    </label>
  );
}

function UsageOverviewEmpty({ titleId }: { titleId: string }) {
  const workspacePath = useWorkspaceStore((state) => state.current?.path ?? null);
  const status = useUsageStore((state) => state.status);
  const hydrate = useUsageStore((state) => state.hydrate);
  const openSettings = useProductNavigationStore((state) => state.openSettings);
  const loading = workspacePath !== null && status === 'loading';
  let content: ReactNode;
  if (loading) {
    content = (
      <div className="usage-overview__loading">
        <p role="status">Lendo o custo deste projeto…</p>
        <div className="settings-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  } else if (workspacePath !== null && status === 'error') {
    content = (
      <EmptyState
        icon="warn"
        role="alert"
        className="usage-overview__empty"
        title="Não foi possível ler o custo"
        body={<p>A leitura das sessões deste projeto falhou. Tente de novo; se continuar, reabra o projeto.</p>}
        action={
          <button type="button" className="settings-btn" onClick={() => void hydrate(workspacePath)}>
            Tentar de novo
          </button>
        }
      />
    );
  } else {
    content = (
      <EmptyState
        icon="bolt"
        className="usage-overview__empty"
        title={workspacePath ? 'Ainda sem leitura de custo' : 'Abra um projeto para ver o custo'}
        body={
          <p>
            {workspacePath
              ? 'O custo é lido das sessões registradas neste projeto. Se o Nexus acabou de abrir, a primeira leitura chega em instantes; se não chegar, leia de novo.'
              : 'O custo por ferramenta é lido das sessões registradas em cada projeto.'}
          </p>
        }
        action={
          workspacePath ? (
            <button type="button" className="settings-btn" onClick={() => void hydrate(workspacePath)}>
              Ler de novo
            </button>
          ) : (
            <button type="button" className="settings-btn" onClick={() => openSettings('providers')}>
              Ver conexões de IA
            </button>
          )
        }
      />
    );
  }
  return (
    <section className="usage-overview" aria-labelledby={titleId} aria-busy={loading}>
      <h2 className="usage-overview__title" id={titleId}>
        Custo e consumo por ferramenta
      </h2>
      {content}
    </section>
  );
}

export function UsageOverview() {
  const titleId = useId();
  const analytics = useUsageStore((state) => state.snapshot.analytics);
  if (!analytics) return <UsageOverviewEmpty titleId={titleId} />;
  return <UsageOverviewPanel analytics={analytics} titleId={titleId} />;
}

/** Atravessou a meia-noite com a tela aberta: pede uma leitura nova em vez de seguir chamando ontem de "hoje". */
function useRefreshAcrossMidnight(today: string): void {
  const now = useMinuteTick();
  const hydrate = useUsageStore((state) => state.hydrate);
  const workspacePath = useWorkspaceStore((state) => state.current?.path ?? null);
  // Enquanto o "hoje" da leitura estiver velho, tenta de novo a cada minuto.
  const retryAt = localDayKey(now) !== today ? now : null;
  useEffect(() => {
    if (retryAt !== null && workspacePath) void hydrate(workspacePath);
  }, [retryAt, workspacePath, hydrate]);
}

function UsageOverviewPanel({ analytics, titleId }: { analytics: UsageAnalytics; titleId: string }) {
  const chartTitleId = useId();
  const totalsTitleId = useId();
  const breakdownTitleId = useId();
  const openSettings = useProductNavigationStore((state) => state.openSettings);
  const { today } = analytics;
  useRefreshAcrossMidnight(today);
  const [period, setPeriod] = useState<Period>({ kind: 'preset', days: USAGE_DEFAULT_WINDOW });
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const [breakdown, setBreakdown] = useState<BreakdownMode>('model');
  const [day, setDay] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const dayFieldRef = useRef<HTMLInputElement>(null);

  const earliestDay = usageWindowStartDay(today, USAGE_ANALYTICS_MAX_DAYS);
  const range = useMemo(
    () =>
      period.kind === 'preset'
        ? { from: usageWindowStartDay(today, period.days), to: today }
        : clampUsageRange(today, period.from, period.to),
    [period, today],
  );
  // O período sem filtro: de onde saem as opções de ferramenta e modelo.
  const scope = useMemo(() => summarizeUsage(analytics, range), [analytics, range]);
  // Estado que ficou sem dado no período novo some, e o que a tela diz é o que vale.
  const activeProvider =
    provider !== null && scope.byProvider.some((row) => row.provider === provider) ? provider : null;
  const activeModel =
    activeProvider !== null &&
    model !== null &&
    scope.byModel.some((row) => row.provider === activeProvider && row.model === model)
      ? model
      : null;
  const activeDay = day !== null && day >= range.from && day <= range.to ? day : null;
  const filtered = activeDay !== null || activeProvider !== null || activeModel !== null;
  // O que ficou sem dado no período novo não só some da tela: sai do estado, senão
  // voltaria sozinho ao revisitar o período antigo, sem "Limpar filtros" para soltá-lo.
  useEffect(() => {
    if (provider !== activeProvider) setProvider(null);
    if (model !== activeModel) setModel(null);
    if (day !== activeDay) setDay(null);
  }, [provider, activeProvider, model, activeModel, day, activeDay]);

  // Slots pelo conjunto dos 90 dias: trocar período ou filtro não repinta ninguém.
  const slots = useMemo(
    () =>
      assignUsageSeries(
        summarizeUsage(analytics, { from: earliestDay, to: today }).byProvider.map((row) => row.provider),
      ),
    [analytics, earliestDay, today],
  );
  // Gráfico e tabela por dia: o período inteiro, com ferramenta e modelo aplicados.
  const chart = useMemo(
    () => summarizeUsage(analytics, { ...range, provider: activeProvider, model: activeModel }),
    [analytics, range, activeProvider, activeModel],
  );
  // Totais, lista e tabela por modelo: o dia fixado, se houver, senão o período.
  const view = useMemo(
    () =>
      activeDay === null
        ? chart
        : summarizeUsage(analytics, {
            from: activeDay,
            to: activeDay,
            provider: activeProvider,
            model: activeModel,
          }),
    [analytics, chart, activeDay, activeProvider, activeModel],
  );
  const series = useMemo(
    () => chartSeriesFor(chart.byProvider.map((row) => row.provider), slots),
    [chart, slots],
  );
  const scopeEmpty = scope.totals.processedTokens === 0 && scope.totals.costUsd === 0;
  const viewEmpty = view.totals.processedTokens === 0 && view.totals.costUsd === 0;
  const periodKey: PeriodKey = period.kind === 'preset' ? period.days : 'custom';
  // "30 dias", "qua., 8 de out." ou "8 out a 12 out" — e a mesma frase com a preposição.
  const periodText =
    activeDay !== null
      ? dayLongLabel(activeDay)
      : period.kind === 'preset'
        ? `${period.days} dias`
        : formatRangeLabel(range.from, range.to);
  const periodPhrase = `${activeDay === null && period.kind === 'custom' ? 'de' : 'em'} ${periodText}`;

  const selectPeriod = (key: PeriodKey) => {
    setPeriod(
      key === 'custom'
        ? { kind: 'custom', from: range.from, to: range.to }
        : { kind: 'preset', days: key },
    );
  };
  // De e Até se limitam entre si por min/max: "de" nunca passa de "até".
  const setCustomFrom = (value: string) => setPeriod({ kind: 'custom', from: value, to: range.to });
  const setCustomTo = (value: string) => setPeriod({ kind: 'custom', from: range.from, to: value });
  const clearFilters = () => {
    setDay(null);
    setProvider(null);
    setModel(null);
    // O botão some junto com o último filtro: o foco vai para o campo mais perto, não para o body.
    dayFieldRef.current?.focus();
  };

  const header = (
    <header className="usage-overview__head">
      <div className="usage-overview__intro">
        <h2 className="usage-overview__title" id={titleId}>
          Custo e consumo por ferramenta
        </h2>
        <p className="usage-overview__hint">
          Estimativa em preço de API pública, lida das sessões deste projeto (Claude Code, Codex e
          MiMo Code registram tokens; as outras ferramentas ainda não entram na conta). Não é
          fatura: a assinatura cobre o uso dentro do plano. Atualiza com o uso, no máximo uma vez
          por minuto.
        </p>
      </div>
      <div className="usage-overview__controls">
        <Segmented label="Medida" options={METRICS} value={metric} onChange={setMetric} />
        <Segmented label="Período" options={PERIODS} value={periodKey} onChange={selectPeriod} />
      </div>
    </header>
  );

  const rangeFields =
    period.kind === 'custom' ? (
      <div className="usage-filters" role="group" aria-label="Intervalo de datas">
        <DateField label="De" value={range.from} min={earliestDay} max={range.to} onCommit={setCustomFrom} />
        <DateField label="Até" value={range.to} min={range.from} max={today} onCommit={setCustomTo} />
      </div>
    ) : null;

  // Modelos do período; sem ferramenta escolhida e com mais de uma, agrupados por ela.
  const modelGroups = (
    activeProvider === null && scope.byProvider.length > 1
      ? scope.byProvider.map((row) => row.provider)
      : [null]
  ).map((groupProvider) => ({
    provider: groupProvider,
    options: scope.byModel.filter(
      (row) =>
        (activeProvider === null || row.provider === activeProvider) &&
        (groupProvider === null || row.provider === groupProvider),
    ),
  }));

  const byMetric = <T extends { costUsd: number; totalTokens: number }>(rows: readonly T[]): T[] =>
    metric === 'cost'
      ? [...rows]
      : [...rows].sort((a, b) => b.totalTokens - a.totalTokens || b.costUsd - a.costUsd);
  const { totals } = view;
  const heroTexts = usageMeasureTexts(metric, totals.costUsd, totals.processedTokens);
  const sessionsText = totals.sessions > 0 ? pluralize(totals.sessions, 'sessão', 'sessões') : null;
  const heroSub =
    metric === 'cost'
      ? [heroTexts.secondary, sessionsText, `estimativa de API ${periodPhrase}`]
      : [`${heroTexts.secondary} em API (estimativa)`, sessionsText, periodText];

  // Mesma estrutura nos dois ramos (cabeçalho + faixa de filtros): o React mantém os
  // campos De/Até montados, e o foco não se perde quando o intervalo fica sem consumo.
  const filtersBar = (
    <div className="usage-overview__filters">
      {rangeFields}
      {scopeEmpty ? null : (
        <div className="usage-filters" role="group" aria-label="Filtros do painel">
          <DateField
            label="Dia"
            value={activeDay ?? ''}
            min={range.from}
            max={range.to}
            allowClear
            inputRef={dayFieldRef}
            onCommit={(next) => setDay(next === '' ? null : next)}
          />
          <label className="usage-filter">
            <span className="usage-filter__label">Ferramenta</span>
            <select
              className="settings-input usage-filter__control"
              value={activeProvider ?? ''}
              onChange={(event) => {
                setProvider(event.target.value || null);
                setModel(null);
              }}
            >
              <option value="">Todas</option>
              {scope.byProvider.map((row) => (
                <option key={row.provider} value={row.provider}>
                  {usageProviderLabel(row.provider)}
                </option>
              ))}
            </select>
          </label>
          <label className="usage-filter">
            <span className="usage-filter__label">Modelo</span>
            <select
              className="settings-input usage-filter__control"
              value={activeModel === null ? '' : modelOptionValue(activeProvider!, activeModel)}
              onChange={(event) => {
                const picked = parseModelOption(event.target.value);
                setProvider(picked?.provider ?? activeProvider);
                setModel(picked?.model ?? null);
              }}
            >
              <option value="">Todos</option>
              {modelGroups.map(({ provider: groupProvider, options }) => {
                const items = options.map((row) => (
                  <option key={`${row.provider}/${row.model}`} value={modelOptionValue(row.provider, row.model)}>
                    {row.model}
                  </option>
                ));
                return groupProvider === null ? (
                  items
                ) : (
                  <optgroup key={groupProvider} label={usageProviderLabel(groupProvider)}>
                    {items}
                  </optgroup>
                );
              })}
            </select>
          </label>
          {filtered ? (
            <button type="button" className="settings-btn usage-filters__clear" onClick={clearFilters}>
              Limpar filtros
            </button>
          ) : null}
        </div>
      )}
    </div>
  );

  const rangeTotal = metric === 'cost' ? chart.totals.costUsd : chart.totals.processedTokens;
  const dayRows = chart.days.filter((point) => point.costUsd > 0 || point.totalTokens > 0);
  const breakdownRows =
    breakdown === 'model'
      ? byMetric(view.byModel).map((row) => ({
          key: `${row.provider}/${row.model}`,
          provider: row.provider,
          day: null as string | null,
          label: row.model,
          costUsd: row.costUsd,
          share: metric === 'cost' ? row.costShare : row.tokenShare,
          totalTokens: row.totalTokens,
        }))
      : [...dayRows].reverse().map((point) => ({
          key: point.day,
          provider: null,
          day: point.day as string | null,
          label: dayLongLabel(point.day),
          costUsd: point.costUsd,
          share: rangeTotal > 0 ? (metric === 'cost' ? point.costUsd : point.totalTokens) / rangeTotal : 0,
          totalTokens: point.totalTokens,
        }));
  const tableKey = [breakdown, range.from, range.to, activeDay, activeProvider, activeModel, metric].join('|');
  const showAll = expandedKey === tableKey;
  const visibleRows = showAll ? breakdownRows : breakdownRows.slice(0, BREAKDOWN_PREVIEW);
  const shareHeader = metric === 'cost' ? '% do custo' : '% dos tokens';

  if (scopeEmpty) {
    return (
      <section className="usage-overview" aria-labelledby={titleId}>
        {header}
        {filtersBar}
        <EmptyState
          icon="bolt"
          className="usage-overview__empty"
          title={
            period.kind === 'preset'
              ? `Sem consumo nos últimos ${period.days} dias neste projeto`
              : `Sem consumo de ${formatRangeLabel(range.from, range.to)} neste projeto`
          }
          body={<p>Cada turno das IAs entra no dia em que aconteceu e aparece aqui com o custo estimado.</p>}
          action={
            periodKey !== 90 ? (
              <button type="button" className="settings-btn" onClick={() => selectPeriod(90)}>
                Ver 90 dias
              </button>
            ) : (
              <button type="button" className="settings-btn" onClick={() => openSettings('providers')}>
                Ver conexões de IA
              </button>
            )
          }
        />
      </section>
    );
  }

  return (
    <section className="usage-overview" aria-labelledby={titleId}>
      {header}
      {filtersBar}
      <div className="usage-overview__top">
        <div className="usage-overview__summary">
          {viewEmpty ? (
            <EmptyState
              icon="bolt"
              className="usage-overview__empty"
              title={activeDay !== null ? `Sem consumo em ${dayLongLabel(activeDay)}` : 'Sem consumo neste recorte'}
              body={<p>Nenhuma sessão registrou tokens com os filtros atuais. Escolha outro dia no gráfico ou limpe os filtros.</p>}
              action={
                <button type="button" className="settings-btn" onClick={clearFilters}>
                  Limpar filtros
                </button>
              }
            />
          ) : (
            <>
              <div className="usage-overview__hero-wrap" aria-live="polite" aria-atomic="true">
                <p className="usage-overview__hero">
                  {usageMeasureValue(metric, totals.costUsd, totals.processedTokens)}
                  {metric === 'tokens' ? (
                    <>
                      {' '}
                      <span className="usage-overview__hero-unit">
                        {Math.round(totals.processedTokens) === 1 ? 'token' : 'tokens'}
                      </span>
                    </>
                  ) : null}
                </p>
                <p className="usage-overview__hero-sub">{heroSub.filter(Boolean).join(' · ')}</p>
              </div>
              <ul
                className="usage-overview__providers"
                aria-label={metric === 'cost' ? 'Custo por ferramenta' : 'Tokens por ferramenta'}
              >
                {byMetric(view.byProvider).map((row) => {
                  const label = usageProviderLabel(row.provider);
                  const other = usageMeasureTexts(metric, row.costUsd, row.totalTokens).secondary;
                  const share = metric === 'cost' ? row.costShare : row.tokenShare;
                  return (
                    <li key={row.provider} className="usage-provider" data-provider={row.provider}>
                      <span
                        className="usage-provider__dot"
                        style={usageSeriesStyle(slots.get(row.provider))}
                        aria-hidden="true"
                      />
                      <ProviderLogo adapterId={row.provider} label={label} size="sm" />
                      <span className="usage-provider__name">
                        {label}
                        {row.sessions > 0 ? (
                          <span className="usage-provider__sessions">
                            {pluralize(row.sessions, 'sessão', 'sessões')}
                          </span>
                        ) : null}
                      </span>
                      <span className="usage-provider__cost">
                        {usageMeasureValue(metric, row.costUsd, row.totalTokens)}
                      </span>
                      <span className="usage-provider__meta">
                        {formatSharePercent(share)} {metric === 'cost' ? 'do custo' : 'dos tokens'} · {other}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
        <div className="usage-overview__chart">
          <h3 className="usage-overview__subtitle" id={chartTitleId}>
            {metric === 'cost' ? 'Custo diário' : 'Tokens por dia'}
          </h3>
          <UsageDailyChart
            days={chart.days}
            today={today}
            metric={metric}
            series={series}
            selectedDay={activeDay}
            onSelectDay={setDay}
            titleId={chartTitleId}
          />
        </div>
      </div>

      {viewEmpty ? null : (
        <section className="usage-overview__block" aria-labelledby={totalsTitleId}>
          <h3 className="usage-overview__subtitle" id={totalsTitleId}>
            Totais
          </h3>
          <dl className="usage-totals">
            <div className="usage-totals__item">
              <dt>Tokens processados</dt>
              <dd>{formatTokenCount(totals.processedTokens)}</dd>
            </div>
            <div className="usage-totals__item">
              <dt>Input em cache</dt>
              <dd>{formatTokenCount(totals.cachedInputTokens)}</dd>
            </div>
            <div className="usage-totals__item">
              <dt>Input sem cache</dt>
              <dd>{formatTokenCount(totals.uncachedInputTokens)}</dd>
            </div>
            <div className="usage-totals__item">
              <dt>Output</dt>
              <dd>{formatTokenCount(totals.outputTokens)}</dd>
            </div>
            <div className="usage-totals__item usage-totals__item--savings">
              <dt title="Tokens lidos do cache × (preço de input − preço de leitura de cache), pela tabela de preços de cada modelo.">
                Economia de cache
              </dt>
              <dd>{formatUsdAmount(totals.cacheSavingsUsd)}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className="usage-overview__block" aria-labelledby={breakdownTitleId}>
        <div className="usage-overview__block-head">
          <h3 className="usage-overview__subtitle" id={breakdownTitleId}>
            Detalhamento
          </h3>
          <Segmented label="Detalhar por" options={BREAKDOWNS} value={breakdown} onChange={setBreakdown} />
        </div>
        <div className="usage-breakdown__scroll">
          <table className="usage-breakdown">
            <caption className="settings-visually-hidden">
              {breakdown === 'model'
                ? `Custo e tokens por modelo ${periodPhrase}`
                : `Custo e tokens por dia, ${formatRangeLabel(range.from, range.to)}`}
            </caption>
            <thead>
              <tr>
                <th scope="col">{breakdown === 'model' ? 'Modelo' : 'Dia'}</th>
                <th scope="col">Custo</th>
                <th scope="col">{shareHeader}</th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td className="usage-breakdown__none" colSpan={4}>
                    Sem consumo neste recorte.
                  </td>
                </tr>
              ) : null}
              {visibleRows.map((row) => (
                <tr key={row.key} data-selected={row.day !== null && row.day === activeDay ? 'true' : undefined}>
                  <th scope="row">
                    <span className="usage-breakdown__label">
                      {row.provider ? (
                        <ProviderLogo adapterId={row.provider} label={usageProviderLabel(row.provider)} size="xs" />
                      ) : null}
                      {row.day !== null ? (
                        <button
                          type="button"
                          className="usage-breakdown__pick"
                          aria-pressed={row.day === activeDay}
                          title={row.day === activeDay ? 'Voltar ao período inteiro' : 'Ver só este dia'}
                          onClick={() => setDay(row.day === activeDay ? null : row.day)}
                        >
                          {row.label}
                        </button>
                      ) : (
                        <span className="usage-breakdown__name" title={row.label}>
                          {row.label}
                        </span>
                      )}
                    </span>
                  </th>
                  <td>{formatUsdAmount(row.costUsd)}</td>
                  <td>{formatSharePercent(row.share)}</td>
                  <td>{formatTokenCount(row.totalTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {breakdownRows.length > BREAKDOWN_PREVIEW ? (
          <button
            type="button"
            className="settings-btn usage-overview__more"
            aria-expanded={showAll}
            onClick={() => setExpandedKey(showAll ? null : tableKey)}
          >
            {showAll ? 'Mostrar menos' : `Mostrar todas (${breakdownRows.length})`}
          </button>
        ) : null}
      </section>
    </section>
  );
}
