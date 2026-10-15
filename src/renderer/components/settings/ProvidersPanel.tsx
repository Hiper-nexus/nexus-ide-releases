import '../../styles/providers-onboarding.css';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { AdapterAuthStatus, CliAutoUpdateStatus, ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { credentialLinkForKeySlot } from '../../../shared/credential-links';
import { useAccountStore } from '../../state/account-store';
import { useProviderStore } from '../../state/provider-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useToastStore } from '../../state/toast-store';
import { useLayoutStore } from '../../state/layout-store';
import { reportLicenseDenial } from '../../state/access-guard';
import { waitForSession, writeToPane } from '../../terminal/terminal-host';
import { formatDecisionTime } from '../../lib/decision-format';
import { openExternalFromAnchor } from '../../lib/open-external';
import { ActionCard } from '../ActionCard';
import { AccountsManager } from './AccountsManager';
import { ProviderLogo } from '../ProviderLogo';
import { PixelIcon } from '../PixelIcon';
import { SettingsSectionTitle } from './SettingsSectionTitle';
import {
  filterProvidersForTab,
  isExternalLoginProvider,
  isLocalCliProvider,
  isRemoteProvider,
  modelCountLabel,
  pickDefaultSelection,
  PROVIDERS_HUB_TABS,
  providerOpFeedback,
  providerRowCta,
  providerStateChips,
  providerStatusLabel,
  selectModelValue,
  tabDetectedLabel,
  type ProviderOpFeedback,
  type ProviderOpKind,
  type ProviderOpPhase,
  type ProvidersHubTab,
} from './providers-panel-view';

const cliUpdateFailureReasons: Record<string, string> = {
  timeout: 'tempo de espera esgotado',
  'install-failed': 'a instalação não terminou',
  'download-timeout': 'o tempo de espera do download esgotou',
  'different-launcher': 'outra instalação da CLI foi encontrada',
  'version-unreadable': 'não foi possível conferir a versão instalada',
  'launcher-missing': 'a CLI não foi encontrada após a atualização',
};

/**
 * Provider selection stays separate from the selected tool's account actions.
 */

function CliJobBanner({ job }: { job: ProviderOpFeedback | null }) {
  if (!job) return null;
  const icon =
    job.tone === 'live' ? 'status-busy' : job.tone === 'danger' ? 'warn' : 'check';
  return (
    <div
      className={`prov-detail__job prov-detail__job--${job.tone}`}
      data-testid="prov-cli-job"
      role={job.tone === 'danger' ? 'alert' : 'status'}
      aria-live={job.tone === 'danger' ? 'assertive' : 'polite'}
      aria-busy={job.tone === 'live'}
    >
      <span className="prov-detail__job-icon" aria-hidden="true">
        <PixelIcon name={icon} size={12} />
      </span>
      <span className="prov-detail__job-copy">
        <strong className="prov-detail__job-title">{job.title}</strong>
        <span className="prov-detail__job-detail">{job.detail}</span>
      </span>
    </div>
  );
}

function modelLabel(provider: ProviderSettingsInfo, model: string): string {
  const info = provider.modelInfo?.[model];
  const tags = [
    provider.customModels.includes(model) ? 'personalizado' : null,
    info?.availability ? { free: 'gratuito', cheap: 'econômico', paid: 'pago', 'api-only': 'somente API', deprecated: 'descontinuado' }[info.availability] : null,
    info?.costTier && info.costTier !== 'unknown' ? { free: 'sem custo', low: 'custo baixo', medium: 'custo médio', high: 'custo alto' }[info.costTier] : null,
  ].filter(Boolean);
  return tags.length > 0 ? `${model} (${tags.join(', ')})` : model;
}

function providerRiskWarning(provider: ProviderSettingsInfo): string | null {
  const risky = provider.models.filter((model) => {
    const availability = provider.modelInfo?.[model]?.availability;
    return availability === 'api-only' || availability === 'deprecated';
  });
  if (risky.length === 0) return null;
  return `Modelos bloqueados no roteamento automático: ${risky.slice(0, 3).join(', ')}. Ainda podem ser escolhidos manualmente.`;
}

function KeyField({ provider }: { provider: ProviderSettingsInfo }) {
  const setKey = useProviderStore((s) => s.setKey);
  const testKey = useProviderStore((s) => s.testKey);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // F-724: com provedor escolhido (DeepSeek), a vaga é a do provedor — a da
  // DeepSeek ou a do Token Plan (a mesma do Qwen Code). O valor nunca chega aqui.
  const slot = provider.providerChoice?.key;
  const keyAdapterId = slot?.adapterId ?? provider.adapterId;
  const keyLabel = slot?.label ?? 'API key';
  const keyEnvVar = slot ? slot.envVar : provider.keyEnvVar;
  const hasKey = slot ? slot.hasKey : provider.hasKey;
  const keyMasked = slot ? slot.keyMasked : provider.keyMasked;
  const credentialLink = keyAdapterId === provider.adapterId
    ? credentialLinkForKeySlot({
        envVar: keyEnvVar,
        providerId: provider.adapterId,
        upstreamId: provider.routable ? provider.upstream : null,
      })
    : null;

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const result = await setKey(keyAdapterId, draft);
      setDraft('');
      setStatus(result.ok ? 'key salva no Keychain' : result.error ?? 'falhou');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'falhou ao salvar key');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setStatus(null);
    try {
      await setKey(keyAdapterId, '');
      setStatus('key removida');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'falhou ao limpar key');
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus('testando…');
    try {
      const result = await testKey(keyAdapterId);
      setStatus(`${result.ok ? '✓' : '✗'} ${result.detail}`);
    } catch (err) {
      setStatus(err instanceof Error ? `✗ ${err.message}` : '✗ teste falhou');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prov__key">
      <div className="prov__key-row">
        <span className="prov__key-label" data-testid="prov-key-label">
          {keyLabel}
          {keyEnvVar && (
            <code className="prov__env"> → {keyEnvVar}</code>
          )}
          {credentialLink && (
            <>
              {' · '}
              <a
                className="settings-link"
                href={credentialLink.url}
                onClick={(e) => openExternalFromAnchor(e, credentialLink.url)}
              >
                obter em {credentialLink.label}
              </a>
            </>
          )}
        </span>
        <span
          className={`settings-chip ${hasKey ? 'settings-chip--ok' : 'settings-chip--warn'}`}
        >
          {hasKey ? keyMasked ?? 'set' : 'sem key'}
        </span>
      </div>
      {slot?.hint && <p className="prov__block-hint">{slot.hint}</p>}
      <div className="prov__key-input">
        <input
          className="settings-input"
          type="password"
          autoComplete="new-password"
          value={draft}
          aria-label={keyLabel}
          placeholder={hasKey ? '•••• (substituir)' : 'colar API key'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && draft && void save()}
        />
      </div>
      <div className="action-card-row prov__key-actions">
        <ActionCard
          icon="key"
          title="Salvar key"
          subtitle="Keychain seguro"
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={busy || !draft}
        />
        <ActionCard
          icon="bolt"
          title="Testar"
          subtitle="Probe de conexão"
          size="sm"
          onClick={() => void test()}
          disabled={busy}
        />
        {hasKey && (
          <ActionCard
            icon="close"
            title="Limpar"
            subtitle="Remove a key"
            variant="danger"
            size="sm"
            onClick={() => void clear()}
            disabled={busy}
          />
        )}
      </div>
      {!provider.secureStorageAvailable && (
        <p className="prov__warn">
          <PixelIcon name="warn" size={11} /> Keychain indisponível nesta máquina — a key não será persistida em
          disco (só nesta sessão). Nunca gravamos em plaintext.
        </p>
      )}
      {status && <p className="prov__status">{status}</p>}
    </div>
  );
}

