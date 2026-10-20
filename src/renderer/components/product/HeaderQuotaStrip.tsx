import { useMemo } from 'react';
import { collapseSharedQuotaEntries, type ProviderQuotaEntry } from '../../../shared/quota-types';
import {
  formatResetCountdown,
  prioritizeReportedQuotas,
  windowDisplay,
} from '../../lib/quota-display';
import { useMinuteTick } from '../../lib/use-minute-tick';
import { useQuotaStore } from '../../state/quota-store';
import { ProviderLogo } from '../ProviderLogo';

/** Contas que cabem na faixa do cabeçalho: as que mais consomem. */
export const HEADER_QUOTA_MAX = 5;

interface StripItem {
  entry: ProviderQuotaEntry;
  /** Número da conta quando o provedor tem mais de uma; null com conta única. */
  suffix: string | null;
  tone: 'ok' | 'warn' | 'danger';
  percent: string;
  reset: string | null;
  title: string;
}

/**
 * Só entra conta com leitura real (nunca 0% inventado). A janela mostrada é a
 * mais gasta, e o contador de reset sai de `resetsAt` a cada minuto.
 */
export function headerQuotaItems(
  entries: readonly ProviderQuotaEntry[],
  now: number,
  max = HEADER_QUOTA_MAX,
): StripItem[] {
  const items: StripItem[] = [];
  const collapsed = collapseSharedQuotaEntries([...entries]);
  // Sufixo estável (ordem por id, não por consumo) só quando o provedor tem 2+ contas.
  const idsByAdapter = new Map<string, string[]>();
  for (const entry of collapsed) {
    idsByAdapter.set(entry.adapterId, [...(idsByAdapter.get(entry.adapterId) ?? []), entry.id].sort());
  }
  for (const entry of prioritizeReportedQuotas(collapsed)) {
    if (entry.readHint === 'identity-mismatch') continue;
    let worst: (typeof entry.windows)[number] | null = null;
    for (const window of entry.windows) {
      if (window.confidence === 'low' || window.usedRatio === null) continue;
      if (worst === null || window.usedRatio > (worst.usedRatio ?? 0)) worst = window;
    }
    if (worst === null) continue;
    const display = windowDisplay(worst);
    if (display.tone === 'unknown') continue;
    const reset = formatResetCountdown(worst.resetsAt, now) ?? worst.remainingLabel ?? null;
    const siblings = idsByAdapter.get(entry.adapterId) ?? [];
    items.push({
      entry,
      suffix: siblings.length > 1 ? String(siblings.indexOf(entry.id) + 1) : null,
      tone: display.tone,
      percent: display.percentLabel,
      reset,
      title: `${entry.label} · ${worst.label} ${display.percentLabel}${reset ? ` · reinicia em ${reset}` : ''}${
        entry.onCooldown ? ' · em pausa temporária' : ''
      }`,
    });
    if (items.length >= max) break;
  }
  return items;
}

/** Redline no cabeçalho: as contas mais usadas sempre à vista; clique abre Uso e cotas. */
export function HeaderQuotaStrip({ onOpenUsage }: { onOpenUsage(): void }) {
  const entries = useQuotaStore((s) => s.snapshot.entries);
  const now = useMinuteTick();
  const items = useMemo(() => headerQuotaItems(entries, now), [entries, now]);
  if (items.length === 0) return null;
  return (
    <button
      type="button"
      className="header-quota"
      aria-label="Cotas das contas mais usadas. Abrir Uso e cotas"
      title="Abrir Uso e cotas"
      onClick={onOpenUsage}
    >
      {items.map(({ entry, suffix, tone, percent, reset, title }) => (
        <span key={entry.id} className="header-quota__item" title={title}>
          <ProviderLogo adapterId={entry.adapterId} label={entry.label} size="xs" />
          {suffix ? <sub className="header-quota__suffix">{suffix}</sub> : null}
          <span className={`header-quota__pct header-quota__pct--${tone}`}>{percent}</span>
          {reset ? <span className="header-quota__reset">{reset}</span> : null}
        </span>
      ))}
    </button>
  );
}
