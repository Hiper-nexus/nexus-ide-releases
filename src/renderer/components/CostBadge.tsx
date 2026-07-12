import { useCostStore } from '../state/cost-store';
import { useUsageStore } from '../state/usage-store';
import { PixelIcon } from './PixelIcon';

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
  // Telemetria REAL (transcript watcher) tem precedência sobre a estimativa
  // por bytes — quando existe, o badge mostra o número auditável.
  const real = useUsageStore((s) => s.snapshot.byPane[paneId]);
  if (!pane && !real) return null;

  const hasCap = !!pane && pane.capUsd !== undefined && pane.capUsd > 0;
  const estimated = pane?.costUsd ?? 0;
  const shownUsd = real ? real.costUsd : estimated;
  const paused = pane?.paused ?? false;
  const ratio = hasCap ? Math.min(1, estimated / pane!.capUsd!) : 0;
  const level = paused ? 'over' : ratio >= 0.8 ? 'warn' : 'ok';
  const sourceNote = real
    ? `custo REAL (transcript, ${real.turns} turnos; cache read ${Math.round(real.cacheReadTokens / 1000)}k tok)`
    : 'custo estimado (heurística por bytes)';
  const capTitle = hasCap
    ? `${formatUsd(shownUsd)} de ${formatUsd(pane!.capUsd!)} (cap) — ${sourceNote}`
    : `${formatUsd(shownUsd)} — ${sourceNote}`;

  return (
    <span
      className={`cost-badge${paused ? ' cost-badge--paused' : ''}${real ? ' cost-badge--real' : ''}`}
      title={capTitle}
    >
      <span className="cost-badge__usd">{formatUsd(shownUsd)}</span>
      {hasCap && (
        <span className="cost-badge__bar">
          {/* scaleX (not width) so the fill animates on the compositor — no
              layout thrash on the progress bar. */}
          <span
            className={`cost-badge__fill cost-badge__fill--${level}`}
            style={{ transform: `scaleX(${ratio})` }}
          />
        </span>
      )}
      {paused && <span className="cost-badge__paused">pausado</span>}
    </span>
  );
}

/** Workspace summary: total $, burn rate ($/min) and token throughput. */
export function CostSummary() {
  const snapshot = useCostStore((s) => s.snapshot);
  const media = useUsageStore((s) => s.snapshot.media);
  if (snapshot.panes.length === 0 && media.generations === 0) return null;

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
      {media.generations > 0 && (
        <span
          className="cost-summary__item"
          title={`${media.generations} gerações de mídia (imagem/vídeo/áudio)`}
        >
          <PixelIcon name="sparkle" size={10} /> {formatUsd(media.costUsd)}
        </span>
      )}
    </div>
  );
}
