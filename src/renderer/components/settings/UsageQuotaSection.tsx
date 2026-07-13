import { useQuotaStore } from '../../state/quota-store';
import { windowDisplay } from '../../lib/quota-display';
import type { ProviderQuotaEntry } from '../../../shared/quota-types';

/**
 * Settings → Uso e cotas: fleet list of provider quota windows.
 * Unknown ratios render as "—" never fake 0%.
 */

function EntryCard({ entry }: { entry: ProviderQuotaEntry }) {
  return (
    <li
      className={`quota-entry ${entry.onCooldown ? 'quota-entry--cool' : ''}`}
      data-adapter={entry.adapterId}
    >
      <div className="quota-entry__head">
        <span
          className={`quota-entry__led ${
            entry.onCooldown
              ? 'quota-entry__led--cool'
              : entry.installed
                ? 'quota-entry__led--on'
                : 'quota-entry__led--off'
          }`}
          aria-hidden="true"
        />
        <span className="quota-entry__label">{entry.label}</span>
        {!entry.installed && (
          <span className="quota-entry__badge">ausente</span>
        )}
        {entry.onCooldown && (
          <span className="quota-entry__badge quota-entry__badge--warn">
            cooldown
          </span>
        )}
      </div>
      <ul className="quota-entry__windows">
        {entry.windows.map((w) => {
          const d = windowDisplay(w);
          return (
            <li key={`${w.kind}-${w.label}`} className="quota-window">
              <span className="quota-window__name">{w.label}</span>
              <span
                className="quota-window__track"
                role={d.tone === 'unknown' ? undefined : 'progressbar'}
                aria-hidden={d.tone === 'unknown' ? true : undefined}
                aria-valuemin={d.tone === 'unknown' ? undefined : 0}
                aria-valuemax={d.tone === 'unknown' ? undefined : 100}
                aria-valuenow={
                  d.tone === 'unknown'
                    ? undefined
                    : Math.round(d.barRatio * 100)
                }
                aria-label={
                  d.tone === 'unknown'
                    ? undefined
                    : `${w.label} ${d.percentLabel}`
                }
              >
                <span
                  className={`quota-window__fill quota-window__fill--${d.tone}`}
                  style={{
                    transform: `scaleX(${d.tone === 'unknown' ? 0 : d.barRatio})`,
                  }}
                />
              </span>
              <span
                className={`quota-window__pct quota-window__pct--${d.tone}`}
              >
                {d.percentLabel}
              </span>
              {w.remainingLabel && (
                <span className="quota-window__reset">{w.remainingLabel}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="quota-entry__meta">
        fontes:{' '}
        {[...new Set(entry.windows.map((w) => w.source))].join(', ')}
      </p>
    </li>
  );
}

export function UsageQuotaSection() {
  const snapshot = useQuotaStore((s) => s.snapshot);
  const refresh = useQuotaStore((s) => s.refresh);
  const entries = snapshot.entries;

  return (
    <section className="quota-panel" aria-labelledby="quota-title">
      <header className="quota-panel__intro">
        <h3 id="quota-title" className="settings-detail__title">
          Uso e cotas
        </h3>
        <p className="settings-detail__hint">
          Janelas de cota por CLI e conta (sessão, horas, semanal). Percentagens
          só aparecem com fonte real — desconhecido mostra &quot;—&quot;, nunca
          0% inventado. Gasto em $ do projeto fica no chip de custo da bar.
        </p>
      </header>

      <div className="quota-panel__fleet" role="status">
        <span>
          <strong>{entries.length}</strong> entradas
        </span>
        <span className="quota-panel__sep" aria-hidden="true">
          ·
        </span>
        <span>
          <strong>{snapshot.highUsageCount}</strong> no limite
        </span>
        <span className="quota-panel__sep" aria-hidden="true">
          ·
        </span>
        <span>
          <strong>{snapshot.unknownCount}</strong> sem telemetria
        </span>
        <span className="quota-panel__sep" aria-hidden="true">
          ·
        </span>
        <span className="quota-panel__dim">
          {snapshot.updatedAt
            ? `atualizado ${new Date(snapshot.updatedAt).toLocaleTimeString()}`
            : 'ainda não carregado'}
        </span>
        <button
          type="button"
          className="settings-btn quota-panel__refresh"
          onClick={() => void refresh()}
        >
          Atualizar
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="quota-panel__empty">
          Nenhum provider instalado ou conta no vault. Configure CLIs em
          Providers.
        </p>
      ) : (
        <ul className="quota-panel__list">
          {entries.map((e) => (
            <EntryCard key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </section>
  );
}
