import { useSettingsStore } from '../state/settings-store';
import { useQuotaStore } from '../state/quota-store';
import { chipLabel, chipTone } from '../lib/quota-display';

/**
 * Compact worst-quota affordance for WorkspaceBar (Nível 1).
 */

export function QuotaChip() {
  const snapshot = useQuotaStore((s) => s.snapshot);
  const openDrawer = useSettingsStore((s) => s.openDrawer);
  const label = chipLabel(snapshot);
  if (!label) return null;
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
      <span className="quota-chip__text">{label}</span>
    </button>
  );
}