/**
 * F-724: provedor de um adapter com mais de uma origem (DeepSeek: API direta
 * ou Alibaba Token Plan). Persistido como `upstream` pelo setConfig; o Main
 * recusa qualquer valor fora das opções.
 */
function ProviderChoiceField({
  provider,
  onChange,
}: {
  provider: ProviderSettingsInfo;
  onChange: (value: string) => void;
}) {
  const choice = provider.providerChoice;
  if (!choice) return null;
  const title = `Provedor do ${provider.label}`;
  const selected = choice.options.find((option) => option.id === choice.value);
  return (
    <div className="prov__block" data-testid="prov-provider-choice">
      <span className="prov__block-title">{title}</span>
      <label className="prov__field prov__field--wide">
        <select
          className="settings-input"
          aria-label={title}
          value={choice.value}
          onChange={(e) => onChange(e.target.value)}
        >
          {choice.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {selected?.hint && <span className="prov__hint">{selected.hint}</span>}
      </label>
    </div>
  );
}

function CustomModels({ provider }: { provider: ProviderSettingsInfo }) {
  const addModel = useProviderStore((s) => s.addModel);
  const removeModel = useProviderStore((s) => s.removeModel);
  const [draft, setDraft] = useState('');

  function add() {
    const clean = draft.trim();
    if (!clean) return;
    void addModel(provider.adapterId, clean);
    setDraft('');
  }

  return (
    <>
      Adicionar modelo (qualquer id que a LLM ofertar)
      <div className="prov__models-add">
        <input
          className="settings-input"
          autoComplete="off"
          value={draft}
          placeholder="ex.: glm-5.3, gpt-5.6, claude-sonnet-5…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="settings-btn" onClick={add} disabled={!draft.trim()}>
          + Adicionar
        </button>
      </div>
      {provider.customModels.length > 0 && (
        <div className="prov__models-chips">
          {provider.customModels.map((m) => (
            <span key={m} className="prov__model-chip">
              {m}
              <button
                className="prov__model-chip-x"
                onClick={() => void removeModel(provider.adapterId, m)}
                title="Remover"
                aria-label={`Remover modelo ${m}`}
              >
                <PixelIcon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

const PERMISSION_LABEL: Record<string, string> = {
  default: 'Default',
  auto: 'Auto',
  plan: 'Plan',
  bypass: 'Bypass',
  yolo: 'YOLO',
};

function ControlFlags({
  provider,
  patch,
}: {
  provider: ProviderSettingsInfo;
  patch: (p: Partial<Parameters<ReturnType<typeof useProviderStore.getState>['setConfig']>[0]>) => void;
}) {
  const hasPerm = provider.permissionModes.length > 0;
  const hasEffort = provider.efforts.length > 0;
  if (!hasPerm && !hasEffort && !provider.supportsVerbose) return null;

  return (
    <div className="prov__control">
      {hasPerm && (
        <div className="prov__ctl-row">
          <span
            className="prov__ctl-label"
            title="Como o agente pede permissão. Seguro Nexus força sandbox/aprovação; Auto/YOLO/Bypass exigem confirmação nativa."
          >
            Permissão
          </span>
          <div className="prov__ctl-btns">
            <button
              className={`prov__ctl-btn ${provider.permissionMode === '' ? 'prov__ctl-btn--on' : ''}`}
              onClick={() => patch({ permissionMode: '' })}
            >
              Seguro Nexus
            </button>
            {provider.permissionModes.map((m) => (
              <button
                key={m}
                className={`prov__ctl-btn ${provider.permissionMode === m ? 'prov__ctl-btn--on' : ''} ${m === 'yolo' || m === 'bypass' || m === 'auto' ? 'prov__ctl-btn--danger' : ''}`}
                onClick={() => patch({ permissionMode: m })}
              >
                {PERMISSION_LABEL[m] ?? m}
              </button>
            ))}
          </div>
        </div>
      )}
      {hasEffort && (
        <div className="prov__ctl-row">
          <span className="prov__ctl-label">Effort</span>
          <div className="prov__ctl-btns">
            <button
              className={`prov__ctl-btn ${provider.effort === '' ? 'prov__ctl-btn--on' : ''}`}
              onClick={() => patch({ effort: '' })}
            >
              CLI default
            </button>
            {provider.efforts.map((e) => (
              <button
                key={e}
                className={`prov__ctl-btn ${provider.effort === e ? 'prov__ctl-btn--on' : ''}`}
                onClick={() => patch({ effort: e })}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
      {provider.supportsVerbose && (
        <div className="prov__ctl-row">
          <span className="prov__ctl-label">Verbose</span>
          <div className="prov__ctl-btns">
            <button
              className={`prov__ctl-btn ${!provider.verbose ? 'prov__ctl-btn--on' : ''}`}
              onClick={() => patch({ verbose: false })}
            >
              Off
            </button>
            <button
              className={`prov__ctl-btn ${provider.verbose ? 'prov__ctl-btn--on' : ''}`}
              onClick={() => patch({ verbose: true })}
            >
              On
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Uma CLI só ganha atalho de login na linha quando ela declara o comando E
 * ainda não está autenticada — o botão existe para resolver "precisa login",
 * não para poluir linha que já está conectada (esse caminho fica no detalhe).
 */
export function tileNeedsLogin(provider: ProviderSettingsInfo): boolean {
  return providerRowCta(provider)?.kind === 'login';
}

function ProviderRow({
  provider,
  selected,
  accountCount,
  needsRelogin,
  authState,
  liveLabel,
  onSelect,
}: {
  provider: ProviderSettingsInfo;
  selected: boolean;
  accountCount: number;
  needsRelogin: boolean;
  authState: AdapterAuthStatus['state'] | 'checking';
  liveLabel?: string | null;
  onSelect: () => void;
}) {
  const status = liveLabel
    ? { label: liveLabel, tone: 'live' as const }
    : providerStatusLabel(provider, { needsRelogin, authState });
  const models = modelCountLabel(provider);

  return (
    <div
      className={`prov-row ${selected ? 'prov-row--selected' : ''} ${provider.enabled ? '' : 'prov-row--off'}`}
      role="listitem"
    >
      <button
        type="button"
        className="prov-row__select"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${provider.label}, ${status.label}, ${models}`}
        data-adapter={provider.adapterId}
      >
        <ProviderLogo
          adapterId={provider.adapterId}
          label={provider.label}
          fallback={provider.icon}
        />
        <span className="prov-row__identity">
          <span className="prov-row__name">{provider.label}</span>
          <span className={`prov-row__status prov-row__status--${status.tone}`}>
            <span className="prov-row__status-dot" aria-hidden="true" />
            {status.label}
          </span>
        </span>
        <span className="prov-row__meta">
          <span
            className="prov-row__models"
            title="Modelos no catálogo prontos para uso; modelos só-API ou descontinuados não contam como prontos"
          >
            {models}
          </span>
          {accountCount > 0 && (
            <span className="prov-row__accounts" title="Contas guardadas">
              {accountCount} {accountCount === 1 ? 'conta' : 'contas'}
            </span>
          )}
        </span>
        <span className="prov-row__chevron" aria-hidden="true">
          <PixelIcon name="chevron" size={10} />
        </span>
      </button>

    </div>
  );
}

function ProviderDetail({
  provider,
  authStatus,
  needsRelogin,
  onAuthStatusChange,
  batchBusy,
  onLiveRow,
}: {
  provider: ProviderSettingsInfo;
  authStatus: AdapterAuthStatus | null;
  /** Conta guardada com sessão morta: o chip de sessão acusa expirada. */
  needsRelogin: boolean;
  onAuthStatusChange: (status: AdapterAuthStatus) => void;
  /** Lote (instalar/atualizar todas) em curso: os botões locais cedem. */
  batchBusy: boolean;
  onLiveRow: (rowLabel: string | null) => void;
}) {
  const setConfig = useProviderStore((s) => s.setConfig);
  const hydrateProviders = useProviderStore((s) => s.hydrate);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [binDraft, setBinDraft] = useState(provider.binPath);
  const [argsDraft, setArgsDraft] = useState(provider.extraArgs.join(' '));
  const [installBusy, setInstallBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [cliJob, setCliJob] = useState<ProviderOpFeedback | null>(null);
  const riskWarning = providerRiskWarning(provider);

  function announceOp(
    kind: ProviderOpKind,
    phase: ProviderOpPhase,
    error?: string,
    toastAction?: { label: string; onClick: () => void },
    update?: { changed?: boolean; version?: string },
  ) {
    const job = providerOpFeedback(kind, phase, provider.label, error, update);
    setCliJob(job);
    onLiveRow(phase === 'running' ? job.rowLabel : null);
    const toastKind =
      job.tone === 'danger' ? 'error' : job.tone === 'ok' ? 'success' : 'info';
    useToastStore.getState().push(toastKind, job.title, {
      detail: job.detail,
      dedupeKey: `cli-job:${provider.adapterId}`,
      action: toastAction,
      ttlMs: toastAction ? 20_000 : undefined,
    });
  }

  async function installCli(mode: 'install' | 'update' = 'install') {
    const kind = mode === 'update' ? 'update' : 'install';
    setInstallBusy(true);
    setInstallError(null);
    announceOp(kind, 'running');
    try {
      const result = await window.nexus.providers.installCli(
        provider.adapterId,
        mode,
      );
      if (!result.ok) {
        const error =
          result.error ??
          (mode === 'update' ? 'atualização falhou' : 'instalação falhou');
        setInstallError(error);
        announceOp(kind, 'err', error);
      } else {
        await hydrateProviders();
        announceOp(kind, 'ok', undefined, undefined, result);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'falhou';
      setInstallError(error);
      announceOp(kind, 'err', error);
    } finally {
      setInstallBusy(false);
    }
  }

  async function installInTerminal() {
    const command =
      provider.installCommand?.trim() ||
      `echo "Consulte a documentação oficial para instalar a CLI ${provider.label}."`;
    const paneTitle = `Instalar ${provider.label}`;
    announceOp('terminal-install', 'running');
    const layout = useLayoutStore.getState();
    let paneId: string;
    try {
      paneId = layout.addShellPane({ focus: true });
    } catch (error) {
      // F-228: acesso negado lança LicenseError — toast padrão, sem pane.
      reportLicenseDenial(error);
      return;
    }
    layout.renameTitle(paneId, paneTitle);
    try {
      const sessionId = await waitForSession(paneId);
      if (!sessionId) throw new Error('terminal-unavailable');
      writeToPane(paneId, `${command}\n`);
      announceOp('terminal-install', 'ok', undefined, {
        label: 'Ver terminal',
        onClick: () => useProductNavigationStore.getState().openTerminal(),
      });
    } catch {
      announceOp(
        'terminal-install',
        'err',
        'O terminal não ficou disponível. A instalação não começou.',
      );
    }
  }

  const extraArgsKey = provider.extraArgs.join('\0');
  useEffect(() => {
    setBinDraft(provider.binPath);
    setArgsDraft(provider.extraArgs.join(' '));
  }, [provider.adapterId, provider.binPath, extraArgsKey, provider.extraArgs]);
  useEffect(() => {
    setCliJob(null);
    setInstallError(null);
    setInstallBusy(false);
  }, [provider.adapterId]);

  const patch = (p: Partial<Parameters<typeof setConfig>[0]>) => {
    void setConfig({ adapterId: provider.adapterId, ...p }).catch((err) => {
      console.warn('[providers] setConfig failed:', err);
    });
  };

  const modelValue = selectModelValue(provider);
  const stateChips = providerStateChips(provider, {
    needsRelogin,
    authState: authStatus?.state ?? 'checking',
  });

  return (
    <section className="prov-detail" data-adapter={provider.adapterId} aria-label={`Configurar ${provider.label}`}>
      <header className="prov-detail__head">
        <ProviderLogo
          adapterId={provider.adapterId}
          label={provider.label}
          fallback={provider.icon}
        />
        <div className="prov-detail__identity">
          <h3 className="prov-detail__title">{provider.label}</h3>
          <p className="prov-detail__sub">
            {provider.installed
              ? isLocalCliProvider(provider) && provider.detectedBin
                ? <span title={provider.detectedBin}>Ferramenta instalada neste computador</span>
                : isRemoteProvider(provider)
                  ? 'Provider remoto — acesso por chave de API.'
                  : 'Disponível nesta máquina.'
              : 'Ferramenta não instalada. Instale abaixo ou indique uma instalação existente em Avançado'}
          </p>
          {provider.cliInstallationWarning && (
            <p className="prov-detail__sub" role="status">{provider.cliInstallationWarning}</p>
          )}
          {provider.cliCompatibilityWarning && (
            <p className="prov-detail__sub" role="status">{provider.cliCompatibilityWarning}</p>
          )}
          {provider.cliAutoUpdate && (
            <p className={`prov-detail__sub${provider.cliAutoUpdate.status === 'failed' ? ' settings-field__note--warning' : ''}`} role="status">
              {provider.cliAutoUpdate.status === 'failed'
                ? `Atualização automática falhou: ${cliUpdateFailureReasons[provider.cliAutoUpdate.reason ?? ''] ?? 'não foi possível concluir a atualização'}. Com as atualizações automáticas ativas, o Nexus tenta de novo quando a CLI estiver livre.`
                : provider.cliAutoUpdate.status === 'updated'
                  ? `Atualizada automaticamente: ${provider.cliAutoUpdate.fromVersion} → ${provider.cliAutoUpdate.toVersion}`
                  : `Checada automaticamente: ${provider.cliAutoUpdate.toVersion} (em dia)`}
              {` · ${formatDecisionTime(provider.cliAutoUpdate.at)}`}
            </p>
          )}
          {stateChips.length > 0 && (
            <div
              className="prov-state-chips"
              role="list"
              aria-label={`Estado de ${provider.label}`}
            >
              {stateChips.map((chip) => (
                <span
                  key={chip.id}
                  role="listitem"
                  className={`prov-state-chip prov-state-chip--${chip.tone}`}
                >
                  <span className="prov-state-chip__dot" aria-hidden="true" />
                  {chip.label}
                </span>
              ))}
            </div>
          )}
          {!provider.installed && (
            <div className="prov-detail__install-actions">
              {provider.canAutoInstall && (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary prov-detail__install"
                  disabled={installBusy || batchBusy}
                  aria-busy={installBusy}
                  onClick={() => void installCli()}
                  title="Instala a CLI do provider pela fonte oficial (confirmação nativa mostra o comando exato)"
                >
                  {installBusy ? 'Instalando…' : 'Instalar automaticamente'}
                </button>
              )}
              {provider.installCommand?.trim() ? (
                <button
                  type="button"
                  className="settings-btn settings-btn--ghost prov-detail__install"
                  onClick={() => void installInTerminal()}
                  title="Abre um terminal no Nexus para rodar o comando de instalação compatível com este sistema e acompanhar a saída"
                >
                  <PixelIcon name="terminal" size={11} /> Instalar via terminal
                </button>
              ) : (
                <span className="prov-detail__install-hint">
                  Sem instalador nativo seguro para este sistema; use a versão
                  compatível do provider (no Windows, WSL quando indicado).
                </span>
              )}
            </div>
          )}
          {provider.installed && provider.canAutoInstall && (
            <div className="prov-detail__install-actions">
              <button
                type="button"
                className="settings-btn settings-btn--ghost prov-detail__install"
                disabled={installBusy || batchBusy}
                aria-busy={installBusy}
                onClick={() => void installCli('update')}
                title="Reexecuta o instalador oficial para colocar esta CLI na última versão — modelos novos exigem CLI atualizada (confirmação nativa mostra o comando exato)"
              >
                {installBusy ? 'Atualizando…' : 'Atualizar CLI'}
              </button>
            </div>
          )}
          <CliJobBanner job={cliJob} />
          {installError && !cliJob && (
            <p className="prov-detail__install-error" role="alert">
              <PixelIcon name="warn" size={11} /> {installError}
            </p>
          )}
        </div>
        <label className="prov__toggle" title="Habilitar/desabilitar">
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            aria-label={`${provider.enabled ? 'Desabilitar' : 'Habilitar'} ${provider.label}`}
          />
          <span className="prov__switch" aria-hidden="true">
            <span className="prov__switch-thumb" />
          </span>
          <span className="prov__toggle-label">
            {provider.enabled ? 'Ativada' : 'Desativada'}
          </span>
        </label>
      </header>

      <div className="prov__block prov__block--accounts">
        <AccountsManager
          adapterId={provider.adapterId}
          adapterLabel={provider.label}
          authStatus={authStatus}
          onAuthStatusChange={onAuthStatusChange}
          loginCommand={provider.loginCommand}
          onLoginActivity={(phase, error) => {
            announceOp('login', phase, error);
          }}
        />
      </div>

      <div className="prov__block">
        <span className="prov__block-title">Modelo padrão</span>
        <label className="prov__field prov__field--wide">
          <select
            className="settings-input"
            aria-label={`Modelo padrão de ${provider.label}`}
            value={modelValue}
            disabled={provider.models.length === 0}
            onChange={(e) => {
              const next = e.target.value;
              if (next) patch({ defaultModel: next });
            }}
          >
            {provider.models.length === 0 ? (
              <option value="">Nenhum modelo listado</option>
            ) : (
              provider.models.map((m) => (
                <option key={m} value={m}>
                  {modelLabel(provider, m)}
                </option>
              ))
            )}
          </select>
          {provider.modelInfo?.[provider.defaultModel]?.warning && (
            <span className="prov__hint">
              {provider.modelInfo[provider.defaultModel].warning}
            </span>
          )}
        </label>
      </div>

      {provider.providerChoice && (
        <ProviderChoiceField
          provider={provider}
          onChange={(value) => patch({ upstream: value })}
        />
      )}

      {(provider.keyEnvVar || provider.hasKey || !isLocalCliProvider(provider)) && (
        <div className="prov__block">
          <span className="prov__block-title">API key do provider</span>
          <p className="prov__block-hint">
            {provider.providerChoice
              ? 'A chave segue o provedor escolhido acima — cada uma só vai para o endpoint dela.'
              : 'Key do provedor (env). Contas de assinatura/failover ficam no bloco de contas — não misture os dois.'}
          </p>
          <KeyField provider={provider} />
        </div>
      )}

      <div className="prov-advanced">
        <button
          type="button"
          className="prov-advanced__toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <span>
            <PixelIcon name={advancedOpen ? 'chevron-down' : 'chevron'} size={10} />{' '}
            Avançado
          </span>
          <span className="prov-advanced__hint">
            binário, args, permissões, roteamento
          </span>
        </button>
        {advancedOpen && (
          <div className="prov-advanced__body">
            <div className="prov__field prov__field--wide">
              <CustomModels provider={provider} />
            </div>
            <div className="prov__block">
              <span className="prov__block-title">Modelo e execução</span>
              <div className="prov__grid">
                <label className="prov__field">
                  Binário (vazio = <code>{provider.detectedBin}</code>)
                  <input
                    className="settings-input"
                    autoComplete="off"
                    value={binDraft}
                    placeholder={provider.detectedBin}
                    onChange={(e) => setBinDraft(e.target.value)}
                    onBlur={() => patch({ binPath: binDraft })}
                  />
                </label>
                <label className="prov__field prov__field--wide">
                  Args extras
                  <input
                    className="settings-input"
                    autoComplete="off"
                    value={argsDraft}
                    placeholder="ex.: --verbose --foo bar"
                    onChange={(e) => setArgsDraft(e.target.value)}
                    onBlur={() =>
                      patch({
                        extraArgs: argsDraft.split(/\s+/).filter(Boolean),
                      })
                    }
                  />
                </label>
                {provider.routable && !provider.providerChoice && (
                  <label className="prov__field prov__field--wide">
                    Roteamento (upstream)
                    <select
                      className="settings-input"
                      value={provider.upstream}
                      onChange={(e) => patch({ upstream: e.target.value })}
                    >
                      {provider.upstreams.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.label}
                          {u.requiresToken ? ' (requer key)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
            <div className="prov__block">
              <span className="prov__block-title">Permissões do agente</span>
              <ControlFlags provider={provider} patch={patch} />
            </div>
          </div>
        )}
      </div>

      {riskWarning && <p className="prov__warn">{riskWarning}</p>}
    </section>
  );
}

const TAB_LABELS: Record<ProvidersHubTab, string> = {
  clis: 'Ferramentas de IA',
  login: 'Entrar nas contas',
  remote: 'Serviços por API',
};

export function ProvidersPanel() {
  const providers = useProviderStore((s) => s.providers);
  const hydrate = useProviderStore((s) => s.hydrate);
  const accounts = useAccountStore((s) => s.accounts);
  const [tab, setTab] = useState<ProvidersHubTab>('clis');
  const [showAbsentByTab, setShowAbsentByTab] = useState({
    clis: true,
    login: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [authStatuses, setAuthStatuses] = useState<readonly AdapterAuthStatus[] | null>(null);
  const [autoCliUpdates, setAutoCliUpdates] = useState<CliAutoUpdateStatus | null>(null);
  const [autoCliBusy, setAutoCliBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void window.nexus.providers.getCliAutoUpdates().then(
        (status) => { if (alive) setAutoCliUpdates(status); },
        () => { if (alive) setAutoCliUpdates({ enabled: false, deferredUntil: null, lastCheckedAt: null }); },
      );
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  async function changeAutoCliUpdates(enabled: boolean) {
    setAutoCliBusy(true);
    try {
      setAutoCliUpdates(await window.nexus.providers.setCliAutoUpdates(enabled));
    } catch {
      setAutoCliUpdates((current) => current && { ...current, error: 'Não consegui salvar a preferência.' });
    } finally { setAutoCliBusy(false); }
  }

  const acceptAuthStatus = useCallback((status: AdapterAuthStatus) => {
    setAuthStatuses((current) => [
      ...(current ?? []).filter((item) => item.adapterId !== status.adapterId),
      status,
    ]);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.nexus.providers.authStatus().then(
      (statuses) => { if (alive) setAuthStatuses(statuses); },
      () => { if (alive) setAuthStatuses([]); },
    );
    return () => { alive = false; };
  }, []);

  // The main process publishes observed state after each auth probe. Consume
  // that snapshot without probing again and creating a broadcast loop.
  useEffect(() => {
    setAuthStatuses((current) => {
      let next = current;
      for (const provider of providers) {
        if (!provider.authState) continue;
        const previous = next?.find((status) => status.adapterId === provider.adapterId);
        if (previous?.state === provider.authState) continue;
        next = [
          ...(next ?? []).filter((status) => status.adapterId !== provider.adapterId),
          {
            adapterId: provider.adapterId,
            state: provider.authState,
            detail: provider.authState === 'ok'
              ? 'Sessão verificada nesta máquina.'
              : provider.authState === 'missing'
                ? 'Entre nesta ferramenta para usar sua conta.'
                : 'Não foi possível verificar a conexão.',
          },
        ];
      }
      return next;
    });
  }, [providers]);

  const showAbsent = tab === 'remote' ? false : showAbsentByTab[tab];

  const visible = useMemo(
    () => filterProvidersForTab(providers, tab, { showAbsent }),
    [providers, tab, showAbsent],
  );

  useEffect(() => {
    setSelectedId((prev) => pickDefaultSelection(visible, prev));
  }, [visible]);

  const selected = useMemo(
    () => visible.find((p) => p.adapterId === selectedId) ?? null,
    [visible, selectedId],
  );

  const accountCountByAdapter = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of accounts) {
      map.set(a.adapterId, (map.get(a.adapterId) ?? 0) + 1);
    }
    return map;
  }, [accounts]);

  // Sessão morta (refresh falhou) por adapter: a linha "conectada" ganha
  // status + CTA de re-login em vez de fingir saúde.
  const reloginByAdapter = useMemo(() => {
    const set = new Set<string>();
    for (const a of accounts) {
      if (a.needsRelogin) set.add(a.adapterId);
    }
    return set;
  }, [accounts]);

  const detectedLabel = useMemo(
    () => tabDetectedLabel(tab, providers, visible.length),
    [tab, providers, visible.length],
  );

  // Contagem por aba = tamanho do catálogo daquele tipo (independe do filtro
  // "Mostrar ferramentas não instaladas"), para a pessoa ver o que cada aba cobre antes de abrir.
  const tabCounts = useMemo(
    () => ({
      clis: providers.filter(isLocalCliProvider).length,
      login: providers.filter(isExternalLoginProvider).length,
      remote: providers.filter(isRemoteProvider).length,
    }),
    [providers],
  );

  async function refreshCatalog() {
    setRefreshing(true);
    try {
      // Re-fold login PATH + re-probe absolute CLI paths, then refresh UI.
      if (typeof window.nexus.adapters.rescan === 'function') {
        await window.nexus.adapters.rescan();
      }
      await hydrate();
      // O badge "N contas" e o status de sessão vêm da account store — sem
      // este hydrate o pós-login mostrava a linha stale até outro reload.
      await useAccountStore.getState().hydrate();
      setAuthStatuses(await window.nexus.providers.authStatus());
    } catch (err) {
      console.warn('[providers] refresh failed:', err);
      // Spinner parava sem feedback: o operador achava que o login não pegou.
      setCatalogNotice('Não consegui reexaminar as CLIs. Tente de novo.');
    } finally {
      setRefreshing(false);
    }
  }

  const missingInstallable = useMemo(
    () => providers.filter((p) => !p.installed && p.canAutoInstall),
    [providers],
  );
  // CLIs instaladas com receita oficial: `npm install -g pkg` / instalador
  // oficial reexecutado = upgrade para a última versão (F-520: CLIs velhas
  // rejeitam modelos novos com erro 400 na abertura do pane).
  const updatableInstalled = useMemo(
    () => providers.filter((p) => p.installed && p.canAutoInstall),
    [providers],
  );
  const [provisioning, setProvisioning] = useState<string | null>(null);
  const [provisionSummary, setProvisionSummary] = useState<string | null>(null);
  const [liveRow, setLiveRow] = useState<{ adapterId: string; label: string } | null>(null);

  /**
   * Provisionador de máquina nova: instala TODAS as CLIs ausentes em
   * sequência pelo mesmo fluxo gated de 1 CLI (receita oficial em código +
   * confirmação nativa com o comando exato por instalação — a doutrina de
   * segurança não muda no lote, só a conveniência).
   */
  async function provisionMissing() {
    setProvisionSummary(null);
    const done: string[] = [];
    const failed: string[] = [];
    for (const provider of missingInstallable) {
      setProvisioning(provider.label);
      try {
        const result = await window.nexus.providers.installCli(provider.adapterId);
        if (result.ok) done.push(provider.label);
        else failed.push(`${provider.label} (${result.error ?? 'falhou'})`);
      } catch {
        failed.push(provider.label);
      }
    }
    setProvisioning(null);
    await hydrate();
    setProvisionSummary(
      [
        done.length > 0 ? `instaladas: ${done.join(', ')}` : null,
        failed.length > 0 ? `pendentes: ${failed.join('; ')}` : null,
        done.length === 0 && failed.length === 0 ? 'nada a instalar' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }

  /**
   * Atualizador em lote: reexecuta a receita oficial de cada CLI JÁ instalada
   * (mesmo fluxo gated — confirmação nativa por CLI com o comando exato).
   * `npm install -g <pkg>` sobre uma versão existente instala a última.
   */
  async function updateInstalled() {
    setProvisionSummary(null);
    const done: string[] = [];
    const unchanged: string[] = [];
    const verified: string[] = [];
    const failed: string[] = [];
    for (const provider of updatableInstalled) {
      setProvisioning(provider.label);
      try {
        const result = await window.nexus.providers.installCli(
          provider.adapterId,
          'update',
        );
        if (result.ok && !result.version) failed.push(
          `${provider.label} (versão não verificada)`,
        );
        else if (result.ok && result.changed === false) unchanged.push(
          `${provider.label} (${result.version ?? 'mesma versão'})`,
        );
        else if (result.ok && result.changed === undefined) verified.push(
          `${provider.label} (${result.version ?? 'versão desconhecida'})`,
        );
        else if (result.ok) done.push(provider.label);
        else failed.push(`${provider.label} (${result.error ?? 'falhou'})`);
      } catch {
        failed.push(provider.label);
      }
    }
    setProvisioning(null);
    await hydrate();
    setProvisionSummary(
      [
        done.length > 0 ? `atualizadas: ${done.join(', ')}` : null,
        unchanged.length > 0 ? `sem mudança: ${unchanged.join(', ')}` : null,
        verified.length > 0 ? `verificadas: ${verified.join(', ')}` : null,
        failed.length > 0 ? `pendentes: ${failed.join('; ')}` : null,
        done.length === 0 && unchanged.length === 0 && verified.length === 0 && failed.length === 0 ? 'nada a atualizar' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }

  function onTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const order = PROVIDERS_HUB_TABS;
    const idx = order.indexOf(tab);
    if (idx < 0) return;
    let nextTab: ProvidersHubTab | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      nextTab = order[(idx + 1) % order.length]!;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      nextTab = order[(idx - 1 + order.length) % order.length]!;
    } else if (event.key === 'Home') {
      event.preventDefault();
      nextTab = order[0]!;
    } else if (event.key === 'End') {
      event.preventDefault();
      nextTab = order[order.length - 1]!;
    }
    if (!nextTab) return;
    setTab(nextTab);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`#prov-tab-${nextTab}`)
      ?.focus();
  }

  return (
    <section className="prov-hub">
      <header className="prov-hub__header">
        <div>
          <SettingsSectionTitle>Contas de IA</SettingsSectionTitle>
          <p className="settings-detail__hint prov-hub__lede">
            Escolha a IA que você usa. Conecte sua conta ou configure uma chave de API.
          </p>
        </div>
        {(missingInstallable.length > 0 || updatableInstalled.length > 0) && (
          <div className="prov-hub__header-actions">
            <details className="prov-hub__batch">
              <summary>Instalar ou atualizar várias ferramentas</summary>
              <div className="prov-hub__batch-actions">
                {missingInstallable.length > 0 && (
                  <button
                    type="button"
                    className="settings-btn"
                    disabled={provisioning !== null}
                    onClick={() => void provisionMissing()}
                    title="Instala em sequência apenas as CLIs ausentes com instalador oficial verificado — cada uma pede a confirmação nativa com o comando exato"
                  >
                    {provisioning
                      ? `Instalando ${provisioning}…`
                      : `Instalar ${missingInstallable.length} ferramenta${missingInstallable.length === 1 ? '' : 's'} com instalador verificado`}
                  </button>
                )}
                {updatableInstalled.length > 0 && (
                  <button
                    type="button"
                    className="settings-btn"
                    disabled={provisioning !== null}
                    onClick={() => void updateInstalled()}
                    title="Reexecuta o instalador oficial de cada CLI instalada para atualizá-la à última versão — cada uma pede a confirmação nativa com o comando exato"
                  >
                    {provisioning
                      ? `Atualizando ${provisioning}…`
                      : `Atualizar ${updatableInstalled.length} ferramentas`}
                  </button>
                )}
              </div>
            </details>
          </div>
        )}
      </header>

      <div className="prov-hub__api-keys-banner" role="region" aria-label="Acesso rápido às chaves de API">
        <div className="prov-hub__api-keys-banner-info">
          <PixelIcon name="key" size={12} className="prov-hub__api-keys-banner-icon" />

          <span className="prov-hub__api-keys-banner-text">
            Já tem uma chave de API? Configure a conexão por chave.
          </span>
        </div>
        <button
          type="button"
          className="settings-btn settings-btn--sm"
          onClick={() => useProductNavigationStore.getState().openSettings('api-keys')}
        >
          Gerenciar chaves de API <PixelIcon name="arrow-right" size={10} />
        </button>
      </div>
      {provisionSummary && (
        <p className="settings-field__note prov-hub__notice" role="status">
          <PixelIcon name="check" size={11} /> {provisionSummary}
        </p>
      )}

      <div
        className="prov-hub__tabs"
        role="tablist"
        aria-label="Tipo de provider"
        onKeyDown={onTabKeyDown}
      >
        {PROVIDERS_HUB_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`prov-tab-${id}`}
            aria-controls="prov-tabpanel"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={`prov-hub__tab ${tab === id ? 'prov-hub__tab--on' : ''}`}
            onClick={() => setTab(id)}
          >
            {TAB_LABELS[id]}
            <span className="prov-hub__tab-count">{tabCounts[id]}</span>
          </button>
        ))}
      </div>

      <div
        className="prov-hub__panel"
        role="tabpanel"
        id="prov-tabpanel"
        aria-labelledby={`prov-tab-${tab}`}
      >
        <div className="prov-hub__toolbar">
          <span className="prov-hub__detected" data-testid="prov-detected-count">
            {detectedLabel}
          </span>
          {tab !== 'remote' && (
            <label className="prov-hub__show-absent">
              <input
                type="checkbox"
                checked={showAbsent}
                onChange={(e) => {
                  setShowAbsentByTab((current) => ({
                    ...current,
                    [tab]: e.target.checked,
                  }));
                }}
              />
              Mostrar ferramentas não instaladas
            </label>
          )}
          {tab === 'clis' && autoCliUpdates && (
            <label className="prov-hub__show-absent" title="Atualiza apenas instalações reconhecidas, sem pane ativo e após confirmação nativa dos comandos">
              <input
                type="checkbox"
                checked={autoCliUpdates.enabled}
                disabled={autoCliBusy}
                aria-label="Atualizar ferramentas automaticamente"
                onChange={(event) => void changeAutoCliUpdates(event.target.checked)}
              />
              Atualizar ferramentas automaticamente
            </label>
          )}
          <div className="prov-hub__actions">
            <button
              type="button"
              className="settings-btn"
              disabled={refreshing}
              onClick={() => void refreshCatalog()}
              title="Procura ferramentas instaladas, verifica a conexão e atualiza o catálogo de modelos"
              data-testid="prov-rescan-clis"
            >
              {refreshing ? 'Examinando…' : 'Verificar ferramentas'}
            </button>
          </div>
        </div>
        {tab === 'clis' && autoCliUpdates && (
          <p className="settings-field__note" role="status">
            {autoCliUpdates.error
              ? autoCliUpdates.error
              : autoCliUpdates.enabled
                ? `Atualizações automáticas ativas · última verificação: ${autoCliUpdates.lastCheckedAt ? new Date(autoCliUpdates.lastCheckedAt).toLocaleString('pt-BR') : 'ainda não houve'}`
                : 'Atualizações automáticas desligadas'}
          </p>
        )}

        {tab === 'clis' && autoCliUpdates?.enabled && (
          <p className="settings-field__note">
            O Nexus verifica todas as CLIs ao iniciar e uma vez por dia. Uma CLI com painel aberto atualiza quando o
            último painel dela fecha; Claude, Devin e Grok atualizam na hora, e o painel aberto segue na versão dele.
            Canais desconhecidos ou que exigem privilégios continuam manuais.
          </p>
        )}

        <div className="prov-hub__workspace">
        {visible.length === 0 ? (
          <div className="prov-hub__empty" data-testid="prov-empty">
            <span className="prov-hub__empty-icon" aria-hidden="true">
              <PixelIcon name={tab === 'remote' ? 'link' : 'agent'} size={16} />
            </span>
            {tab === 'clis' ? (
              <>
                <p className="prov-hub__empty-title">
                  Nenhuma ferramenta de IA encontrada neste computador.
                  Escolha uma para instalar ou use Verificar ferramentas se já instalou uma.
                </p>
                <p className="prov-hub__empty-hint">
                  Você poderá entrar com sua conta na ferramenta escolhida.
                </p>
                {!showAbsent && (
                  <button
                    type="button"
                    className="settings-btn settings-btn--primary"
                    onClick={() => setShowAbsentByTab((current) => ({
                      ...current,
                      clis: true,
                    }))}
                  >
                    Ver ferramentas para instalar
                  </button>
                )}
              </>
            ) : tab === 'remote' ? (
              <p className="prov-hub__empty-title">Nenhum provider remoto/API configurado neste build.</p>
            ) : (
              <p className="prov-hub__empty-title">
                Nenhuma CLI com login de assinatura nesta lista.
                {showAbsent
                  ? ''
                  : ' Ative “Mostrar ferramentas não instaladas” para ver as instaláveis.'}
              </p>
            )}
          </div>
        ) : (
          <div className="prov-row-list" role="list" aria-label="Ferramentas de IA" data-testid="prov-tile-grid">
            {visible.map((p) => (
              <ProviderRow
                key={p.adapterId}
                provider={p}
                selected={p.adapterId === selectedId}
                accountCount={accountCountByAdapter.get(p.adapterId) ?? 0}
                needsRelogin={reloginByAdapter.has(p.adapterId)}
                authState={authStatuses?.find((status) => status.adapterId === p.adapterId)?.state
                  ?? p.authState ?? (authStatuses === null ? 'checking' : 'unknown')}
                liveLabel={
                  liveRow?.adapterId === p.adapterId ? liveRow.label : null
                }
                onSelect={() => setSelectedId(p.adapterId)}
              />
            ))}
          </div>
        )}

        {selected && (
          <ProviderDetail
            key={selected.adapterId}
            provider={selected}
            needsRelogin={reloginByAdapter.has(selected.adapterId)}
            authStatus={authStatuses === null ? null : authStatuses.find(
              (status) => status.adapterId === selected.adapterId,
            ) ?? { adapterId: selected.adapterId, state: selected.authState ?? 'unknown', detail: 'Não foi possível verificar a conexão.' }}
            onAuthStatusChange={acceptAuthStatus}
            batchBusy={provisioning !== null}
            onLiveRow={(label) => {
              setLiveRow(
                label
                  ? { adapterId: selected.adapterId, label }
                  : null,
              );
            }}
          />
        )}
        </div>
        {catalogNotice && (
          <p
            className="settings-field__note prov-hub__login-notice"
            role="status"
            data-testid="prov-login-notice"
          >
            <PixelIcon name="warn" size={11} /> {catalogNotice}
          </p>
        )}
      </div>
    </section>
  );
}
