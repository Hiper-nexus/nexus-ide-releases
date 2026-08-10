import { useEffect } from 'react';
import { useQuotaStore } from '../../state/quota-store';
import { useAccountStore } from '../../state/account-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { windowDisplay } from '../../lib/quota-display';
import type { ProviderQuotaEntry } from '../../../shared/quota-types';
import { ProviderLogo } from '../ProviderLogo';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Settings → Uso e cotas: fleet list of provider quota windows.
 * Unknown ratios render as "—" never fake 0%.
 */

function EntryCard({
  entry,
  email,
}: {
  entry: ProviderQuotaEntry;
  /** E-mail da conta do vault (entries de CLI nativo não têm conta). */
  email?: string;
}) {
  return (
    <li
      className={`quota-entry ${entry.onCooldown ? 'quota-entry--cool' : ''}`}
      data-adapter={entry.adapterId}
    >
      <div className="quota-entry__head">
        <ProviderLogo adapterId={entry.adapterId} label={entry.label} size="sm" />
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
        <span className="quota-entry__title">
          <span className="quota-entry__label">{entry.label}</span>
          {email && <span className="quota-entry__email">{email}</span>}
        </span>
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
              {/* Sempre presente: célula vazia mantém as 4 colunas do grid e
                  as barras alinhadas entre linhas e entre cards. */}
              <span className="quota-window__reset">
                {w.remainingLabel ?? ''}
              </span>
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

function statusLabel(
  status: 'idle' | 'loading' | 'ready' | 'error',
  updatedAt: number,
): string {
  if (status === 'loading') return 'a carregar…';
  if (status === 'error') return 'falha ao carregar';
  if (status === 'ready' && updatedAt) {
    return `atualizado ${new Date(updatedAt).toLocaleTimeString()}`;
  }
  if (status === 'idle') return 'ainda não carregado';
  return 'sem dados';
}

export function UsageQuotaSection() {
  const snapshot = useQuotaStore((s) => s.snapshot);
  const status = useQuotaStore((s) => s.status);
  const error = useQuotaStore((s) => s.error);
  const hydrate = useQuotaStore((s) => s.hydrate);
  const refresh = useQuotaStore((s) => s.refresh);
  const openSettings = useProductNavigationStore((s) => s.openSettings);
  // Já hidratado no boot via useAccountController (App.tsx) — aqui é só lookup.
  const accounts = useAccountStore((s) => s.accounts);
  const entries = snapshot.entries;
  const loaded = status === 'ready' && snapshot.updatedAt > 0;

  // Always re-fetch when this settings panel is opened (boot hydrate can race
  // before main IPC is ready, or the process was an old build).
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <section className="quota-panel" aria-labelledby="quota-title">
      <header className="quota-panel__intro">
        <SettingsSectionTitle id="quota-title">
          Uso e cotas
        </SettingsSectionTitle>
        <p className="settings-detail__hint">
          Só CLIs instaladas/ativas ou com conta no vault. Janelas padrão:{' '}
          <strong>5 Horas</strong> + <strong>Semanal</strong> (Grok também{' '}
          <strong>Mensal</strong> via billing). % só com fonte real; sem
          telemetria mostra &quot;—&quot;, nunca 0% inventado. OpenCode só
          aparece se estiver instalado.
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
          {statusLabel(status, snapshot.updatedAt)}
        </span>
        <button
          type="button"
          className="settings-btn quota-panel__refresh"
          disabled={status === 'loading'}
          onClick={() => void refresh()}
        >
          {status === 'loading' ? 'A carregar…' : 'Atualizar'}
        </button>
      </div>

      {status === 'error' && (
        <div className="quota-panel__empty quota-panel__empty--error" role="alert">
          <p>
            <strong>Não foi possível carregar as cotas.</strong>
          </p>
          <p>{error ?? 'Erro desconhecido.'}</p>
          <p>
            Reinicia o Nexus (fecha o app e corre de novo) e clica Atualizar.
            Se Providers lista CLIs, o serviço de cotas deve listá-los aqui com
            barras em &quot;—&quot; até haver sinal de limite real.
          </p>
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={() => void refresh()}
          >
            Tentar de novo
          </button>
        </div>
      )}

      {status !== 'error' && entries.length === 0 && (
        <div className="quota-panel__empty" role="status">
          {!loaded && status === 'loading' ? (
            <p>A carregar providers e janelas de cota…</p>
          ) : !loaded ? (
            <p>
              Cotas ainda não chegaram do processo principal. Clica{' '}
              <strong>Atualizar</strong> ou reinicia o app se continuar vazio.
            </p>
          ) : (
            <>
              <p>
                Nenhum CLI listado. Confirma em Providers que os adapters estão
                habilitados (mesmo sem % de cota, devem aparecer aqui).
              </p>
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                onClick={() => openSettings('providers')}
              >
                Abrir Providers
              </button>
            </>
          )}
        </div>
      )}

      {entries.length > 0 && (
        <ul className="quota-panel__list">
          {entries.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              email={
                e.accountId
                  ? accounts.find((a) => a.id === e.accountId)?.email
                  : undefined
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}
