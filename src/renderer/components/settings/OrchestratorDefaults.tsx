import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '../../../shared/account-types';
import type { OrchSettings } from '../../../shared/settings-types';
import type { AdapterInfo } from '../../../shared/types';
import { isOrchestratorCapableAdapter } from '../../orch/orchestrator-runtime';

type OrchestratorDefaultsValue = Pick<
  OrchSettings,
  'defaultAdapterId' | 'defaultModel' | 'defaultAccountId'
>;

const INITIAL_DEFAULTS: OrchestratorDefaultsValue = {
  defaultAdapterId: 'claude',
  defaultModel: '',
  defaultAccountId: '',
};

function selectDefaults(settings: OrchSettings): OrchestratorDefaultsValue {
  return {
    defaultAdapterId: settings.defaultAdapterId || 'claude',
    defaultModel: settings.defaultModel,
    defaultAccountId: settings.defaultAccountId,
  };
}

export function OrchestratorDefaults() {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [defaults, setDefaults] =
    useState<OrchestratorDefaultsValue>(INITIAL_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const stopAdapters = window.nexus.adapters.onChanged((next) => {
      if (!cancelled) setAdapters(next);
    });
    const stopAccounts = window.nexus.accounts.onChanged((next) => {
      if (!cancelled) setAccounts(next);
    });
    const load = async () => {
      const [orch, adapterList, accountList] = await Promise.all([
        window.nexus.settings.orchGet(),
        window.nexus.adapters.list(),
        window.nexus.accounts.list(),
      ]);
      if (cancelled) return;
      setDefaults(selectDefaults(orch));
      setAdapters(adapterList);
      setAccounts(accountList);
      setLoading(false);
    };
    void load().catch((cause) => {
      if (cancelled) return;
      setLoading(false);
      setError(
        cause instanceof Error ? cause.message : 'Falha ao carregar padrões.',
      );
    });
    return () => {
      cancelled = true;
      stopAdapters();
      stopAccounts();
    };
  }, []);

  const capableAdapters = useMemo(
    () => adapters.filter(isOrchestratorCapableAdapter),
    [adapters],
  );
  const selectedAdapter = capableAdapters.find(
    (adapter) => adapter.id === defaults.defaultAdapterId,
  );
  const configuredAdapter = adapters.find(
    (adapter) => adapter.id === defaults.defaultAdapterId,
  );
  const providerUnavailable = !loading && !selectedAdapter;
  const providerAccounts = accounts.filter(
    (account) => account.adapterId === defaults.defaultAdapterId,
  );
  const missingModel =
    defaults.defaultModel &&
    !selectedAdapter?.models.list.includes(defaults.defaultModel);
  const missingAccount =
    defaults.defaultAccountId &&
    !providerAccounts.some((account) => account.id === defaults.defaultAccountId);

  const save = async (patch: Partial<OrchestratorDefaultsValue>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const previous = defaults;
    setDefaults({ ...defaults, ...patch });
    setSaving(true);
    setError(null);
    try {
      const saved = await window.nexus.settings.orchSet(patch);
      setDefaults(selectDefaults(saved));
    } catch (cause) {
      setDefaults(previous);
      setError(
        cause instanceof Error ? cause.message : 'Falha ao salvar os padrões.',
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const disabled = loading || saving;
  const statusLabel = loading
    ? 'Carregando'
    : selectedAdapter
      ? `${selectedAdapter.label} · MCP conectado`
      : 'Provider indisponível';

  return (
    <div className="settings-orchestrator" aria-busy={loading || saving}>
      <div className="settings-orchestrator__head">
        <div>
          <h4 className="settings-orchestrator__title">Orquestrador agêntico</h4>
          <p className="settings-orchestrator__summary">
            Escolha o CLI que coordena o squad, seu modelo e sua conta.
          </p>
        </div>
        <span
          className={`settings-chip ${providerUnavailable ? 'settings-chip--warn' : 'settings-chip--ok'}`}
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {providerUnavailable && (
        <p className="settings-orchestrator__warning" role="status">
          Instale ou escolha outro provider com conexão Nexus MCP para iniciar
          novos squads.
        </p>
      )}

      <div className="settings-orchestrator__grid">
        <label className="settings-field">
          Provider
          <select
            className="settings-input"
            aria-label="Provider do orquestrador"
            value={defaults.defaultAdapterId}
            disabled={disabled || capableAdapters.length === 0}
            onChange={(event) =>
              void save({
                defaultAdapterId: event.target.value,
                defaultModel: '',
                defaultAccountId: '',
              })
            }
          >
            {providerUnavailable && defaults.defaultAdapterId && (
              <option value={defaults.defaultAdapterId} disabled>
                {configuredAdapter?.label ?? defaults.defaultAdapterId} (indisponível)
              </option>
            )}
            {capableAdapters.map((adapter) => (
              <option key={adapter.id} value={adapter.id}>
                {adapter.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          Modelo
          <select
            className="settings-input"
            aria-label="Modelo do orquestrador"
            value={defaults.defaultModel}
            disabled={disabled || !selectedAdapter}
            onChange={(event) => void save({ defaultModel: event.target.value })}
          >
            <option value="">
              Padrão do provider
              {selectedAdapter?.models.default
                ? ` (${selectedAdapter.models.default})`
                : ''}
            </option>
            {missingModel && (
              <option value={defaults.defaultModel} disabled>
                {defaults.defaultModel} (indisponível)
              </option>
            )}
            {selectedAdapter?.models.list.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          Conta
          <select
            className="settings-input"
            aria-label="Conta do orquestrador"
            value={defaults.defaultAccountId}
            disabled={disabled || !selectedAdapter}
            onChange={(event) =>
              void save({ defaultAccountId: event.target.value })
            }
          >
            <option value="">Conta ativa do provider</option>
            {missingAccount && (
              <option value={defaults.defaultAccountId} disabled>
                Conta removida: usar a ativa
              </option>
            )}
            {providerAccounts.map((account) => {
              const unavailable = account.onCooldown || !account.hasCredential;
              return (
                <option key={account.id} value={account.id} disabled={unavailable}>
                  {account.label}
                  {account.onCooldown
                    ? ' (cooldown)'
                    : !account.hasCredential
                      ? ' (sem credencial)'
                      : ''}
                </option>
              );
            })}
          </select>
        </label>
      </div>

      <p className="settings-field__note">
        Aplicado ao próximo squad. O modelo da receita tem prioridade quando usa
        o mesmo provider.
      </p>
    </div>
  );
}
