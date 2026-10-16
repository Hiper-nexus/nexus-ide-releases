import { useId, useMemo, useState } from 'react';
import '../../styles/usage-overview.css';
import {
  USAGE_DEFAULT_WINDOW,
  USAGE_WINDOW_OPTIONS,
  type UsageAnalytics,
  type UsageWindowDays,
} from '../../../shared/usage-types';
import { fillUsageWindow } from '../../../shared/usage-analytics';
import { useUsageStore } from '../../state/usage-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { EmptyState } from '../ActionCard';
import { ProviderLogo } from '../ProviderLogo';
import {
  assignUsageSeries,
  dayLongLabel,
  formatSharePercent,
  formatTokenCount,
  formatUsdAmount,
  pluralize,
  usageProviderLabel,
  usageSeriesStyle,
} from '../../lib/usage-overview';
import {
  UsageDailyChart,
  chartSeriesFor,
  type UsageChartMetric,
} from './UsageDailyChart';

/**
 * Topo de Uso e custos, na composição do painel "Usage" do T3: à esquerda o
 * custo estimado em destaque e a lista de ferramentas (que é a legenda do
 * gráfico), à direita o custo diário, embaixo Totais e Detalhamento. Fonte:
 * `UsageSnapshot.analytics` do projeto aberto — equivalente de API pública,
 * nunca fatura. Período e medida valem para o painel inteiro.
 */

type BreakdownMode = 'model' | 'day';

const METRICS: readonly { key: UsageChartMetric; label: string }[] = [
  { key: 'cost', label: 'Custo' },
  { key: 'tokens', label: 'Tokens' },
];

const BREAKDOWNS: readonly { key: BreakdownMode; label: string }[] = [
  { key: 'model', label: 'Modelo' },
  { key: 'day', label: 'Dia' },
];

/** Linhas visíveis do Detalhamento antes de "Mostrar todas". */
const BREAKDOWN_PREVIEW = 10;

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

