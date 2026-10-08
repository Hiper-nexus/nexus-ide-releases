import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { UsageHistory } from '../../../shared/usage-types';
import { fmtTokens, fmtUsd } from '../../lib/lifetime-format';
import {
  USAGE_HISTORY_SPAN_DAYS,
  buildUsageHistorySeries,
  metricValue,
  niceCeiling,
  type UsageHistoryMetric,
  type UsageHistoryPoint,
} from '../../lib/usage-history-chart';
import type { UsageHistoryStatus } from '../../state/usage-history';
import { EmptyState } from '../ActionCard';

/**
 * Histórico de uso (WEB-12): um dia, uma barra, nos últimos 30 dias, somando
 * todos os projetos. SVG puro no registro do Fleet Pulse — hairlines de borda,
 * barra em `--text-dim` e o acento só no dia lido agora (é o que está vivo
 * na tela). A tabela recolhida diz o mesmo para quem não enxerga o gráfico.
 */

const VIEW_W = 640;
const VIEW_H = 168;
const PLOT_LEFT = 44;
const PLOT_RIGHT = 8;
const PLOT_TOP = 10;
const PLOT_BOTTOM = 134;
const LABEL_Y = 152;

const METRICS: readonly { key: UsageHistoryMetric; label: string }[] = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'usd', label: 'Custo em API' },
];

function formatMetric(value: number, metric: UsageHistoryMetric): string {
  return metric === 'tokens' ? fmtTokens(value) : fmtUsd(value);
}

function tokensWord(value: number): string {
  return Math.floor(value) === 1 ? 'token' : 'tokens';
}

function turnsWord(value: number): string {
  return value === 1 ? 'turno' : 'turnos';
}

function pointReadout(point: UsageHistoryPoint): string {
  if (point.beforeTracking) return `${point.longLabel}: antes de o histórico começar`;
  if (point.tokens === 0 && point.usdEquivalent === 0 && point.turns === 0) {
    return `${point.longLabel}: sem consumo`;
  }
  return `${point.longLabel}: ${fmtTokens(point.tokens)} ${tokensWord(point.tokens)} · ${fmtUsd(point.usdEquivalent)} em API · ${point.turns} ${turnsWord(point.turns)}`;
}

function sinceLabel(since: number): string {
  const date = new Date(since);
  return Number.isFinite(date.getTime()) && since > 0
    ? date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })
    : 'hoje';
}

export interface UsageHistoryChartProps {
  readonly status: Exclude<UsageHistoryStatus, 'unavailable'>;
  readonly history: UsageHistory | null;
  readonly now: number;
  readonly onRetry: () => void;
}

