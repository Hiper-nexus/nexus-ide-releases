import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountInfo } from "../../../shared/account-types";
import type { ProviderSettingsInfo } from "../../../shared/provider-settings-types";
import type { OrchSettings } from "../../../shared/settings-types";
import type { AdapterInfo } from "../../../shared/types";
import { isVerifiedOrchestratorAdapter } from "../../orch/orchestrator-runtime";
import { isAdapterModelAuthenticated } from "../../orch/mission-runtime-readiness";
import { ProviderLogo } from "../ProviderLogo";

type OrchestratorDefaultsValue = Pick<
  OrchSettings,
  | "defaultAdapterId"
  | "defaultModel"
  | "defaultAccountId"
  | "ompParticipation"
  | "ompRpcAutoStart"
  | "ompMissionTransport"
  | "ompAutoSpawn"
>;

const INITIAL_DEFAULTS: OrchestratorDefaultsValue = {
  defaultAdapterId: "claude",
  defaultModel: "",
  defaultAccountId: "",
  ompParticipation: "prefer",
  ompRpcAutoStart: true,
  ompMissionTransport: "auto",
  ompAutoSpawn: true,
};

const OMP_PARTICIPATION_LABELS: Record<
  OrchSettings["ompParticipation"],
  string
> = {
  off: "Desligado — só spawn manual",
  fallback: "Fallback — companion fora do guided",
  diversity: "Diversidade — companion fora do guided",
  prefer: "Preferir — companion fora do guided quando elegível",
};

function selectDefaults(settings: OrchSettings): OrchestratorDefaultsValue {
  return {
    defaultAdapterId: settings.defaultAdapterId || "claude",
    defaultModel: settings.defaultModel,
    defaultAccountId: settings.defaultAccountId,
    ompParticipation: settings.ompParticipation ?? "prefer",
    ompRpcAutoStart: settings.ompRpcAutoStart !== false,
    ompMissionTransport: settings.ompMissionTransport ?? "auto",
    ompAutoSpawn: settings.ompAutoSpawn !== false,
  };
}

function modelLabel(adapterId: string, model: string): string {
  if (
    (adapterId === "claude" || adapterId === "omp") &&
    (model === "claude-opus-5" || model === "anthropic/claude-opus-5")
  ) {
    return `Claude Opus 5 · ${model}`;
  }
  return model;
}

