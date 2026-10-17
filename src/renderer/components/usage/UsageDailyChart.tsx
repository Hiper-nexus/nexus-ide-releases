import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { UsageDayPoint, UsageMetric } from '../../../shared/usage-types';
import { usageDayStats } from '../../../shared/usage-analytics';
import { niceCeiling } from '../../lib/usage-history-chart';
import {
  dayLongLabel,
  dayTickLabel,
  formatTokenCount,
  formatUsdAmount,
  formatUsdAxis,
  pluralize,
  usageMeasureTexts,
  usageProviderLabel,
  usageSeriesStyle,
} from '../../lib/usage-overview';

/**
 * "Custo diário" / "Tokens por dia": uma curva por ferramenta, sobrepostas
 * (não empilhadas), no registro do Fleet Pulse — fios de borda no grid, cor só
 * na série. A cor é a da ferramenta (um dos `--series-1..6`), a mesma do ponto
 * na lista ao lado, que é a legenda. Com mais de uma ferramenta, um fio neutro
 * soma o dia. Acima do desenho, total, pico e média do período; sobre ele, o
 * pico, a média por dia com uso e o dia fixado (acento: é o item selecionado).
 * A leitura do dia (ponteiro ou setas) diz os valores em texto; clique ou
 * Enter fixa o dia e o painel inteiro passa a mostrar só ele.
 */

/** Uma série do gráfico: uma ferramenta, ou "Outros" dobrando as sem slot. */
export interface UsageChartSeries {
  readonly key: string;
  readonly label: string;
  readonly slot: number | null;
  /** Ferramentas somadas nesta série (uma, salvo "Outros"). */
  readonly providers: readonly string[];
}

const VIEW_W = 640;
const VIEW_H = 224;
const PLOT_LEFT = 52;
const PLOT_RIGHT = 10;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 190;
const LABEL_Y = 210;
const GRID_STEPS = 4;
/** Até aqui cada dia com uso ganha um ponto: o dado é diário, não contínuo. */
const MAX_DOTTED_DAYS = 31;

function seriesValue(point: UsageDayPoint, series: UsageChartSeries, metric: UsageMetric): number {
  let total = 0;
  for (const provider of series.providers) {
    const slice = point.byProvider[provider];
    if (!slice) continue;
    total += metric === 'cost' ? slice.costUsd : slice.totalTokens;
  }
  return total;
}

function dayValue(point: UsageDayPoint, metric: UsageMetric): number {
  return metric === 'cost' ? point.costUsd : point.totalTokens;
}

function formatValue(value: number, metric: UsageMetric): string {
  return metric === 'cost' ? formatUsdAmount(value) : formatTokenCount(value);
}

function formatAxis(value: number, metric: UsageMetric): string {
  return metric === 'cost' ? formatUsdAxis(value) : formatTokenCount(value);
}

/**
 * Curva monótona (Fritsch–Carlson): suave como a referência, mas nunca passa
 * abaixo de zero nem inventa um pico entre dois dias.
 */
