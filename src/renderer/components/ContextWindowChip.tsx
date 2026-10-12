import { useEffect, useState } from 'react';
import {
  contextWindowFillRatio,
  contextWindowUrgency,
  deriveContextWindowSnapshot,
  formatContextWindowLabel,
  type ContextWindowSnapshot,
} from '../../shared/context-window-view';
import { formatCompactTokens } from '../../shared/compact-tokens';
import { useUsageStore } from '../state/usage-store';

/**
 * Chip de janela de contexto no PaneToolbar (herdado do t3code context meter).
 * Mostra `used/max` da última rodada real (input + cache_read do transcript)
 * contra a capacidade do modelo. Métrica ausente é `—`, nunca 0.
 */

interface Props {
  paneId: string;
  /** Modelo do pane (cli-agent) — fonte da capacidade da janela. */
  adapterId?: string | null;
  modelId?: string | null;
}

function richMetadataApi(): {
  richMetadata(
    adapterId: string,
    modelId: string,
  ): Promise<{ contextWindow?: number } | null>;
} | null {
  const nexus = (window as unknown as {
    nexus?: {
      model?: {
        richMetadata?: (
          adapterId: string,
          modelId: string,
        ) => Promise<{ contextWindow?: number } | null>;
      };
    };
  }).nexus;
  const fn = nexus?.model?.richMetadata;
  return typeof fn === 'function'
    ? { richMetadata: fn.bind(nexus!.model) }
    : null;
}

export function ContextWindowChip({ paneId, adapterId, modelId }: Props) {
  const lastContext = useUsageStore(
    (s) => s.snapshot.byPane[paneId]?.lastContextTokens ?? null,
  );
  const [maxTokens, setMaxTokens] = useState<number | null>(null);

  useEffect(() => {
    const api = adapterId && modelId ? richMetadataApi() : null;
    if (!api || !adapterId || !modelId) {
      setMaxTokens(null);
      return;
    }
    // Limpa a capacidade antiga antes da nova leitura: senão a janela do
    // modelo anterior casa com o usedTokens do pane novo (fill mentiroso).
    setMaxTokens(null);
    let cancelled = false;
    void api
      .richMetadata(adapterId, modelId)
      .then((meta) => {
        if (cancelled) return;
        const window_ = meta?.contextWindow;
        setMaxTokens(
          typeof window_ === 'number' && Number.isFinite(window_) && window_ > 0
            ? window_
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setMaxTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [adapterId, modelId]);

  const snapshot: ContextWindowSnapshot = deriveContextWindowSnapshot({
    usedTokens: lastContext,
    maxTokens,
  });
  if (snapshot.usedTokens === null && snapshot.maxTokens === null) return null;

  const label = formatContextWindowLabel(snapshot);
  const fill = contextWindowFillRatio(snapshot);
  const urgency = contextWindowUrgency(snapshot);
  const remaining =
    snapshot.remainingTokens !== null
      ? `restam ${formatCompactTokens(snapshot.remainingTokens)}`
      : 'capacidade do modelo';
  const title = [
    `Janela de contexto: ${label} tokens`,
    remaining,
    snapshot.usedTokens !== null
      ? 'preenchimento real da última rodada (transcript)'
      : 'sem leitura de preenchimento nesta sessão',
  ].join(' · ');

  return (
    <span
      className={`ctx-chip ctx-chip--${urgency}`}
      title={title}
      aria-label={title}
    >
      <span className="ctx-chip__label">{label}</span>
      {fill !== null && (
        <span className="ctx-chip__bar" aria-hidden="true">
          <span
            className={`ctx-chip__fill ctx-chip__fill--${urgency}`}
            style={{ transform: `scaleX(${fill})` }}
          />
        </span>
      )}
    </span>
  );
}