export function OrchestratorDefaults() {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [providers, setProviders] = useState<ProviderSettingsInfo[]>([]);
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
    const stopProviders = window.nexus.providers.onChanged((next) => {
      if (!cancelled) setProviders(next);
    });
    const load = async () => {
      const [orch, adapterList, providerList, accountList] = await Promise.all([
        window.nexus.settings.orchGet(),
        window.nexus.adapters.list(),
        window.nexus.providers.list(),
        window.nexus.accounts.list(),
      ]);
      if (cancelled) return;
      setDefaults(selectDefaults(orch));
      setAdapters(adapterList);
      setProviders(providerList);
      setAccounts(accountList);
      setLoading(false);
    };
    void load().catch((cause) => {
      if (cancelled) return;
      setLoading(false);
      setError(
        cause instanceof Error ? cause.message : "Falha ao carregar padrões.",
      );
    });
    return () => {
      cancelled = true;
      stopAdapters();
      stopProviders();
      stopAccounts();
    };
  }, []);

  const capableAdapters = useMemo(
    () =>
      adapters.filter(
        (adapter) =>
          isVerifiedOrchestratorAdapter(adapter) &&
          providers.find((provider) => provider.adapterId === adapter.id)
            ?.enabled === true,
      ),
    [adapters, providers],
  );
  const selectedAdapter = capableAdapters.find(
    (adapter) => adapter.id === defaults.defaultAdapterId,
  );
  const configuredAdapter = adapters.find(
    (adapter) => adapter.id === defaults.defaultAdapterId,
  );
  const configuredProvider = providers.find(
    (provider) => provider.adapterId === defaults.defaultAdapterId,
  );
  const providerUnavailable = !loading && !selectedAdapter;
  const providerAccounts = accounts.filter(
    (account) => account.adapterId === defaults.defaultAdapterId,
  );
  const availableModels =
    configuredProvider?.models ?? selectedAdapter?.models.list ?? [];
  const selectedModel =
    defaults.defaultModel ||
    configuredProvider?.defaultModel ||
    selectedAdapter?.models.default ||
    "";
  const runtimeAuthenticated = selectedAdapter
    ? isAdapterModelAuthenticated(
        selectedAdapter,
        providers,
        selectedModel,
        accounts,
        defaults.defaultAccountId,
      )
    : false;
  const missingModel = Boolean(
    defaults.defaultModel &&
      !availableModels.includes(defaults.defaultModel),
  );
  const missingAccount =
    defaults.defaultAccountId &&
    !providerAccounts.some(
      (account) => account.id === defaults.defaultAccountId,
    );

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
        cause instanceof Error ? cause.message : "Falha ao salvar os padrões.",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const disabled = loading || saving;
  const statusLabel = loading
    ? "Carregando"
    : selectedAdapter
      ? missingModel
        ? `${selectedAdapter.label} · modelo indisponível`
        : runtimeAuthenticated
          ? `${selectedAdapter.label} · pronto`
          : `${selectedAdapter.label} · login necessário`
      : configuredAdapter
        ? configuredProvider?.enabled === false
          ? `${configuredAdapter.label} · provider desabilitado`
          : `${configuredAdapter.label} · Maestro não verificado`
        : "Provider indisponível";
  const visibleAdapter = selectedAdapter ?? configuredAdapter;

  return (
    <div className="settings-orchestrator" aria-busy={loading || saving}>
      <div className="settings-orchestrator__head">
        <div className="settings-orchestrator__provider">
          {visibleAdapter && (
            <ProviderLogo
              adapterId={visibleAdapter.id}
              label={visibleAdapter.label}
              fallback={visibleAdapter.icon}
              size="sm"
            />
          )}
          <div>
            <h4 className="settings-orchestrator__title">Piloto automático</h4>
            <p className="settings-orchestrator__summary">
              Escolha quem coordena as missões, com qual modelo e conta.
            </p>
          </div>
        </div>
        <span
          className={`settings-chip ${providerUnavailable || !runtimeAuthenticated ? "settings-chip--warn" : "settings-chip--ok"}`}
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
          {configuredAdapter?.installed
            ? configuredProvider?.enabled === false
              ? `${configuredAdapter.label} está desabilitado. Habilite o provider ou escolha outro Maestro verificado.`
              : `${configuredAdapter.label} não concluiu o gate Nexus de Maestro. Escolha Claude ou Codex quando estiverem instalados.`
            : "Instale ou escolha um Maestro verificado para iniciar novos squads."}
        </p>
      )}
      {!providerUnavailable && !runtimeAuthenticated && (
        <p className="settings-orchestrator__warning" role="status">
          {missingModel
            ? "O modelo salvo não está mais disponível. Escolha outro modelo antes de iniciar."
            : "Autentique a sessão ou escolha uma conta válida para o modelo selecionado. O Nexus revalida tudo novamente antes do spawn."}
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
                defaultModel: "",
                defaultAccountId: "",
              })
            }
          >
            {providerUnavailable && defaults.defaultAdapterId && (
              <option value={defaults.defaultAdapterId} disabled>
                {configuredAdapter?.label ?? defaults.defaultAdapterId}{" "}
                (indisponível)
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
            onChange={(event) =>
              void save({ defaultModel: event.target.value })
            }
          >
            <option value="">
              Padrão do provider
              {configuredProvider?.defaultModel || selectedAdapter?.models.default
                ? ` (${configuredProvider?.defaultModel || selectedAdapter?.models.default})`
                : ""}
            </option>
            {missingModel && (
              <option value={defaults.defaultModel} disabled>
                {defaults.defaultModel} (indisponível)
              </option>
            )}
            {availableModels.map((model) => (
              <option key={model} value={model}>
                {modelLabel(defaults.defaultAdapterId, model)}
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
                <option
                  key={account.id}
                  value={account.id}
                  disabled={unavailable}
                >
                  {account.label}
                  {account.onCooldown
                    ? " (cooldown)"
                    : !account.hasCredential
                      ? " (sem credencial)"
                      : ""}
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

      <div className="settings-orchestrator__grid settings-orchestrator__grid--omp">
        <label className="settings-field">
          Oh My Pi (omp) na frota
          <select
            className="settings-input"
            aria-label="Participação do Oh My Pi no roteamento"
            value={defaults.ompParticipation}
            disabled={disabled}
            onChange={(event) =>
              void save({
                ompParticipation: event.target
                  .value as OrchSettings["ompParticipation"],
              })
            }
          >
            {(
              Object.keys(OMP_PARTICIPATION_LABELS) as Array<
                OrchSettings["ompParticipation"]
              >
            ).map((mode) => (
              <option key={mode} value={mode}>
                {OMP_PARTICIPATION_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          Auto-iniciar OMP RPC
          <select
            className="settings-input"
            aria-label="Auto-iniciar OMP RPC ao abrir o painel"
            value={defaults.ompRpcAutoStart ? "on" : "off"}
            disabled={disabled}
            onChange={(event) =>
              void save({ ompRpcAutoStart: event.target.value === "on" })
            }
          >
            <option value="on">Sim — inicia ao abrir o painel</option>
            <option value="off">Não — botão manual</option>
          </select>
        </label>

        <label className="settings-field">
          Transporte omp em missões
          <select
            className="settings-input"
            aria-label="Transporte Oh My Pi em missões"
            value={defaults.ompMissionTransport}
            disabled={disabled}
            onChange={(event) =>
              void save({
                ompMissionTransport: event.target
                  .value as OrchSettings["ompMissionTransport"],
              })
            }
          >
            <option value="auto">Auto — rpc-ui com fallback PTY</option>
            <option value="rpc">RPC só — omp --mode rpc-ui</option>
            <option value="pty">PTY — terminal com MCP completo</option>
          </select>
        </label>

        <label className="settings-field">
          Auto-spawn Oh My Pi
          <select
            className="settings-input"
            aria-label="Auto-spawn Oh My Pi em missões"
            value={defaults.ompAutoSpawn ? "on" : "off"}
            disabled={disabled}
            onChange={(event) =>
              void save({ ompAutoSpawn: event.target.value === "on" })
            }
          >
            <option value="on">
              Sim — companion fora do guided, quando elegível
            </option>
            <option value="off">Não — só via router/roster</option>
          </select>
        </label>
      </div>
      <p className="settings-field__note">
        Estas opções controlam o painel e rotas legadas ou manuais. O OMP não
        entra no guided automático nesta versão: não é Maestro verificado nem
        worker/advisor com confinamento mecânico. O handoff RPC físico, sozinho,
        não concede essa capability.
      </p>
    </div>
  );
}
