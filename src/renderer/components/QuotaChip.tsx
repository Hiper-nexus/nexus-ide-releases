import { useSettingsStore } from '../state/settings-store';
import { useQuotaStore } from '../state/quota-store';
import { chipLabel, chipParts, chipTone } from '../lib/quota-display';

/**
 * Compact worst-quota affordance for WorkspaceBar (Nível 1).
 * Single-line pill: dot · "cota" · value — never stacks vertically.
 */

export function QuotaChip() {
  const snapshot = useQuotaStore((s) => s.snapshot);
  const openDrawer = useSettingsStore((s) => s.openDrawer);
  const label = chipLabel(snapshot);
  const parts = chipParts(snapshot);
  if (!label || !parts) return null;
  const tone = chipTone(snapshot);

  return (
    <button
      type="button"
      className={`quota-chip quota-chip--${tone}`}
      title="Cotas das contas CLI — clique para Uso e cotas"
      aria-label={label}
      onClick={() => openDrawer('usage-quota')}
    >
      <span className="quota-chip__dot" aria-hidden="true" />
      <span className="quota-chip__kicker">cota</span>
      <span className="quota-chip__value">{parts.value}</span>
    </button>
  );
}
