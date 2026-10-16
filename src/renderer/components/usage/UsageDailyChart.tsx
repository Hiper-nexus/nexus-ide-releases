import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { UsageDayPoint, UsageWindowDays } from '../../../shared/usage-types';
import { fillUsageWindow, type UsageFilledDay } from '../../../shared/usage-analytics';
import { niceCeiling } from '../../lib/usage-history-chart';
import {
  dayLongLabel,
  dayTickLabel,
  formatTokenCount,
  formatUsdAmount,
  formatUsdAxis,
  usageProviderLabel,
  usageSeriesStyle,
} from '../../lib/usage-overview';

/**
 * "Custo diário": uma curva por ferramenta, sobrepostas (não empilhadas), no
 * registro do Fleet Pulse — fios de borda no grid, cor só na série. A cor é a
 * da ferramenta (um dos `--series-1..6`), a mesma do ponto na lista ao lado, que é a
 * legenda. A leitura do dia (ponteiro ou setas) diz os valores em texto.
 */

export type UsageChartMetric = 'cost' | 'tokens';

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

function seriesValue(point: UsageFilledDay, series: UsageChartSeries, metric: UsageChartMetric): number {
  let total = 0;
  for (const provider of series.providers) {
    const slice = point.byProvider[provider];
    if (!slice) continue;
    total += metric === 'cost' ? slice.costUsd : slice.totalTokens;
  }
  return total;
}

function formatValue(value: number, metric: UsageChartMetric): string {
  return metric === 'cost' ? formatUsdAmount(value) : formatTokenCount(value);
}

function formatAxis(value: number, metric: UsageChartMetric): string {
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
  readonly days: readonly UsageDayPoint[];
  readonly today: string;
  readonly windowDays: UsageWindowDays;
  readonly metric: UsageChartMetric;
  /** Da maior para a menor no custo da janela; a maior é desenhada por cima. */
  readonly series: readonly UsageChartSeries[];
  readonly titleId: string;
}

export function UsageDailyChart({ days, today, windowDays, metric, series, titleId }: UsageDailyChartProps) {
  const summaryId = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const points = useMemo(() => fillUsageWindow(days, windowDays, today), [days, windowDays, today]);
  const peak = Math.max(
    0,
    ...points.flatMap((point) => series.map((item) => seriesValue(point, item, metric))),
  );
  const top = niceCeiling(peak);
  const plotW = VIEW_W - PLOT_LEFT - PLOT_RIGHT;
  const x = (index: number) =>
    PLOT_LEFT + (points.length <= 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
  const y = (value: number) => PLOT_BOTTOM - (Math.max(0, value) / top) * (PLOT_BOTTOM - PLOT_TOP);
  const slot = points.length <= 1 ? plotW : plotW / (points.length - 1);
  const selectedPoint = selected === null ? null : (points[selected] ?? null);
  // A maior por último: fica por cima das outras.
  const drawOrder = [...series].reverse();

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const last = points.length - 1;
    const step: ((current: number | null) => number) | null =
      event.key === 'ArrowLeft'
        ? (current) => Math.max(0, (current ?? last + 1) - 1)
        : event.key === 'ArrowRight'
          ? (current) => Math.min(last, (current ?? -1) + 1)
          : event.key === 'Home'
            ? () => 0
            : event.key === 'End'
              ? () => last
              : null;
    if (event.key === 'Escape') {
      setSelected(null);
      return;
    }
    if (!step) return;
    event.preventDefault();
    setSelected(step);
  };

  const windowTotal = points.reduce(
    (sum, point) => sum + (metric === 'cost' ? point.costUsd : point.totalTokens),
    0,
  );
  const peakPoint = points.reduce<UsageFilledDay | null>((best, point) => {
    const value = metric === 'cost' ? point.costUsd : point.totalTokens;
    const bestValue = best ? (metric === 'cost' ? best.costUsd : best.totalTokens) : -1;
    return value > bestValue ? point : best;
  }, null);
  const summary = `${windowDays} dias, ${series.length} ${series.length === 1 ? 'ferramenta' : 'ferramentas'}: total ${formatValue(windowTotal, metric)}${
    peakPoint && (metric === 'cost' ? peakPoint.costUsd : peakPoint.totalTokens) > 0
      ? `; maior dia ${dayLongLabel(peakPoint.day)} com ${formatValue(metric === 'cost' ? peakPoint.costUsd : peakPoint.totalTokens, metric)}`
      : ''
  }. Use as setas para ler dia a dia.`;

  return (
    <div className="usage-chart">
      <p className="usage-chart__readout" aria-live="polite">
        {selectedPoint ? (
          <>
            <span className="usage-chart__readout-day">{dayLongLabel(selectedPoint.day)}</span>
            {series.map((item) => {
              const value = seriesValue(selectedPoint, item, metric);
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
            Passe o ponteiro ou use as setas para ler um dia.
          </span>
        )}
      </p>
      <svg
        className="usage-chart__svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setSelected(null)}
        onBlur={() => setSelected(null)}
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
        {selectedPoint && selected !== null ? (
          <g className="usage-chart__cursor" aria-hidden="true">
            <line x1={x(selected)} x2={x(selected)} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
            {series.map((item) => (
              <circle
                key={item.key}
                cx={x(selected)}
                cy={y(seriesValue(selectedPoint, item, metric))}
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
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
          >
            {index === points.length - 1 ? 'hoje' : dayTickLabel(points[index].day)}
          </text>
        ))}
        {/* Alvo do ponteiro na altura toda: o dia sem uso também se lê. */}
        {points.map((point, index) => (
          <rect
            key={point.day}
            className="usage-chart__hit"
            x={x(index) - slot / 2}
            y={PLOT_TOP}
            width={slot}
            height={PLOT_BOTTOM - PLOT_TOP}
            onMouseEnter={() => setSelected(index)}
          />
        ))}
      </svg>
      <p id={summaryId} className="usage-chart__summary">
        {summary}
      </p>
    </div>
  );
}

/** Ferramentas da janela → séries do gráfico, com "Outros" no fim. */
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
