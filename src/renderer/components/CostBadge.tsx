import { useCostStore } from '../state/cost-store';

/**
 * Cost tracker UI. Not mounted anywhere yet — the integration layer plugs
 * <CostBadge paneId=…> into PaneToolbar and <CostSummary /> into the top bar.
 * Styling relies on the .cost-* classes (CSS delivered via handoff).
 */

function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatRate(perMinuteUsd: number): string {
  return `${formatUsd(perMinuteUsd)}/min`;
}

/** Per-pane badge: accumulated cost + cap progress bar + paused flag. */
export function CostBadge({ paneId }: { paneId: string }) {
  const pane = useCostStore((s) =>
    s.snapshot.panes.find((p) => p.paneId === paneId),
  );
  if (!pane) return null;

  const hasCap = pane.capUsd !== undefined && pane.capUsd > 0;
  const ratio = hasCap ? Math.min(1, pane.costUsd / pane.capUsd!) : 0;
  const level = pane.paused ? 'over' : ratio >= 0.8 ? 'warn' : 'ok';
  const capTitle = hasCap
    ? `${formatUsd(pane.costUsd)} de ${formatUsd(pane.capUsd!)} (cap)`
    : `${formatUsd(pane.costUsd)} — sem cap`;

  return (
    <span
      className={`cost-badge${pane.paused ? ' cost-badge--paused' : ''}`}
      title={capTitle}
    >
      <span className="cost-badge__usd">{formatUsd(pane.costUsd)}</span>
      {hasCap && (
        <span className="cost-badge__bar">
          <span
            className={`cost-badge__fill cost-badge__fill--${level}`}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </span>
      )}
      {pane.paused && <span className="cost-badge__paused">⏸ cap</span>}
    </span>
  );
}

/** Workspace summary: total $, burn rate ($/min) and token throughput. */
export function CostSummary() {
  const snapshot = useCostStore((s) => s.snapshot);
  if (snapshot.panes.length === 0) return null;

  return (
    <div className="cost-summary" title="Custo estimado do workspace">
      <span className="cost-summary__item cost-summary__item--total">
        {formatUsd(snapshot.totalUsd)}
      </span>
      <span className="cost-summary__item">
        {formatRate(snapshot.perMinuteUsd)}
      </span>
      <span className="cost-summary__item">
        {snapshot.tokPerSec.toFixed(1)} tok/s
      </span>
    </div>
  );
}
