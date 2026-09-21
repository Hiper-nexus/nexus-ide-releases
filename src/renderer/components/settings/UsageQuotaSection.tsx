import { useEffect, useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import { accountLoginCommandFor } from '../../../shared/account-login-commands';
import { useQuotaStore } from '../../state/quota-store';
import { useLifetimeUsage } from '../../state/lifetime-usage';
import { fmtTokens, fmtUsd } from '../../lib/lifetime-format';
import { useAccountStore } from '../../state/account-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import {
  formatResetCountdown,
  prioritizeReportedQuotas,
  windowDisplay,
} from '../../lib/quota-display';
import { useMinuteTick } from '../../lib/use-minute-tick';
import {
  QUOTA_HIGH_USAGE_THRESHOLD,
  type ProviderQuotaEntry,
  type QuotaSource,
  type QuotaWindow,
} from '../../../shared/quota-types';
import { ProviderLogo } from '../ProviderLogo';
import { useToastStore } from '../../state/toast-store';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import { openCliLoginTerminal, type CliLoginFinish } from './cli-login-terminal';
import { defaultAccountLabel, emailFromAuthDetail } from './account-default-label';
import type { AdapterAuthStatus } from '../../../shared/provider-settings-types';
import type { RedlineInstallStatus } from '../../../shared/redline-types';
import { buildPulseMarkers, buildPulseTicks } from '../../lib/quota-pulse';
// Puro (só imports de shared) — o chip "melhor folga" usa a MESMA aritmética
// que o scorer do main e o app de menu bar; nenhuma implementação paralela.
import { scoreFleet } from '../../../main/quota/smart-pick';

/**
 * Linha do Nexus Redline (app de menu bar): instalar na primeira vez,
 * abrir quando já está em /Applications. Sumida em não-macOS ou quando o
 * companheiro não veio no pacote.
 */
