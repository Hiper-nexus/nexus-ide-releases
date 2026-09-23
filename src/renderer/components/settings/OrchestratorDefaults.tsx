import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountInfo } from "../../../shared/account-types";
import type { ProviderSettingsInfo } from "../../../shared/provider-settings-types";
import type { OrchSettings } from "../../../shared/settings-types";
import type { AdapterInfo } from "../../../shared/types";
import { isVerifiedOrchestratorAdapter } from "../../orch/orchestrator-runtime";
import { isAdapterModelAuthenticated } from "../../orch/mission-runtime-readiness";
import { ProviderLogo } from "../ProviderLogo";
import { ModelPicker } from "../model/ModelPicker";
import { rankModelOptions } from "../../lib/model-picker-rank";
import { shortWindowsLine } from "../../lib/quota-display";
import { useQuotaStore } from "../../state/quota-store";

type OrchestratorDefaultsValue = Pick<
  OrchSettings,
  | "defaultAdapterId"
  | "defaultModel"
  | "defaultAccountId"
  | "squadCliPolicy"
  | "aiGatewayBaseUrl"
>;

const INITIAL_DEFAULTS: OrchestratorDefaultsValue = {
  defaultAdapterId: "claude",
  defaultModel: "",
  defaultAccountId: "",
  squadCliPolicy: "operator-choice",
  aiGatewayBaseUrl: "",
};

