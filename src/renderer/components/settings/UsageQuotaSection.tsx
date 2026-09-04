import { useEffect, useState } from 'react';
import { useQuotaStore } from '../../state/quota-store';
import { useAccountStore } from '../../state/account-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { windowDisplay } from '../../lib/quota-display';
import type { ProviderQuotaEntry } from '../../../shared/quota-types';
import { ProviderLogo } from '../ProviderLogo';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { emailFromAuthDetail } from './account-default-label';

/**
 * Settings → Uso e cotas: fleet list of provider quota windows.
 * Unknown ratios render as "—" never fake 0%.
 */

function EntryCard({
  entry,
  email,
  needsRelogin,
}: {
  entry: ProviderQuotaEntry;
  /** E-mail da conta do vault (entries de CLI nativo não têm conta). */
  email?: string;
  /** Refresh morto (lido do vault, não do snapshot de cota). */
  needsRelogin?: boolean;
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
        {entry.onCooldown && !needsRelogin && (
          <span className="quota-entry__badge quota-entry__badge--warn">
            cooldown
          </span>
        )}
        {needsRelogin && (
          <span
            className="quota-entry__badge quota-entry__badge--warn"
            title="A renovação do token falhou — entre novamente em Providers"
          >
            sessão expirada
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
  if (status === 'ready' && updatedAt && Number.isFinite(updatedAt)) {
    const d = new Date(updatedAt);
    if (!Number.isNaN(d.getTime())) {
      return `atualizado ${d.toLocaleTimeString()}`;
    }
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
  const loaded = status === 'ready' && snapshot.updatedAt > 0;

  // E-mail da sessão viva por adapter (sonda de login — arquivo/subprocesso,
  // nunca Keychain na main thread). É o que permite dobrar a linha "CLI
  // nativo" para dentro da conta salva: com 2 contas Claude logadas, o
  // operador via TRÊS linhas e lia "limites errados".
  const [nativeEmailByAdapter, setNativeEmailByAdapter] = useState<
    Record<string, string>
  >({});
  const probeNativeEmails = async () => {
    try {
      const list = await window.nexus?.providers?.authStatus();
      if (!list) return;
      const byAdapter: Record<string, string> = {};
      for (const s of list) {
        const email =
          s.state === 'ok' ? emailFromAuthDetail(s.detail) : null;
        if (email) byAdapter[s.adapterId] = email.trim().toLowerCase();
      }
      setNativeEmailByAdapter(byAdapter);
    } catch {
      // Sonda best-effort: sem ela, a linha nativa segue aparecendo.
    }
  };

  // Always re-fetch when this settings panel is opened (boot hydrate can race
  // before main IPC is ready, or the process was an old build).
  useEffect(() => {
    void hydrate();
    void probeNativeEmails();
  }, [hydrate]);

  // A linha "CLI nativo" de um adapter é REDUNDANTE quando a sessão viva já é
  // uma conta salva: os mesmos limites estão na linha da conta (com e-mail).
  const entries = snapshot.entries.filter((e) => {
    if (e.accountId) return true;
    const native = nativeEmailByAdapter[e.adapterId];
    if (!native) return true;
    return !accounts.some(
      (a) =>
        a.adapterId === e.adapterId &&
        a.email?.trim().toLowerCase() === native,
    );
  });

  /** Atualizar refaz cota E sonda de sessão viva (a conta pode ter trocado). */
  const refreshAll = async (): Promise<void> => {
    await Promise.all([refresh(), probeNativeEmails()]);
  };

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
          onClick={() => void refreshAll()}
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
            onClick={() => void refreshAll()}
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
              needsRelogin={
                e.accountId
                  ? accounts.find((a) => a.id === e.accountId)?.needsRelogin ===
                    true
                  : false
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}
