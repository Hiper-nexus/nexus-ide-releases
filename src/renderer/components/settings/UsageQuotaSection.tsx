import { useEffect } from 'react';
import { useQuotaStore } from '../../state/quota-store';
import { useAccountStore } from '../../state/account-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { prioritizeReportedQuotas, windowDisplay } from '../../lib/quota-display';
import {
  QUOTA_HIGH_USAGE_THRESHOLD,
  type ProviderQuotaEntry,
  type QuotaSource,
  type QuotaWindow,
} from '../../../shared/quota-types';
import { ProviderLogo } from '../ProviderLogo';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const SOURCE_LABELS: Record<QuotaSource, string> = {
  'provider-api': 'Informado pelo serviço de IA',
  'transcript-inferred': 'Estimado a partir da sessão',
  'limit-hit': 'Limite sinalizado pela ferramenta',
  'local-tokens': 'Contagem local de tokens',
  cooldown: 'Pausa temporária',
  unknown: 'Fonte indisponível',
};
const PROVIDER_LABELS: Record<string, string> = {
  glm: 'GLM',
  longcat: 'LongCat',
  kimi: 'Kimi',
  xai: 'xAI',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};
function observationTime(value: number): string {
  const date = new Date(value);
  return value > 0 && Number.isFinite(date.getTime())
    ? date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : 'Ainda sem consulta';
}
function hasQuota(entry: ProviderQuotaEntry): boolean {
  return entry.windows.some(
    (window) => windowDisplay(window).tone !== 'unknown',
  );
}
function QuotaWindowRow({ window }: { window: QuotaWindow }) {
  const display = windowDisplay(window);
  const unknown = display.tone === 'unknown';
  const local = window.source === 'local-tokens';
  return (
    <li className="quota-window" data-unknown={unknown}>
      <span className="quota-window__name">{window.label}</span>
      {unknown ? (
        <span className="quota-window__unknown">
          {local
            ? window.remainingLabel || 'Contagem indisponível'
            : 'Não informado'}
        </span>
      ) : (
        <>
          <span
            className="quota-window__track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={display.barRatio * 100}
            aria-valuetext={`${display.percentLabel} utilizado`}
            aria-label={`${window.label}: consumo da cota`}
          >
            <span
              className={`quota-window__fill quota-window__fill--${display.tone}`}
              style={{ transform: `scaleX(${display.barRatio})` }}
            />
          </span>
          <span
            className={`quota-window__pct quota-window__pct--${display.tone}`}
          >
            {display.percentLabel}
          </span>
        </>
      )}
      <span className="quota-window__reset">
        {local
          ? 'Sem limite de conta informado'
          : (window.remainingLabel ?? '')}
      </span>
    </li>
  );
}
function EntryCard({
  entry,
  email,
  needsRelogin,
}: {
  entry: ProviderQuotaEntry;
  email?: string;
  needsRelogin?: boolean;
}) {
  const known = hasQuota(entry);
  const state = needsRelogin
    ? 'Entrar novamente'
    : entry.onCooldown
      ? 'Pausa temporária'
      : known
        ? 'Cota informada'
        : 'Sem informação';
  const label = entry.accountId
    ? entry.label
    : entry.label.replace(/\s*·\s*CLI nativo$/u, '');
  return (
    <li
      className={`quota-entry ${entry.onCooldown ? 'quota-entry--cool' : ''}`}
      data-adapter={entry.adapterId}
    >
      <header className="quota-entry__head">
        <ProviderLogo adapterId={entry.adapterId} label={label} size="sm" />
        <div className="quota-entry__title">
          <h3 className="quota-entry__label">{label}</h3>
          <p className="quota-entry__origin">
            {entry.accountId ? 'Conta salva no Nexus' : 'Conexão atual'}
            {email ? ` · ${email}` : ''}
          </p>
        </div>
        <span
          className={`quota-entry__badge ${needsRelogin || entry.onCooldown ? 'quota-entry__badge--warn' : ''}`}
        >
          {state}
        </span>
        {!entry.installed && (
          <span className="quota-entry__badge">Não instalada</span>
        )}
      </header>
      {entry.usageProviderId && entry.usageProviderId !== entry.adapterId && (
        <p className="quota-entry__origin">
          Limites de{' '}
          {PROVIDER_LABELS[entry.usageProviderId] ?? entry.usageProviderId}
        </p>
      )}
      <div className="quota-entry__columns" aria-hidden="true">
        <span>Período</span>
        <span>Consumo utilizado</span>
        <span>Renovação ou observação</span>
      </div>
      <ul className="quota-entry__windows">
        {entry.windows.map((window) => (
          <QuotaWindowRow
            key={`${window.kind}-${window.label}`}
            window={window}
          />
        ))}
      </ul>
      {!known && (
        <p className="quota-entry__missing">
          Sem percentual disponível. Isso não significa que a conta está sem uso
          ou sem saldo.
        </p>
      )}
      <details className="quota-entry__meta">
        <summary>Fonte e última consulta</summary>
        <p>
          {[
            ...new Set(
              entry.windows.map((window) => SOURCE_LABELS[window.source]),
            ),
          ].join(' · ')}
        </p>
        <p>
          {known ? 'Observação dos dados' : 'Última tentativa'}:{' '}
          {observationTime(entry.updatedAt)}
        </p>
      </details>
    </li>
  );
}