function monotonePath(points: readonly (readonly [number, number])[]): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M${points[0][0]},${points[0][1]}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push(dx[i] === 0 ? 0 : (points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const tangent: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) {
    tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  }
  tangent.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangent[i] = t * a * slope[i];
      tangent[i + 1] = t * b * slope[i];
    }
  }
  const fmt = (value: number) => Number(value.toFixed(2));
  let d = `M${fmt(points[0][0])},${fmt(points[0][1])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += `C${fmt(x0 + h)},${fmt(y0 + tangent[i] * h)} ${fmt(x1 - h)},${fmt(y1 - tangent[i + 1] * h)} ${fmt(x1)},${fmt(y1)}`;
  }
  return d;
}

function tickIndexes(length: number): number[] {
  if (length <= 8) return Array.from({ length }, (_, index) => index);
  const last = length - 1;
  return [...new Set([0, Math.round(last / 2), last])];
}

export interface UsageDailyChartProps {
  /** Um ponto por dia do período, já com os filtros aplicados. */
  readonly days: readonly UsageDayPoint[];
  /** Dia local de hoje: só ele é rotulado "hoje" no eixo. */
  readonly today: string;
  readonly metric: UsageMetric;
  /** Da maior para a menor no custo do período; a maior é desenhada por cima. */
  readonly series: readonly UsageChartSeries[];
  /** Dia fixado (YYYY-MM-DD): realçado aqui; o resto do painel mostra só ele. */
  readonly selectedDay: string | null;
  readonly onSelectDay: (day: string | null) => void;
  readonly titleId: string;
}

export function UsageDailyChart({ days, today, metric, series, selectedDay, onSelectDay, titleId }: UsageDailyChartProps) {
  const summaryId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  /** Ponteiro ou setas: leitura passageira; o dia fixado é a escolha que fica. */
  const [cursor, setCursor] = useState<number | null>(null);
  const points = days;
  const stats = useMemo(() => usageDayStats(points, metric), [points, metric]);
  const peak = Math.max(0, ...points.map((point) => dayValue(point, metric)));
  const top = niceCeiling(peak);
  const plotW = VIEW_W - PLOT_LEFT - PLOT_RIGHT;
  const x = (index: number) =>
    PLOT_LEFT + (points.length <= 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
  const y = (value: number) => PLOT_BOTTOM - (Math.max(0, value) / top) * (PLOT_BOTTOM - PLOT_TOP);
  const slot = points.length <= 1 ? plotW : plotW / (points.length - 1);
  const pinnedIndex = selectedDay === null ? -1 : points.findIndex((point) => point.day === selectedDay);
  const focusIndex = cursor ?? (pinnedIndex >= 0 ? pinnedIndex : null);
  const focusPoint = focusIndex === null ? null : (points[focusIndex] ?? null);
  // A maior por último: fica por cima das outras.
  const drawOrder = [...series].reverse();
  const showTotal = series.length > 1;
  const average = metric === 'cost' ? stats.averageCostUsd : stats.averageTokens;
  const peakIndex = stats.peak ? points.findIndex((point) => point.day === stats.peak!.day) : -1;
  const dotted = points.length <= MAX_DOTTED_DAYS;
  const totalCoords = points.map((point, index) => [x(index), y(dayValue(point, metric))] as const);
  const bandLeft = (index: number) => Math.max(PLOT_LEFT, x(index) - slot / 2);
  const bandRight = (index: number) => Math.min(VIEW_W - PLOT_RIGHT, x(index) + slot / 2);

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const last = points.length - 1;
    if (event.key === 'Escape') {
      // Primeiro some a leitura; com ela já fechada, Esc solta o dia fixado.
      if (cursor !== null) setCursor(null);
      else onSelectDay(null);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const target = focusPoint;
      if (!target) return;
      event.preventDefault();
      onSelectDay(target.day === selectedDay ? null : target.day);
      return;
    }
    const step: ((current: number | null) => number) | null =
      event.key === 'ArrowLeft'
        ? (current) => Math.max(0, (current ?? (pinnedIndex >= 0 ? pinnedIndex : last + 1)) - 1)
        : event.key === 'ArrowRight'
          ? (current) => Math.min(last, (current ?? (pinnedIndex >= 0 ? pinnedIndex : -1)) + 1)
          : event.key === 'Home'
            ? () => 0
            : event.key === 'End'
              ? () => last
              : null;
    if (!step) return;
    event.preventDefault();
    setCursor(step);
  };

  const totalTexts = usageMeasureTexts(metric, stats.costUsd, stats.totalTokens);
  const peakTexts = stats.peak ? usageMeasureTexts(metric, stats.peak.costUsd, stats.peak.totalTokens) : null;
  const averageTexts = usageMeasureTexts(metric, stats.averageCostUsd, stats.averageTokens);
  const activeLabel = `${stats.activeDays} de ${pluralize(stats.dayCount, 'dia', 'dias')} com uso`;
  const summary = `${pluralize(stats.dayCount, 'dia', 'dias')}, ${series.length} ${series.length === 1 ? 'ferramenta' : 'ferramentas'}: total ${totalTexts.primary} (${totalTexts.secondary})${
    peakTexts && stats.peak
      ? `; maior dia ${dayLongLabel(stats.peak.day)} com ${peakTexts.primary} (${peakTexts.secondary})`
      : ''
  }; média ${averageTexts.primary} (${averageTexts.secondary}) por dia com uso, ${activeLabel}. Use as setas para ler dia a dia e Enter para ver só um dia.`;

  return (
    <div className="usage-chart">
      <dl className="usage-chart__stats">
        <div className="usage-chart__stat">
          <dt>Total do período</dt>
          <dd>{totalTexts.primary}</dd>
          <dd className="usage-chart__stat-sub">{totalTexts.secondary}</dd>
        </div>
        <div className="usage-chart__stat">
          <dt>Pico em um dia</dt>
          <dd>{peakTexts ? peakTexts.primary : '—'}</dd>
          <dd className="usage-chart__stat-sub">
            {stats.peak && peakTexts ? `${dayLongLabel(stats.peak.day)} · ${peakTexts.secondary}` : 'sem uso'}
          </dd>
        </div>
        <div className="usage-chart__stat">
          <dt>Média por dia com uso</dt>
          <dd>{stats.activeDays > 0 ? averageTexts.primary : '—'}</dd>
          <dd className="usage-chart__stat-sub">
            {stats.activeDays > 0 ? `${activeLabel} · ${averageTexts.secondary}` : 'sem uso'}
          </dd>
        </div>
      </dl>
      <div className="usage-chart__readout-row">
        <p className="usage-chart__readout" aria-live="polite">
          {focusPoint ? (
            <>
              <span className="usage-chart__readout-day">
                {dayLongLabel(focusPoint.day)}
                {focusPoint.day === selectedDay ? ' · dia fixado' : ''}
              </span>
              {showTotal ? (
                <span className="usage-chart__readout-item">
                  Total{' '}
                  <strong>{usageMeasureTexts(metric, focusPoint.costUsd, focusPoint.totalTokens).primary}</strong>
                  <span className="usage-chart__readout-other">
                    {usageMeasureTexts(metric, focusPoint.costUsd, focusPoint.totalTokens).secondary}
                  </span>
                </span>
              ) : null}
              {series.map((item) => {
                const value = seriesValue(focusPoint, item, metric);
                return (
                  <span key={item.key} className="usage-chart__readout-item">
                    <span
                      className="usage-chart__swatch"
                      style={usageSeriesStyle(item.slot)}
                      aria-hidden="true"
                    />
                    {item.label} <strong>{formatValue(value, metric)}</strong>
                  </span>
                );
              })}
            </>
          ) : (
            <span className="usage-chart__readout-hint">
              Passe o ponteiro ou use as setas para ler um dia. Clique ou aperte Enter para ver só ele.
            </span>
          )}
        </p>
        {selectedDay !== null && pinnedIndex >= 0 ? (
          <button
            type="button"
            className="settings-btn"
            onClick={() => {
              onSelectDay(null);
              // O botão some com o dia solto: o foco volta ao gráfico, não ao body.
              svgRef.current?.focus();
            }}
          >
            Ver o período inteiro
          </button>
        ) : null}
      </div>
      <svg
        ref={svgRef}
        className="usage-chart__svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setCursor(null)}
        onBlur={() => setCursor(null)}
      >
        {Array.from({ length: GRID_STEPS + 1 }, (_, index) => {
          const value = (top / GRID_STEPS) * index;
          return (
            <g key={index} className="usage-chart__grid">
              <line x1={PLOT_LEFT} x2={VIEW_W - PLOT_RIGHT} y1={y(value)} y2={y(value)} />
              <text x={PLOT_LEFT - 8} y={y(value) + 3} textAnchor="end">
                {formatAxis(value, metric)}
              </text>
            </g>
          );
        })}
        {pinnedIndex >= 0 ? (
          <g className="usage-chart__pin" aria-hidden="true">
            <rect
              x={bandLeft(pinnedIndex)}
              y={PLOT_TOP}
              width={bandRight(pinnedIndex) - bandLeft(pinnedIndex)}
              height={PLOT_BOTTOM - PLOT_TOP}
            />
            <line x1={x(pinnedIndex)} x2={x(pinnedIndex)} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
          </g>
        ) : null}
        {showTotal ? (
          <path className="usage-chart__total" d={monotonePath(totalCoords)} />
        ) : null}
        {drawOrder.map((item) => {
          const coords = points.map(
            (point, index) => [x(index), y(seriesValue(point, item, metric))] as const,
          );
          const line = monotonePath(coords);
          const area = `${line}L${x(points.length - 1)},${PLOT_BOTTOM}L${x(0)},${PLOT_BOTTOM}Z`;
          return (
            <g
              key={item.key}
              className="usage-chart__series"
              data-series={item.key}
              style={usageSeriesStyle(item.slot)}
            >
              <path className="usage-chart__area" d={area} />
              <path className="usage-chart__line" d={line} />
            </g>
          );
        })}
        <line
          className="usage-chart__baseline"
          x1={PLOT_LEFT}
          x2={VIEW_W - PLOT_RIGHT}
          y1={PLOT_BOTTOM}
          y2={PLOT_BOTTOM}
        />
        {stats.activeDays > 0 ? (
          <g className="usage-chart__average" aria-hidden="true">
            <line x1={PLOT_LEFT} x2={VIEW_W - PLOT_RIGHT} y1={y(average)} y2={y(average)} />
            <text x={PLOT_LEFT + 4} y={y(average) - 4} textAnchor="start">
              {`média ${formatValue(average, metric)}`}
            </text>
          </g>
        ) : null}
        {dotted ? (
          <g className="usage-chart__dots" aria-hidden="true">
            {points.map((point, index) =>
              dayValue(point, metric) > 0 ? (
                <circle
                  key={point.day}
                  data-day={point.day}
                  cx={x(index)}
                  cy={y(dayValue(point, metric))}
                  r={2.5}
                  style={series.length === 1 ? usageSeriesStyle(series[0]!.slot) : undefined}
                />
              ) : null,
            )}
          </g>
        ) : null}
        {peakIndex >= 0 ? (
          <circle
            className="usage-chart__peak"
            aria-hidden="true"
            cx={x(peakIndex)}
            cy={y(dayValue(points[peakIndex]!, metric))}
            r={5}
          />
        ) : null}
        {focusPoint && focusIndex !== null ? (
          <g className="usage-chart__cursor" aria-hidden="true">
            <line x1={x(focusIndex)} x2={x(focusIndex)} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
            {series.map((item) => (
              <circle
                key={item.key}
                cx={x(focusIndex)}
                cy={y(seriesValue(focusPoint, item, metric))}
                r={4}
                style={usageSeriesStyle(item.slot)}
              />
            ))}
          </g>
        ) : null}
        {tickIndexes(points.length).map((index) => (
          <text
            key={points[index].day}
            className="usage-chart__tick"
            x={x(index)}
            y={LABEL_Y}
            textAnchor={
              points.length === 1 ? 'middle' : index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'
            }
          >
            {points[index].day === today ? 'hoje' : dayTickLabel(points[index].day)}
          </text>
        ))}
        {/* Alvo do ponteiro na altura toda: o dia sem uso também se lê e se fixa.
            O teclado age no gráfico inteiro (setas, Enter), então o alvo é só do mouse e do toque. */}
        {points.map((point, index) => (
          <rect
            key={point.day}
            className="usage-chart__hit"
            x={bandLeft(index)}
            y={PLOT_TOP}
            width={bandRight(index) - bandLeft(index)}
            height={PLOT_BOTTOM - PLOT_TOP}
            onMouseEnter={() => setCursor(index)}
            onClick={() => onSelectDay(point.day === selectedDay ? null : point.day)}
          />
        ))}
      </svg>
      <p id={summaryId} className="usage-chart__summary">
        {summary}
      </p>
    </div>
  );
}

/** Ferramentas do período → séries do gráfico, com "Outros" no fim. */
export function chartSeriesFor(
  providers: readonly string[],
  slots: ReadonlyMap<string, number | null>,
): UsageChartSeries[] {
  const named: UsageChartSeries[] = [];
  const others: string[] = [];
  for (const provider of providers) {
    const slot = slots.get(provider) ?? null;
    if (slot === null) others.push(provider);
    else named.push({ key: provider, label: usageProviderLabel(provider), slot, providers: [provider] });
  }
  if (others.length > 0) {
    named.push({ key: 'outros', label: 'Outros', slot: null, providers: others });
  }
  return named;
}