function RedlineMenuBarRow() {
  const [status, setStatus] = useState<RedlineInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const pushToast = useToastStore((state) => state.push);
  useEffect(() => {
    // Ambientes sem a ponte (testes, embeds) apenas omitem a linha.
    const api = window.nexus?.redline;
    if (!api) return;
    void api
      .status()
      .then(setStatus)
      .catch(() =>
        setStatus({ platform: 'unknown', bundled: false, running: false }),
      );
  }, []);
  if (!status || status.platform !== 'darwin' || !status.bundled) return null;
  const installed = Boolean(status.installedPath);

  async function run(action: 'install' | 'open'): Promise<void> {
    setBusy(true);
    try {
      const result = await window.nexus.redline[action]();
      pushToast(result.ok ? 'success' : 'warn', 'Nexus Redline', result.message);
      const next = await window.nexus.redline.status();
      setStatus(next);
    } catch (error) {
      pushToast('warn', 'Nexus Redline', String((error as Error).message ?? error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quota-panel__redline">
      <div>
        <strong>App na barra do menu</strong>
        <p className="settings-detail__hint">
          {installed
            ? status.running
              ? 'Nexus Redline está no topo do Mac mostrando as cotas.'
              : 'Nexus Redline está instalado — abra para ver as cotas no topo do Mac.'
            : 'Mostra a folga de cada conta no topo do Mac (instala em /Applications).'}
        </p>
      </div>
      <button
        type="button"
        className="settings-btn"
        disabled={busy}
        onClick={() => void run(installed ? 'open' : 'install')}
      >
        {busy ? 'Aguarde…' : installed ? 'Abrir Redline' : 'Instalar na barra do menu'}
      </button>
    </div>
  );
}

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
  'glm-flash': 'GLM Flash',
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

async function preserveQuotaLoginSession(adapterId: string, baseline: AdapterAuthStatus | null): Promise<void> {
  if (baseline?.state !== 'ok' || !(baseline.sessionFingerprint || emailFromAuthDetail(baseline.detail))) return;
  const store = useAccountStore.getState();
  if (!await store.supportsSnapshot(adapterId)) {
    throw new Error('Esta CLI não permite preservar a sessão atual. Revise a conexão em Providers antes de trocar a conta.');
  }
  const label = defaultAccountLabel({
    typed: '', adapterId, adapterLabel: adapterId, authDetail: baseline.detail,
    taken: store.accounts.filter((account) => account.adapterId === adapterId).map((account) => account.label),
  });
  const saved = await store.addActiveSession(adapterId, label);
  if (!saved.ok) throw new Error(saved.error ?? 'Não foi possível preservar a sessão atual. Tente novamente antes de trocar a conta.');
  await store.hydrate();
}

function QuotaWindowRow({
  window,
  now,
}: {
  window: QuotaWindow;
  now: number;
}) {
  const display = windowDisplay(window);
  const unknown = display.tone === 'unknown';
  const local = window.source === 'local-tokens';
  // Live countdown beats the fetch-time-frozen remainingLabel.
  const reset =
    formatResetCountdown(window.resetsAt, now) ?? window.remainingLabel ?? '';
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
        {local ? 'Sem limite de conta informado' : reset}
      </span>
    </li>
  );
}
function EntryCard({
  entry,
  account,
  email,
  needsRelogin,
  now,
  recommended,
}: {
  entry: ProviderQuotaEntry;
  account?: AccountInfo;
  email?: string;
  needsRelogin?: boolean;
  now: number;
  recommended: boolean;
}) {
  const [loginBusy, setLoginBusy] = useState(false);
  const [quotaBusy, setQuotaBusy] = useState(false);
  const known = hasQuota(entry);
  const authExpired = entry.readHint === 'auth-expired';
  const state = needsRelogin || authExpired
    ? 'Entrar novamente'
    : entry.onCooldown
      ? 'Pausa temporária'
      : known
        ? 'Cota informada'
        : entry.readHint === 'no-credential'
          ? entry.accountId
            ? 'Sem credencial'
            : 'Sem conta conectada'
          : entry.readHint === 'cli-missing'
            ? 'CLI não encontrada'
            : 'Sem informação';
  const label = entry.accountId
    ? entry.label
    : entry.label.replace(/\s*·\s*CLI nativo$/u, '');
  const origin = entry.accountId
    ? entry.active
      ? 'Conta ativa no Nexus'
      : 'Conta salva no Nexus'
    : 'Conexão atual';
  const showEmail = email && !label.includes(email);
  // A sonda de quota pode detectar o grant morto antes do flag needsRelogin
  // (conta nativa nunca o recebe) — o hint também abre o caminho de login.
  const canRelogin = Boolean(
    (needsRelogin || authExpired) && entry.accountId && account,
  );
  const loginLabel = account?.label ?? label;

  async function saveVerifiedLogin(finish: CliLoginFinish): Promise<void> {
    const push = useToastStore.getState().push;
    if (!finish.verified) {
      push('warn', 'Login não confirmado', 'Não foi possível confirmar um novo login. A conta salva não foi alterada.');
      return;
    }
    if (!entry.accountId) return;
    try {
      const store = useAccountStore.getState();
      const saved = await store.addActiveSession(entry.adapterId, loginLabel, entry.accountId);
      if (!saved.ok) throw new Error(saved.error ?? 'Não foi possível salvar a sessão da conta escolhida.');
      await store.hydrate();
      await useQuotaStore.getState().refresh();
      push('success', 'Conta atualizada', 'Sessão salva para a conta escolhida. Reinicie os panes abertos para aplicar.');
    } catch (error) {
      push('error', 'Não foi possível atualizar a conta', error instanceof Error ? error.message : 'Tente novamente.');
    }
  }

  async function connectQuota() {
    if (quotaBusy) return;
    setQuotaBusy(true);
    try {
      const result = await window.nexus.quota.connectMimo(entry.accountId);
      useToastStore.getState().push(result.ok ? 'success' : 'warn', 'Cota MiMo', result.message);
      await useQuotaStore.getState().refresh();
    } catch {
      useToastStore.getState().push('error', 'Cota MiMo', 'Não foi possível abrir a conexão. Tente novamente.');
    } finally { setQuotaBusy(false); }
  }

  async function relogin() {
    if (!canRelogin || loginBusy) return;
    setLoginBusy(true);
    try {
      const statuses = await window.nexus?.providers?.authStatus();
      const baseline =
        statuses?.find((status) => status.adapterId === entry.adapterId) ?? null;
      await preserveQuotaLoginSession(entry.adapterId, baseline);
      const command = accountLoginCommandFor(entry.adapterId);
      const result = await openCliLoginTerminal({
        command: command ?? '',
        adapterId: entry.adapterId,
        adapterLabel: loginLabel,
        baseline,
        reauthenticate: true,
        onFinished: saveVerifiedLogin,
      });
      if (!result.ok && !result.cancelled) {
        useToastStore
          .getState()
          .push('error', 'Não foi possível abrir o login', result.error);
      }
    } catch (error) {
      useToastStore
        .getState()
        .push('error', 'Não foi possível abrir o login', error instanceof Error ? error.message : 'Tente novamente.');
    } finally {
      setLoginBusy(false);
    }
  }

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
            {origin}
            {showEmail ? ` · ${email}` : ''}
          </p>
          {entry.plan && (
            <p className="quota-entry__plan">
              {entry.plan.label}
              {typeof entry.plan.monthlyUsd === 'number' &&
                ` · ${fmtUsd(entry.plan.monthlyUsd)}/mês`}
            </p>
          )}
        </div>
        {entry.adapterId === 'mimo-code' && (
          <button type="button" className="settings-btn" disabled={quotaBusy} aria-busy={quotaBusy}
            title="Entre no console com a mesma conta do Token Plan usada na CLI e feche a janela para verificar."
            onClick={() => void connectQuota()}>
            {quotaBusy ? 'Conectando cota…' : 'Conectar cota'}
          </button>
        )}
        {canRelogin ? (
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            onClick={() => void relogin()}
            disabled={loginBusy}
            aria-busy={loginBusy}
          >
            {loginBusy ? 'Abrindo login…' : state}
          </button>
        ) : (
          <span
            className={`quota-entry__badge ${needsRelogin || authExpired || entry.onCooldown ? 'quota-entry__badge--warn' : ''}`}
          >
            {state}
          </span>
        )}
        {recommended && (
          <span className="quota-entry__flag" title="Conta com mais folga agora, pelo mesmo cálculo que o Nexus usa para escolher conta">
            Melhor folga
          </span>
        )}
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
            now={now}
          />
        ))}
      </ul>
      {!known && (
        <p className="quota-entry__missing">
          {authExpired
            ? 'A sessão desta conta expirou e não foi possível renovar — reautentique para voltar a ver os limites.'
            : entry.readHint === 'no-credential'
              ? 'Nenhuma credencial válida foi encontrada para esta linha.'
              : entry.readHint === 'cli-missing'
                ? 'O executável do CLI não foi encontrado nesta máquina.'
                : 'Sem percentual disponível. Isso não significa que a conta está sem uso ou sem saldo.'}
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

/**
 * Banda Fleet Pulse: eixo de renovação (horizonte 7d) com uma marca por
 * conta — a janela decisiva de cada uma. Responde "quando respira de novo?"
 * sem número inventado: só marcas com reset conhecido entram no eixo.
 */
function QuotaPulseBand({
  entries,
  now,
}: {
  entries: ProviderQuotaEntry[];
  now: number;
}) {
  const markers = buildPulseMarkers(entries, now).slice(0, 24);
  if (markers.length === 0) return null;
  const ticks = buildPulseTicks();
  const next = markers[0];
  const nextIn = formatResetCountdown(next.resetsAt, now);
  const X = (position: number) => 8 + position * 624;
  const BASE = 32;
  return (
    <section className="quota-pulse" aria-label="Renovação das janelas mais apertadas">
      <div className="quota-pulse__head">
        <h2 className="quota-pulse__title">Renovação das janelas mais apertadas</h2>
        <p className="quota-pulse__next">
          Próxima renovação:{' '}
          <strong>
            {nextIn ? `${nextIn} · ${next.windowLabel}` : next.windowLabel}
          </strong>
        </p>
      </div>
      <svg
        className="quota-pulse__axis"
        viewBox="0 0 640 52"
        role="img"
        aria-label={
          nextIn
            ? `Eixo de renovação em 7 dias; próxima em ${nextIn} (${next.windowLabel}), ${markers.length} contas com reset conhecido`
            : `Eixo de renovação em 7 dias; ${markers.length} contas com reset conhecido`
        }
      >
        <line
          className="quota-pulse__baseline"
          x1={X(0)}
          x2={X(1)}
          y1={BASE}
          y2={BASE}
        />
        {ticks.map((tick) => (
          <g key={tick.label} className="quota-pulse__tick">
            <line
              x1={X(tick.position)}
              x2={X(tick.position)}
              y1={BASE}
              y2={BASE + 5}
            />
            <text x={X(tick.position)} y={BASE + 16} textAnchor="middle">
              {tick.label}
            </text>
          </g>
        ))}
        <text x={X(0)} y={BASE + 16} textAnchor="end" className="quota-pulse__now">
          agora
        </text>
        {markers.map((marker, index) => {
          const lane = index % 3;
          const cy = BASE - 7 - lane * 8;
          return (
            <g
              key={marker.entryId}
              className={`quota-pulse__marker quota-pulse__marker--${marker.tone}`}
            >
              <title>
                {`${marker.windowLabel} · reseta em ${formatResetCountdown(marker.resetsAt, now) ?? '—'}`}
              </title>
              <line
                className="quota-pulse__stem"
                x1={X(marker.position)}
                x2={X(marker.position)}
                y1={BASE - 1}
                y2={cy + 4}
              />
              <circle className="quota-pulse__dot" cx={X(marker.position)} cy={cy} r={3.2} />
            </g>
          );
        })}
      </svg>
    </section>
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
  const now = useMinuteTick();
  const lifetime = useLifetimeUsage();
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
  // Vencedor por adapter do mesmo scorer que o Redline usa (aritmética pura).
  const recommendedIds = new Set(
    Object.values(scoreFleet(entries, accounts, now).ranking)
      .map((rows) => rows[0]?.entryId)
      .filter((entryId): entryId is string => Boolean(entryId)),
  );
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
            {snapshot.plans && snapshot.plans.detected > 0 && (
              <span
                className="quota-panel__plans"
                title={
                  snapshot.plans.undetected > 0
                    ? `Assinaturas detectadas pelos próprios serviços. ${snapshot.plans.undetected} conexão(ões) elegível(eis) sem plano identificado não entram na soma.`
                    : 'Assinaturas detectadas pelos próprios serviços — some ao remover uma conta, cresce ao conectar outra.'
                }
              >
                <strong>{fmtUsd(snapshot.plans.monthlyUsd)}/mês</strong> em{' '}
                {snapshot.plans.detected}{' '}
                {snapshot.plans.detected === 1 ? 'assinatura' : 'assinaturas'}
                {snapshot.plans.undetected > 0 &&
                  ` · ${snapshot.plans.undetected} sem plano identificado`}
              </span>
            )}
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
      {status !== 'error' && entries.length > 0 && (
        <QuotaPulseBand entries={entries} now={now} />
      )}
      {lifetime && (lifetime.tokensBurned > 0 || lifetime.usdEquivalent > 0) && (
        <div
          className="quota-panel__consumption"
          title="Consumo real acumulado em todos os projetos — o que custaria em API paga; a assinatura já cobre"
        >
          <span className="quota-panel__consumption-label">
            Consumo real acumulado
          </span>
          <span className="quota-panel__consumption-item">
            ⚡ <strong>{fmtTokens(lifetime.tokensBurned)}</strong> tokens
          </span>
          <span className="quota-panel__consumption-item">
            💵 <strong>{fmtUsd(lifetime.usdEquivalent)}</strong> em API
          </span>
          <span className="quota-panel__consumption-item">
            🪟 <strong>{lifetime.panesServed}</strong> panes
          </span>
          <span className="quota-panel__consumption-item">
            🔁 <strong>{lifetime.turns}</strong> turnos
          </span>
        </div>
      )}
      <RedlineMenuBarRow />
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
          {entries.map((entry) => {
            const account = accounts.find(
              (candidate) => candidate.id === entry.accountId,
            );
            return (
            <EntryCard
              key={entry.id}
              entry={entry}
              account={account}
              now={now}
              email={account?.email}
              needsRelogin={account?.needsRelogin}
              recommended={recommendedIds.has(entry.id)}
            />
            );
          })}
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