/** Credential sources remain separate; matching an email never proves equal quota scope. */
export function UsageQuotaSection() {
  const snapshot = useQuotaStore((state) => state.snapshot);
  const status = useQuotaStore((state) => state.status);
  const hydrate = useQuotaStore((state) => state.hydrate);
  const refresh = useQuotaStore((state) => state.refresh);
  const accounts = useAccountStore((state) => state.accounts);
  const openSettings = useProductNavigationStore((state) => state.openSettings);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  const entries = prioritizeReportedQuotas(snapshot.entries);
  const highUsageCount = entries.filter((entry) =>
    entry.windows.some(
      (window) =>
        windowDisplay(window).barRatio >= QUOTA_HIGH_USAGE_THRESHOLD,
    ),
  ).length;
  const unknownCount = entries.filter((entry) => !hasQuota(entry)).length;
  const loading = status === 'loading';
  return (
    <section
      className="quota-panel"
      aria-labelledby="quota-title"
      aria-busy={loading}
    >
      <header className="quota-panel__intro">
        <div>
          <SettingsSectionTitle id="quota-title">
            Uso e cotas
          </SettingsSectionTitle>
          <p className="settings-detail__hint">
            Veja quanto foi usado dos limites informados por cada serviço de IA.
            Alguns serviços não disponibilizam todos os períodos.
          </p>
        </div>
        <button
          type="button"
          className="settings-btn settings-btn--primary quota-panel__refresh"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? 'Consultando…' : 'Atualizar cotas'}
        </button>
      </header>
      <div className="quota-panel__fleet" role="status">
        {status !== 'error' && entries.length > 0 && (
          <>
            <span>
              <strong>{entries.length}</strong> conexões e contas
            </span>
            <span>
              <strong>{highUsageCount}</strong> com uso elevado
            </span>
            <span>
              <strong>{unknownCount}</strong> sem cota informada
            </span>
          </>
        )}
        <span>
          {loading
            ? 'Consultando os serviços…'
            : status === 'error'
              ? 'Consulta indisponível'
              : `Consulta: ${observationTime(snapshot.updatedAt)}`}
        </span>
      </div>
      {status === 'error' ? (
        <div
          className="quota-panel__empty quota-panel__empty--error"
          role="alert"
        >
          <strong>Não foi possível carregar as cotas.</strong>
          <p>
            Tente atualizar novamente. Se o problema continuar, confira a
            conexão da ferramenta.
          </p>
        </div>
      ) : entries.length === 0 ? (
        <div className="quota-panel__empty" role="status">
          {loading ? (
            <>
              <p>Consultando suas cotas…</p>
              <div className="settings-skeleton" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </>
          ) : (
            <>
              <strong>Nenhuma cota disponível ainda</strong>
              <p>
                Conecte uma ferramenta de IA para consultar os limites que ela
                disponibiliza.
              </p>
            </>
          )}
        </div>
      ) : (
        <ul className="quota-panel__list">
          {entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              email={
                accounts.find((account) => account.id === entry.accountId)
                  ?.email
              }
              needsRelogin={
                accounts.find((account) => account.id === entry.accountId)
                  ?.needsRelogin
              }
            />
          ))}
        </ul>
      )}
      <footer className="quota-panel__help">
        <p>
          Cada linha identifica a conexão atual ou uma conta salva. Os
          percentuais não são somados entre contas.
        </p>
        <button
          type="button"
          className="settings-btn"
          onClick={() => openSettings('providers')}
        >
          Ver conexões de IA
        </button>
      </footer>
    </section>
  );
}