export function UsageHistoryChart({ status, history, now, onRetry }: UsageHistoryChartProps) {
  const titleId = useId();
  const summaryId = useId();
  const [metric, setMetric] = useState<UsageHistoryMetric>('tokens');
  const [selected, setSelected] = useState<number | null>(null);
  const series = useMemo(
    () =>
      buildUsageHistorySeries(history?.days ?? [], {
        now,
        ...(history ? { since: history.since } : {}),
        span: USAGE_HISTORY_SPAN_DAYS,
      }),
    [history, now],
  );
  const { points, totals, activeDays } = series;
  const top = niceCeiling(Math.max(...points.map((point) => metricValue(point, metric))));
  const plotW = VIEW_W - PLOT_LEFT - PLOT_RIGHT;
  const slot = plotW / points.length;
  const barW = Math.max(2, slot * 0.62);
  const y = (value: number) => PLOT_BOTTOM - (value / top) * (PLOT_BOTTOM - PLOT_TOP);
  const peak = points.reduce<UsageHistoryPoint | null>(
    (best, point) => (!best || metricValue(point, metric) > metricValue(best, metric) ? point : best),
    null,
  );
  const selectedPoint = selected === null ? null : (points[selected] ?? null);

  const onChartKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const last = points.length - 1;
    // Atualização funcional: teclas seguidas no mesmo quadro não se perdem.
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

  const header = (
    <header className="usage-history__head">
      <div>
        <h2 className="usage-history__title" id={titleId}>
          Histórico de uso
        </h2>
        <p className="usage-history__hint">
          Últimos {USAGE_HISTORY_SPAN_DAYS} dias, somando todos os projetos. O custo é o
          equivalente em API paga; a assinatura já cobre.
        </p>
      </div>
      {status === 'ready' && activeDays > 0 ? (
        <div className="usage-history__metric" role="group" aria-label="Medida do gráfico">
          {METRICS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="usage-history__metric-btn"
              aria-pressed={metric === item.key}
              onClick={() => setMetric(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </header>
  );

  if (status === 'loading') {
    return (
      <section className="usage-history" aria-labelledby={titleId} aria-busy="true">
        {header}
        <p className="usage-history__state" role="status">
          Carregando o histórico…
        </p>
        <div className="usage-history__skeleton" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} style={{ height: `${18 + ((index * 37) % 60)}%` }} />
          ))}
        </div>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section className="usage-history" aria-labelledby={titleId}>
        {header}
        <div className="usage-history__error" role="alert">
          <strong>Não foi possível carregar o histórico.</strong>
          <p>Os totais acima continuam valendo. Tente ler o histórico de novo.</p>
          <button type="button" className="settings-btn" onClick={onRetry}>
            Tentar de novo
          </button>
        </div>
      </section>
    );
  }

  if (activeDays === 0) {
    return (
      <section className="usage-history" aria-labelledby={titleId}>
        {header}
        <EmptyState
          icon="bolt"
          className="usage-history__empty"
          title={`Sem consumo nos últimos ${USAGE_HISTORY_SPAN_DAYS} dias`}
          body={
            <p>
              O histórico conta desde {sinceLabel(history?.since ?? 0)}. Cada turno das
              IAs entra no dia em que aconteceu e aparece aqui.
            </p>
          }
          action={
            <button type="button" className="settings-btn" onClick={onRetry}>
              Atualizar histórico
            </button>
          }
        />
      </section>
    );
  }

  const summary = `Total em ${USAGE_HISTORY_SPAN_DAYS} dias: ${fmtTokens(totals.tokens)} ${tokensWord(totals.tokens)}, ${fmtUsd(totals.usdEquivalent)} em API, ${totals.turns} ${turnsWord(totals.turns)}; ${activeDays} ${activeDays === 1 ? 'dia' : 'dias'} com uso${peak && metricValue(peak, metric) > 0 ? `; maior dia ${peak.longLabel} com ${formatMetric(metricValue(peak, metric), metric)}` : ''}.`;
  const tickEvery = points.length > 14 ? 7 : 1;

  return (
    <section className="usage-history" aria-labelledby={titleId}>
      {header}
      <p className="usage-history__readout" aria-live="polite">
        {selectedPoint ? (
          pointReadout(selectedPoint)
        ) : (
          <>
            <strong>{fmtTokens(totals.tokens)}</strong> {tokensWord(totals.tokens)} ·{' '}
            <strong>{fmtUsd(totals.usdEquivalent)}</strong> em API ·{' '}
            <strong>{totals.turns}</strong> {turnsWord(totals.turns)} em {USAGE_HISTORY_SPAN_DAYS}{' '}
            dias
          </>
        )}
      </p>
      <svg
        className="usage-history__chart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        tabIndex={0}
        onKeyDown={onChartKeyDown}
        onMouseLeave={() => setSelected(null)}
        onBlur={() => setSelected(null)}
      >
        {[0, 0.5, 1].map((ratio) => (
          <g key={ratio} className="usage-history__grid">
            <line x1={PLOT_LEFT} x2={VIEW_W - PLOT_RIGHT} y1={y(top * ratio)} y2={y(top * ratio)} />
            <text x={PLOT_LEFT - 6} y={y(top * ratio) + 3} textAnchor="end">
              {formatMetric(top * ratio, metric)}
            </text>
          </g>
        ))}
        {points.map((point, index) => {
          const value = metricValue(point, metric);
          const x = PLOT_LEFT + index * slot + (slot - barW) / 2;
          const barTop = value > 0 ? Math.min(y(value), PLOT_BOTTOM - 2) : PLOT_BOTTOM;
          const active = selected === index;
          return (
            <g
              key={point.day}
              className={`usage-history__day${active ? ' is-active' : ''}${point.beforeTracking ? ' is-untracked' : ''}`}
              onMouseEnter={() => setSelected(index)}
            >
              {/* Alvo do ponteiro na altura toda: dia sem uso também se lê. */}
              <rect
                className="usage-history__hit"
                x={PLOT_LEFT + index * slot}
                y={PLOT_TOP}
                width={slot}
                height={PLOT_BOTTOM - PLOT_TOP}
              />
              {value > 0 ? (
                <rect
                  className="usage-history__bar"
                  x={x}
                  y={barTop}
                  width={barW}
                  height={PLOT_BOTTOM - barTop}
                  rx={1.5}
                />
              ) : (
                <line
                  className="usage-history__zero"
                  x1={x}
                  x2={x + barW}
                  y1={PLOT_BOTTOM - 0.5}
                  y2={PLOT_BOTTOM - 0.5}
                />
              )}
              {(points.length - 1 - index) % tickEvery === 0 ? (
                <text className="usage-history__tick" x={x + barW / 2} y={LABEL_Y} textAnchor="middle">
                  {index === points.length - 1 ? 'hoje' : point.shortLabel}
                </text>
              ) : null}
            </g>
          );
        })}
        <line
          className="usage-history__baseline"
          x1={PLOT_LEFT}
          x2={VIEW_W - PLOT_RIGHT}
          y1={PLOT_BOTTOM}
          y2={PLOT_BOTTOM}
        />
      </svg>
      <p id={summaryId} className="usage-history__summary">
        {summary} Use as setas para ler dia a dia.
      </p>
      <details className="usage-history__table-wrap">
        <summary>Ver dados em tabela</summary>
        <table className="usage-history__table">
          <caption className="settings-visually-hidden">
            Consumo por dia nos últimos {USAGE_HISTORY_SPAN_DAYS} dias
          </caption>
          <thead>
            <tr>
              <th scope="col">Dia</th>
              <th scope="col">Tokens</th>
              <th scope="col">Custo em API</th>
              <th scope="col">Turnos</th>
            </tr>
          </thead>
          <tbody>
            {points
              .filter((point) => point.tokens > 0 || point.usdEquivalent > 0 || point.turns > 0)
              .reverse()
              .map((point) => (
                <tr key={point.day}>
                  <th scope="row">{point.longLabel}</th>
                  <td>{fmtTokens(point.tokens)}</td>
                  <td>{fmtUsd(point.usdEquivalent)}</td>
                  <td>{point.turns}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="usage-history__table-note">Dias sem consumo ficam fora da tabela.</p>
      </details>
    </section>
  );
}