/** Mesmo predicado do schema em settings-types: vazio desliga, senão http(s). */
function isGatewayUrlAcceptable(value: string): boolean {
  if (value.trim() === "") return true;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const SQUAD_CLI_POLICY_LABELS: Record<OrchSettings["squadCliPolicy"], string> =
  {
    "operator-choice": "Autopiloto — qualquer CLI autenticada + rede (padrão)",
    governed: "Hardened — sandbox e CLIs qualificadas (opt-in)",
  };

function selectDefaults(settings: OrchSettings): OrchestratorDefaultsValue {
  return {
    defaultAdapterId: settings.defaultAdapterId || "claude",
    defaultModel: settings.defaultModel,
    defaultAccountId: settings.defaultAccountId,
    squadCliPolicy: settings.squadCliPolicy ?? "operator-choice",
    aiGatewayBaseUrl: settings.aiGatewayBaseUrl ?? "",
  };
}

function modelLabel(adapterId: string, model: string): string {
  if (
    adapterId === "claude" &&
    (model === "claude-opus-5-5" || model === "anthropic/claude-opus-5-5")
  ) {
    return `Claude Opus 5.5 · ${model}`;
  }
  if (
    adapterId === "claude" &&
    (model === "claude-opus-5" || model === "anthropic/claude-opus-5")
  ) {
    return `Claude Opus 5 · ${model}`;
  }
  if (
    adapterId === "codex" &&
    (model === "gpt-6-sol" || model === "openai/gpt-6-sol")
  ) {
    return `GPT-6 Sol · ${model}`;
  }
  if (
    adapterId === "codex" &&
    (model === "gpt-6-luna" || model === "openai/gpt-6-luna")
  ) {
    return `GPT-6 Luna · ${model}`;
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
  // Campo de texto tem rascunho local: salvar a cada tecla mandaria URL pela
  // metade para o schema e o valor voltaria sozinho no meio da digitação.
  const [gatewayDraft, setGatewayDraft] = useState("");

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

  // O valor autoritativo é o que voltou do main: sincroniza o rascunho no load
  // e quando um save falha e reverte, sem atrapalhar a digitação (o valor só
  // muda fora do input).
  useEffect(() => {
    setGatewayDraft(defaults.aiGatewayBaseUrl);
  }, [defaults.aiGatewayBaseUrl]);

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
  // Padrão efetivo do provider: escolher exatamente ele salva "" (seguir o
  // provider), preservando a semântica antiga do "Padrão do provider".
  const effectiveProviderDefault =
    configuredProvider?.defaultModel ||
    selectedAdapter?.models.default ||
    "";
  const quotaEntries = useQuotaStore((s) => s.snapshot.entries);
  const pickerOptions = useMemo(
    () => rankModelOptions({ adapters: capableAdapters, providers, quotaEntries }),
    [capableAdapters, providers, quotaEntries],
  );
  const quotaLineByAdapterId = useMemo(() => {
    const lines: Record<string, string> = {};
    for (const entry of quotaEntries) {
      if (lines[entry.adapterId] === undefined) {
        lines[entry.adapterId] = shortWindowsLine(entry);
      }
    }
    return lines;
  }, [quotaEntries]);
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

  const commitGateway = async () => {
    const next = gatewayDraft.trim();
    if (next === defaults.aiGatewayBaseUrl) return;
    if (!isGatewayUrlAcceptable(next)) {
      setGatewayDraft(defaults.aiGatewayBaseUrl);
      setError(
        "Gateway de IA: informe uma URL http(s) — ex.: http://127.0.0.1:20128/v1",
      );
      return;
    }
    await save({ aiGatewayBaseUrl: next });
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
            <h3 className="settings-orchestrator__title">Piloto automático</h3>
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
      {/* Modelo sumido é aviso próprio: desde que login deixou de ser
          pré-condição de missão, a CLI instalada conta como autenticada e este
          bloco inteiro sumia — o chip dizia "modelo indisponível" e nada
          explicava o que fazer. */}
      {!providerUnavailable && missingModel && (
        <p className="settings-orchestrator__warning" role="status">
          O modelo salvo não está mais disponível. Escolha outro modelo antes de
          iniciar.
        </p>
      )}
      {!providerUnavailable && !missingModel && !runtimeAuthenticated && (
        <p className="settings-orchestrator__warning" role="status">
          Autentique a sessão ou escolha uma conta válida para o modelo
          selecionado. O Nexus revalida tudo novamente antes do spawn.
        </p>
      )}

      <div className="settings-field">
        <span className="settings-field__label" id="orchestrator-model-label">
          Ferramenta e modelo
        </span>
        {providerUnavailable && configuredAdapter && (
          <p
            className="settings-orchestrator__saved-unavailable"
            role="status"
          >
            Salvo: {configuredAdapter.label} (indisponível) — escolha um
            Maestro verificado abaixo.
          </p>
        )}
        {!providerUnavailable && missingModel && (
          <p
            className="settings-orchestrator__saved-unavailable"
            role="status"
          >
            Salvo: {defaults.defaultModel} (indisponível) — escolha outro
            modelo abaixo.
          </p>
        )}
        <details className="settings-advanced-field settings-orchestrator__model-choice">
          <summary>
            {selectedAdapter && selectedModel
              ? `${selectedAdapter.label} · ${modelLabel(selectedAdapter.id, selectedModel)}`
              : 'Escolher ferramenta e modelo'}
          </summary>
        <ModelPicker
          options={pickerOptions}
          quotaLineByAdapterId={quotaLineByAdapterId}
          selected={
            selectedAdapter && selectedModel
              ? {
                  adapterId: defaults.defaultAdapterId,
                  model: selectedModel,
                }
              : null
          }
          formatModelName={modelLabel}
          onSelect={(option) => {
            if (disabled) return;
            if (option.adapterId !== defaults.defaultAdapterId) {
              void save({
                defaultAdapterId: option.adapterId,
                defaultModel: "",
                defaultAccountId: "",
              });
              return;
            }
            void save({
              defaultModel:
                option.model === effectiveProviderDefault
                  ? ""
                  : option.model,
            });
          }}
        />
        </details>
        {defaults.defaultModel === "" && effectiveProviderDefault && (
          <p className="settings-field__note">
            Seguindo o padrão do provider ({effectiveProviderDefault}).
          </p>
        )}
      </div>

      <div className="settings-orchestrator__grid">
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
              const unavailable =
                account.onCooldown ||
                !account.hasCredential ||
                account.needsRelogin;
              return (
                <option
                  key={account.id}
                  value={account.id}
                  disabled={unavailable}
                >
                  {account.label}
                  {account.needsRelogin
                    ? " (sessão expirada)"
                    : account.onCooldown
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

      <details className="settings-advanced-field"><summary>Permissões de execução e conexão avançada</summary>
      <div className="settings-orchestrator__grid">
        <label className="settings-field">
          Liberdade de CLI no Squad
          <select
            className="settings-input"
            aria-label="Política de CLI no Squad"
            value={defaults.squadCliPolicy}
            disabled={disabled}
            onChange={(event) =>
              void save({
                squadCliPolicy: event.target
                  .value as OrchSettings["squadCliPolicy"],
              })
            }
          >
            {(
              Object.keys(SQUAD_CLI_POLICY_LABELS) as Array<
                OrchSettings["squadCliPolicy"]
              >
            ).map((mode) => (
              <option key={mode} value={mode}>
                {SQUAD_CLI_POLICY_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="settings-field__note">
        Padrão: autopiloto — monta o squad com qualquer CLI autenticada, mantém
        autoaprovação e acesso de rede, trabalha em worktree isolado e só o
        Nexus faz o merge validado. Sem Seatbelt no pane e sem atestação crypto
        no handoff. Hardened (opt-in) adiciona sandbox de processo, ladder
        estreita de CLIs e atestação se você reativar o gate.
      </p>

      <div className="settings-orchestrator__grid">
        <label className="settings-field">
          Gateway de IA local
          <input
            className="settings-input"
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder="desligado — ex.: http://127.0.0.1:20128/v1"
            aria-label="Base URL do gateway de IA local"
            value={gatewayDraft}
            disabled={disabled}
            onChange={(event) => setGatewayDraft(event.target.value)}
            onBlur={() => void commitGateway()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitGateway();
              }
              if (event.key === "Escape") {
                setGatewayDraft(defaults.aiGatewayBaseUrl);
              }
            }}
          />
        </label>
      </div>
      <p className="settings-field__note">
        Vazio desliga. Quando preenchido, as CLIs que declaram{" "}
        <code>ANTHROPIC_BASE_URL</code>/<code>OPENAI_BASE_URL</code> (Claude,
        Codex, Aider, OpenCode) passam a falar com o gateway, que troca de
        provider por baixo. Planos com endpoint próprio — GLM e LongCat —
        continuam intocados. Sem <code>NEXUS_AI_GATEWAY_API_KEY</code>, a
        credencial do provider é enviada ao gateway.
      </p>
      </details>
    </div>
  );
}