function UsageOverviewEmpty({ titleId }: { titleId: string }) {
  const workspacePath = useWorkspaceStore((state) => state.current?.path ?? null);
  const hydrate = useUsageStore((state) => state.hydrate);
  const openSettings = useProductNavigationStore((state) => state.openSettings);
  return (
    <section className="usage-overview" aria-labelledby={titleId}>
      <h2 className="usage-overview__title" id={titleId}>
        Custo e consumo por ferramenta
      </h2>
      <EmptyState
        icon="bolt"
        className="usage-overview__empty"
        title={workspacePath ? 'Ainda sem leitura de custo' : 'Abra um projeto para ver o custo'}
        body={
          <p>
            {workspacePath
              ? 'O custo é lido das sessões registradas neste projeto. Se o Nexus acabou de abrir, a primeira leitura chega em instantes.'
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
    </section>
  );
}

export function UsageOverview() {
  const titleId = useId();
  const analytics = useUsageStore((state) => state.snapshot.analytics);
  if (!analytics) return <UsageOverviewEmpty titleId={titleId} />;
  return <UsageOverviewPanel analytics={analytics} titleId={titleId} />;
}

function UsageOverviewPanel({ analytics, titleId }: { analytics: UsageAnalytics; titleId: string }) {
  const chartTitleId = useId();
  const totalsTitleId = useId();
  const breakdownTitleId = useId();
  const openSettings = useProductNavigationStore((state) => state.openSettings);
  const [windowDays, setWindowDays] = useState<UsageWindowDays>(USAGE_DEFAULT_WINDOW);
  const [metric, setMetric] = useState<UsageChartMetric>('cost');
  const [breakdown, setBreakdown] = useState<BreakdownMode>('model');
  const [showAll, setShowAll] = useState(false);
  const summary = analytics.windows[windowDays];
  const { totals } = summary;
  // Slots pelo conjunto dos 90 dias: trocar o período não repinta ninguém.
  const slots = useMemo(
    () => assignUsageSeries(analytics.windows[90].byProvider.map((row) => row.provider)),
    [analytics],
  );
  const series = useMemo(
    () => chartSeriesFor(summary.byProvider.map((row) => row.provider), slots),
    [summary, slots],
  );
  const dayRows = useMemo(
    () =>
      fillUsageWindow(analytics.days, windowDays, analytics.today)
        .filter((day) => day.costUsd > 0 || day.totalTokens > 0)
        .reverse(),
    [analytics, windowDays],
  );
  const empty = totals.processedTokens === 0 && totals.costUsd === 0;
  const windowOptions = USAGE_WINDOW_OPTIONS.map((days) => ({ key: days, label: `${days} dias` }));

  const header = (
    <header className="usage-overview__head">
      <div className="usage-overview__intro">
        <h2 className="usage-overview__title" id={titleId}>
          Custo e consumo por ferramenta
        </h2>
        <p className="usage-overview__hint">
          Estimativa em preço de API pública, lida das sessões deste projeto. Não é fatura: a
          assinatura cobre o uso dentro do plano. Atualiza a cada minuto.
        </p>
      </div>
      <div className="usage-overview__controls">
        <Segmented label="Medida do gráfico" options={METRICS} value={metric} onChange={setMetric} />
        <Segmented
          label="Período"
          options={windowOptions}
          value={windowDays}
          onChange={(next) => {
            setWindowDays(next);
            setShowAll(false);
          }}
        />
      </div>
    </header>
  );

  if (empty) {
    return (
      <section className="usage-overview" aria-labelledby={titleId}>
        {header}
        <EmptyState
          icon="bolt"
          className="usage-overview__empty"
          title={`Sem consumo nos últimos ${windowDays} dias neste projeto`}
          body={<p>Cada turno das IAs entra no dia em que aconteceu e aparece aqui com o custo estimado.</p>}
          action={
            windowDays < 90 ? (
              <button type="button" className="settings-btn" onClick={() => setWindowDays(90)}>
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

  const breakdownRows =
    breakdown === 'model'
      ? summary.byModel.map((row) => ({
          key: `${row.provider}/${row.model}`,
          provider: row.provider,
          label: row.model,
          costUsd: row.costUsd,
          costShare: row.costShare,
          totalTokens: row.totalTokens,
        }))
      : dayRows.map((day) => ({
          key: day.day,
          provider: null,
          label: dayLongLabel(day.day),
          costUsd: day.costUsd,
          costShare: totals.costUsd > 0 ? day.costUsd / totals.costUsd : 0,
          totalTokens: day.totalTokens,
        }));
  const visibleRows = showAll ? breakdownRows : breakdownRows.slice(0, BREAKDOWN_PREVIEW);

  return (
    <section className="usage-overview" aria-labelledby={titleId}>
      {header}
      <div className="usage-overview__top">
        <div className="usage-overview__summary">
          <p className="usage-overview__hero">{formatUsdAmount(totals.costUsd)}</p>
          <p className="usage-overview__hero-sub">
            {pluralize(totals.sessions, 'sessão', 'sessões')} · estimativa de API em {windowDays} dias
          </p>
          <ul className="usage-overview__providers" aria-label="Custo por ferramenta">
            {summary.byProvider.map((row) => {
              const label = usageProviderLabel(row.provider);
              return (
                <li key={row.provider} className="usage-provider">
                  <span
                    className="usage-provider__dot"
                    style={usageSeriesStyle(slots.get(row.provider))}
                    aria-hidden="true"
                  />
                  <ProviderLogo adapterId={row.provider} label={label} size="sm" />
                  <span className="usage-provider__name">
                    {label}
                    <span className="usage-provider__sessions">
                      {pluralize(row.sessions, 'sessão', 'sessões')}
                    </span>
                  </span>
                  <span className="usage-provider__cost">{formatUsdAmount(row.costUsd)}</span>
                  <span className="usage-provider__meta">
                    {formatSharePercent(row.costShare)} do custo · {formatTokenCount(row.totalTokens)} tokens
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="usage-overview__chart">
          <h3 className="usage-overview__subtitle" id={chartTitleId}>
            {metric === 'cost' ? 'Custo diário' : 'Tokens por dia'}
          </h3>
          <UsageDailyChart
            days={analytics.days}
            today={analytics.today}
            windowDays={windowDays}
            metric={metric}
            series={series}
            titleId={chartTitleId}
          />
        </div>
      </div>

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

      <section className="usage-overview__block" aria-labelledby={breakdownTitleId}>
        <div className="usage-overview__block-head">
          <h3 className="usage-overview__subtitle" id={breakdownTitleId}>
            Detalhamento
          </h3>
          <Segmented
            label="Detalhar por"
            options={BREAKDOWNS}
            value={breakdown}
            onChange={(next) => {
              setBreakdown(next);
              setShowAll(false);
            }}
          />
        </div>
        <table className="usage-breakdown">
          <caption className="settings-visually-hidden">
            {breakdown === 'model' ? 'Custo por modelo' : 'Custo por dia'} nos últimos {windowDays} dias
          </caption>
          <thead>
            <tr>
              <th scope="col">{breakdown === 'model' ? 'Modelo' : 'Dia'}</th>
              <th scope="col">Custo</th>
              <th scope="col">Participação</th>
              <th scope="col">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <span className="usage-breakdown__label">
                    {row.provider ? (
                      <ProviderLogo adapterId={row.provider} label={usageProviderLabel(row.provider)} size="xs" />
                    ) : null}
                    <span className="usage-breakdown__name" title={row.label}>
                      {row.label}
                    </span>
                  </span>
                </th>
                <td>{formatUsdAmount(row.costUsd)}</td>
                <td>{formatSharePercent(row.costShare)}</td>
                <td>{formatTokenCount(row.totalTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {breakdownRows.length > BREAKDOWN_PREVIEW ? (
          <button
            type="button"
            className="settings-btn usage-overview__more"
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? 'Mostrar menos' : `Mostrar todas (${breakdownRows.length})`}
          </button>
        ) : null}
      </section>
    </section>
  );
}
