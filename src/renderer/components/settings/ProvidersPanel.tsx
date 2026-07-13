import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { credentialLinkForKeySlot } from '../../../shared/credential-links';
import { useAccountStore } from '../../state/account-store';
import { useProviderStore } from '../../state/provider-store';
import { openExternalFromAnchor } from '../../lib/open-external';
import { ActionCard } from '../ActionCard';
import { AccountsManager } from './AccountsManager';
import { ProviderLogo } from '../ProviderLogo';
import {
  filterProvidersForTab,
  isLocalCliProvider,
  modelCountLabel,
  pickDefaultSelection,
  PROVIDERS_HUB_TABS,
  providerStatusLabel,
  selectModelValue,
  tabDetectedLabel,
  type ProvidersHubTab,
} from './providers-panel-view';

/**
 * Providers hub — Overclock-style scan (tiles + detected count + tabs),
 * Nexus-depth underneath (vault multi-conta, Keychain, permissões, routing).
 */

function modelLabel(provider: ProviderSettingsInfo, model: string): string {
  const info = provider.modelInfo?.[model];
  const tags = [
    provider.customModels.includes(model) ? 'custom' : null,
    info?.availability ?? null,
    info?.costTier && info.costTier !== 'unknown' ? `cost:${info.costTier}` : null,
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
  const credentialLink = credentialLinkForKeySlot({
    envVar: provider.keyEnvVar,
    providerId: provider.adapterId,
    upstreamId: provider.routable ? provider.upstream : null,
  });

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const result = await setKey(provider.adapterId, draft);
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
      await setKey(provider.adapterId, '');
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
      const result = await testKey(provider.adapterId);
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
        <span className="prov__key-label">
          API key
          {provider.keyEnvVar && (
            <code className="prov__env"> → {provider.keyEnvVar}</code>
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
          className={`settings-chip ${provider.hasKey ? 'settings-chip--ok' : 'settings-chip--warn'}`}
        >
          {provider.hasKey ? provider.keyMasked ?? 'set' : 'sem key'}
        </span>
      </div>
      <div className="prov__key-input">
        <input
          className="settings-input"
          type="password"
          value={draft}
          placeholder={provider.hasKey ? '•••• (substituir)' : 'colar API key'}
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
        {provider.hasKey && (
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
          ⚠ Keychain indisponível nesta máquina — a key não será persistida em
          disco (só nesta sessão). Nunca gravamos em plaintext.
        </p>
      )}
      {status && <p className="prov__status">{status}</p>}
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
          value={draft}
          placeholder="ex.: glm-5.2, gpt-5.6, claude-sonnet-5…"
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
              >
                ✕
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
  untrusted: 'Untrusted',
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

function ProviderTile({
  provider,
  selected,
  accountCount,
  onSelect,
}: {
  provider: ProviderSettingsInfo;
  selected: boolean;
  accountCount: number;
  onSelect: () => void;
}) {
  const status = providerStatusLabel(provider);
  const models = modelCountLabel(provider);

  return (
    <button
      type="button"
      role="listitem"
      className={`prov-tile ${selected ? 'prov-tile--selected' : ''} ${provider.enabled ? '' : 'prov-tile--off'}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${provider.label}, ${status.label}, modelos ${models}`}
      data-adapter={provider.adapterId}
    >
      <ProviderLogo
        adapterId={provider.adapterId}
        label={provider.label}
        fallback={provider.icon}
      />
      <span className="prov-tile__name">{provider.label}</span>
      <span className={`prov-tile__status prov-tile__status--${status.tone}`}>
        {status.label}
      </span>
      <span className="prov-tile__meta">
        <span className="prov-tile__models" title="Modelos prontos / no catálogo">
          {models}
        </span>
        {accountCount > 0 && (
          <span className="prov-tile__accounts" title="Contas no vault">
            {accountCount} ct
          </span>
        )}
      </span>
    </button>
  );
}

function ProviderDetail({ provider }: { provider: ProviderSettingsInfo }) {
  const setConfig = useProviderStore((s) => s.setConfig);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [binDraft, setBinDraft] = useState(provider.binPath);
  const [argsDraft, setArgsDraft] = useState(provider.extraArgs.join(' '));
  const riskWarning = providerRiskWarning(provider);

  const extraArgsKey = provider.extraArgs.join('\0');
  useEffect(() => {
    setBinDraft(provider.binPath);
    setArgsDraft(provider.extraArgs.join(' '));
  }, [provider.adapterId, provider.binPath, extraArgsKey, provider.extraArgs]);

  const patch = (p: Partial<Parameters<typeof setConfig>[0]>) => {
    void setConfig({ adapterId: provider.adapterId, ...p }).catch((err) => {
      console.warn('[providers] setConfig failed:', err);
    });
  };

  const modelValue = selectModelValue(provider);

  return (
    <div className="prov-detail" data-adapter={provider.adapterId}>
      <header className="prov-detail__head">
        <ProviderLogo
          adapterId={provider.adapterId}
          label={provider.label}
          fallback={provider.icon}
        />
        <div className="prov-detail__identity">
          <h4 className="prov-detail__title">{provider.label}</h4>
          <p className="prov-detail__sub">
            {provider.installed
              ? `Detectado · ${provider.detectedBin || provider.adapterId}`
              : 'Não encontrado no PATH — instale a CLI ou aponte o binário em Avançado'}
          </p>
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
            {provider.enabled ? 'on' : 'off'}
          </span>
        </label>
      </header>

      <div className="prov__block">
        <span className="prov__block-title">Modelo padrão</span>
        <label className="prov__field prov__field--wide">
          <select
            className="settings-input"
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
        <div className="prov__field prov__field--wide">
          <CustomModels provider={provider} />
        </div>
      </div>

      <div className="prov__block prov__block--accounts">
        <AccountsManager
          adapterId={provider.adapterId}
          adapterLabel={provider.label}
        />
      </div>

      {(provider.keyEnvVar || provider.hasKey || !isLocalCliProvider(provider)) && (
        <div className="prov__block">
          <span className="prov__block-title">API key do provider</span>
          <p className="prov__block-hint">
            Key do provedor (env). Contas de assinatura/failover ficam no bloco
            de contas — não misture os dois.
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
          <span>{advancedOpen ? '▾' : '▸'} Avançado</span>
          <span className="prov-advanced__hint">
            binário, args, permissões, roteamento
          </span>
        </button>
        {advancedOpen && (
          <div className="prov-advanced__body">
            <div className="prov__block">
              <span className="prov__block-title">Modelo e execução</span>
              <div className="prov__grid">
                <label className="prov__field">
                  Binário (vazio = <code>{provider.detectedBin}</code>)
                  <input
                    className="settings-input"
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
                {provider.routable && (
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

      {provider.loginHint && <p className="prov__hint">{provider.loginHint}</p>}
      {riskWarning && <p className="prov__warn">{riskWarning}</p>}
    </div>
  );
}

const TAB_LABELS: Record<ProvidersHubTab, string> = {
  clis: 'CLIs',
  login: 'Login externo',
  remote: 'Remotos / API',
};

export function ProvidersPanel() {
  const providers = useProviderStore((s) => s.providers);
  const hydrate = useProviderStore((s) => s.hydrate);
  const accounts = useAccountStore((s) => s.accounts);
  const [tab, setTab] = useState<ProvidersHubTab>('clis');
  const [showAbsent, setShowAbsent] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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

  const detectedLabel = useMemo(
    () => tabDetectedLabel(tab, providers, visible.length),
    [tab, providers, visible.length],
  );

  async function refreshCatalog() {
    setRefreshing(true);
    try {
      await hydrate();
    } catch (err) {
      console.warn('[providers] refresh failed:', err);
    } finally {
      setRefreshing(false);
    }
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
          <h3 className="settings-detail__title">Providers</h3>
          <p className="settings-detail__hint prov-hub__lede">
            tokens · modelos · contas
          </p>
        </div>
      </header>

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
                onChange={(e) => setShowAbsent(e.target.checked)}
              />
              Mostrar ausentes
            </label>
          )}
          <div className="prov-hub__actions">
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              disabled={refreshing}
              onClick={() => void refreshCatalog()}
              title="Re-lê CLIs no PATH, auth e catálogo de modelos"
            >
              {refreshing ? 'Atualizando…' : 'Atualizar modelos'}
            </button>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="prov-hub__empty" data-testid="prov-empty">
            {tab === 'clis' ? (
              <>
                <p>
                  Nenhuma CLI detectada no PATH. Instale Claude, Codex, Gemini ou
                  outra e clique em <strong>Atualizar modelos</strong>.
                </p>
                <p className="prov-hub__empty-hint">
                  Dica: o Nexus procura em PATH + ~/.local/bin após o boot.
                </p>
              </>
            ) : tab === 'remote' ? (
              <p>Nenhum provider remoto/API configurado neste build.</p>
            ) : (
              <p>
                Nenhuma CLI de login externo (assinatura/OAuth) nesta lista.
                {showAbsent
                  ? ''
                  : ' Ative “Mostrar ausentes” para ver as instaláveis.'}
              </p>
            )}
          </div>
        ) : (
          <div className="prov-tile-grid" role="list" data-testid="prov-tile-grid">
            {visible.map((p) => (
              <ProviderTile
                key={p.adapterId}
                provider={p}
                selected={p.adapterId === selectedId}
                accountCount={accountCountByAdapter.get(p.adapterId) ?? 0}
                onSelect={() => setSelectedId(p.adapterId)}
              />
            ))}
          </div>
        )}

        {selected && (
          <ProviderDetail key={selected.adapterId} provider={selected} />
        )}
      </div>
    </section>
  );
}
