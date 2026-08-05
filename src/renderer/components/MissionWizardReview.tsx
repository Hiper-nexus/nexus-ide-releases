import { useEffect, useState } from "react";
import type { AccountInfo } from "../../shared/account-types";
import type { AdapterInfo } from "../../shared/types";
import type { Squad, SquadAgent } from "../../shared/orch-types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import {
  adapterCapabilityMatrixOf,
  type AdapterCapabilityMatrix,
} from "../../shared/adapter-types";
import { supportsAdvisoryParticipationCli } from "../../shared/mission-advisory";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";
import { defaultSquadModelForAdapter } from "../../shared/squad-model-defaults";
import type { SquadCliPolicy } from "../../shared/settings-types";
import { isAdapterModelAuthenticated } from "../orch/mission-runtime-readiness";
import { AgentAvatar } from "./AgentAvatar";
import { deriveMissionWizardRoundtableState } from "./mission-wizard-roundtable";
import { ProviderLogo } from "./ProviderLogo";
import { ModelMetaBadge } from "./model/ModelMetaBadge";

/**
 * Etapa REVISAR do Mission Wizard — roster editável (CLI/modelo/effort +
 * allowlists de tools/skills por agente). Extraída do MissionWizard para
 * manter os módulos abaixo do teto de 800 linhas; todo o estado continua no
 * wizard pai e chega por props (componente 100% apresentacional).
 */

interface MissionWizardReviewProps {
  squad: Squad;
  roster: SquadAgent[];
  adapters: AdapterInfo[];
  providers?: ProviderSettingsInfo[];
  accounts?: AccountInfo[];
  /** Beginner path: summarize the team and disclose CLI/tool tuning on demand. */
  guided?: boolean;
  /** Current goal, used only to explain the topology already selected by Main. */
  missionGoal?: string;
  /** Exact next decision; prevents a PRD shortcut from promising approval too early. */
  launchLabel?: string;
  highlightedAgentId: string | null;
  error: string | null;
  spawning: boolean;
  rosterSaved: boolean;
  rosterInvalidAgent: SquadAgent | null;
  onSaveRoster(): void | Promise<void>;
  onUpdateAgent(id: string, patch: Partial<SquadAgent>): void;
  /** Add a worker/reviewer/scout with a free CLI pick — not locked to the design default. */
  onAddAgent?(
    category: Extract<
      SquadAgent["category"],
      "executor" | "reviewer" | "scout"
    >,
  ): void;
  /** Remove a non-orchestrator agent from the mission roster. */
  onRemoveAgent?(id: string): void;
  onSelectOrchestratorAdapter?(adapterId: string): void;
  onError(message: string): void;
  onBack(): void;
  onCancel(): void;
  onLaunch(): void;
  /** Test/override seam; production loads from orch.squadCliPolicy. */
  squadCliPolicy?: SquadCliPolicy;
}

function specValue(
  list: string[] | null | undefined,
  isOrchestrator = false,
): string {
  if (list == null) return isOrchestrator ? "*" : "vazio/bloqueado";
  return list.join(", ");
}

function parseSpecList(
  value: string,
  allowUnrestricted: boolean,
): string[] | null {
  const clean = value.trim();
  if (clean === "*") return allowUnrestricted ? null : [];
  if (!clean) return [];
  return clean
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function modelLabel(adapterId: string, model: string): string {
  if (
    adapterId === "claude" &&
    (model === "claude-opus-5" || model === "anthropic/claude-opus-5")
  ) {
    return `Claude Opus 5 · ${model}`;
  }
  return model;
}

function workerCapabilityLabel(
  capabilities: AdapterCapabilityMatrix,
  adapterId: string,
  agentCategory: SquadAgent["category"],
  orchestratorCli: string | undefined,
  options: {
    readonly operatorChoice: boolean;
    readonly authenticated: boolean;
    readonly selectable: boolean;
  },
): string {
  // Autopilot: brand is not the gate. NEVER reuse governedWriter /
  // autonomousReadOnly / advisory labels ("escrita confinada", "leitura
  // supervisionada", "somente manual") — those are the release ladder, not
  // the default truth. Authentication and a live adapter route are enough.
  if (options.operatorChoice) {
    if (!options.authenticated) return "login necessário";
    if (!capabilities.launchable || !options.selectable) return "indisponível";
    return "pronta · web";
  }
  if (capabilities.governedWriter) return "escrita confinada";
  if (capabilities.autonomousReadOnly) return "leitura supervisionada";
  if (
    (agentCategory === "reviewer" || agentCategory === "scout") &&
    supportsAdvisoryParticipationCli(adapterId) &&
    (adapterId !== "claude" || orchestratorCli !== "claude")
  ) {
    return "leitura advisory MCP";
  }
  if (capabilities.launchable) return "somente manual";
  return "indisponível";
}

export function MissionWizardReview({
  squad,
  roster,
  adapters,
  providers = [],
  accounts = [],
  guided = false,
  missionGoal = "",
  launchLabel,
  highlightedAgentId,
  error,
  spawning,
  rosterSaved,
  rosterInvalidAgent,
  onSaveRoster,
  onUpdateAgent,
  onAddAgent,
  onRemoveAgent,
  onSelectOrchestratorAdapter,
  onError,
  onBack,
  onCancel,
  onLaunch,
  squadCliPolicy: squadCliPolicyProp,
}: MissionWizardReviewProps) {
  const [squadCliPolicyState, setSquadCliPolicyState] =
    useState<SquadCliPolicy>("operator-choice");
  // Personalização começa aberta (operador precisa ver CLIs), mas permanece
  // colapsável — `open` fixo impedia fechar o painel.
  const [rosterPanelOpen, setRosterPanelOpen] = useState(true);
  useEffect(() => {
    if (squadCliPolicyProp) return;
    let cancelled = false;
    void window.nexus.settings
      ?.orchGet?.()
      .then((orch) => {
        if (!cancelled) {
          setSquadCliPolicyState(orch.squadCliPolicy ?? "operator-choice");
        }
      })
      .catch(() => {
        // Keep operator-choice default if settings are unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [squadCliPolicyProp]);
  const squadCliPolicy = squadCliPolicyProp ?? squadCliPolicyState;
  const operatorChoice = isOperatorChoicePolicy(squadCliPolicy);
  const roundtable = deriveMissionWizardRoundtableState({
    guided,
    missionGoal,
    squad,
    roster,
  });
  const orchestratorAgent =
    roster.find((agent) => agent.category === "orchestrator") ?? null;
  const orchestratorAdapter = adapters.find(
    (adapter) => adapter.id === orchestratorAgent?.cli,
  );
  const selectableOrchestratorAdapters = adapters.filter(
    (adapter) => {
      const capabilities = adapterCapabilityMatrixOf(adapter);
      return (
        adapter.installed &&
        adapter.kind === "cli-pty" &&
        capabilities.launchable &&
        capabilities.promptInjectable &&
        capabilities.statusObservable &&
        (!operatorChoice || adapter.missionControlCapable === true) &&
        (operatorChoice || capabilities.verifiedMaestro) &&
        providers.find((provider) => provider.adapterId === adapter.id)
          ?.enabled !== false &&
        isAdapterModelAuthenticated(
          adapter,
          providers,
          undefined,
          accounts,
        )
      );
    },
  );
  const workerAdapterCandidates = adapters.filter((adapter) => {
    const capabilities = adapterCapabilityMatrixOf(adapter);
    return (
      (adapter.id !== "claude" || orchestratorAgent?.cli !== "claude") &&
      adapter.kind === "cli-pty" &&
      adapter.installed &&
      capabilities.launchable &&
      providers.find((provider) => provider.adapterId === adapter.id)
        ?.enabled !== false
    );
  });
  const orchestratorModelAuthenticated = orchestratorAdapter
    ? isAdapterModelAuthenticated(
        orchestratorAdapter,
        providers,
        orchestratorAgent?.model,
        accounts,
      )
    : false;
  const workerAdapterQualified = (
    agent: Pick<SquadAgent, "category" | "model">,
    adapter: AdapterInfo | undefined,
    model = agent.model,
  ): boolean => {
    if (!adapter) return false;
    const capabilities = adapterCapabilityMatrixOf(adapter);
    const isAdvisorRole = roundtable.isAdvisorRole(agent.category);
    const advisoryLane =
      isAdvisorRole &&
      supportsAdvisoryParticipationCli(adapter.id) &&
      (adapter.id !== "claude" || orchestratorAgent?.cli !== "claude");
    // Autopilot: any installed + authenticated cli-pty may take any worker
    // role. Governed keeps the hardened release ladder.
    const roleQualified = operatorChoice
      ? adapter.installed &&
        capabilities.launchable &&
        adapter.taskHandoffCapable === true
      : isAdvisorRole
        ? Boolean(
            capabilities.governedWriter ||
              capabilities.autonomousReadOnly ||
              advisoryLane,
          )
        : Boolean(capabilities.governedWriter);
    const routeReady = operatorChoice
      ? capabilities.launchable
      : capabilities.launchable &&
        capabilities.promptInjectable &&
        capabilities.statusObservable;
    return Boolean(
      (adapter.id !== "claude" ||
        orchestratorAgent?.cli !== "claude") &&
        adapter.kind === "cli-pty" &&
        adapter.installed &&
        routeReady &&
        roleQualified &&
        isAdapterModelAuthenticated(
          adapter,
          providers,
          model,
          accounts,
        ),
    );
  };
  const workerAgentQualified = (agent: SquadAgent): boolean =>
    workerAdapterQualified(
      agent,
      adapters.find((candidate) => candidate.id === agent.cli),
    );
  const unqualifiedWorker =
    roster.find(
      (agent) =>
        agent.category !== "orchestrator" && !workerAgentQualified(agent),
    ) ?? null;
  const workerBlockedReason = unqualifiedWorker
    ? (() => {
        const adapter = adapters.find(
          (candidate) => candidate.id === unqualifiedWorker.cli,
        );
        const label = adapter?.label ?? unqualifiedWorker.cli;
        const capabilities = adapterCapabilityMatrixOf(adapter);
        const isAdvisorRole = roundtable.isAdvisorRole(unqualifiedWorker.category);
        const advisoryLane =
          isAdvisorRole &&
          supportsAdvisoryParticipationCli(unqualifiedWorker.cli) &&
          (unqualifiedWorker.cli !== "claude" ||
            orchestratorAgent?.cli !== "claude");
        const roleCapable = operatorChoice
          ? Boolean(adapter?.installed)
          : isAdvisorRole
            ? Boolean(
                capabilities.governedWriter ||
                  capabilities.autonomousReadOnly ||
                  advisoryLane,
              )
            : Boolean(capabilities.governedWriter);
        const authenticated = adapter
          ? isAdapterModelAuthenticated(
              adapter,
              providers,
              unqualifiedWorker.model,
              accounts,
            )
          : false;
        // Auth failure on a role-capable CLI must never look like "sem
        // qualificação nesta release" — that message cost hours of wrong
        // diagnosis (Claude advisor with autonomousReadOnly + login-needed).
        if (
          adapter &&
          capabilities.launchable &&
          roleCapable &&
          !authenticated
        ) {
          return isAdvisorRole
            ? `${label} precisa de autenticação válida para executar o worker ${unqualifiedWorker.agentName} como advisor read_only nesta release.`
            : `${label} precisa de autenticação válida para executar o worker ${unqualifiedWorker.agentName} automaticamente nesta release.`;
        }
        if (operatorChoice) {
          return `${label} precisa estar instalada, autenticada e pronta para lançar o worker ${unqualifiedWorker.agentName}. ${roundtable.workerLaunchContext}`;
        }
        if (
          capabilities.launchable &&
          !capabilities.autonomousReadOnly &&
          !capabilities.governedWriter &&
          !advisoryLane
        ) {
          return `${label} está disponível para uso manual no Terminal, mas não pode executar o worker ${unqualifiedWorker.agentName} automaticamente nesta release.`;
        }
        if (isAdvisorRole) {
          return `O worker ${unqualifiedWorker.agentName} precisa de leitura autônoma confinada e autenticada. ${label} não possui essa qualificação nesta release.`;
        }
        return `O worker ${unqualifiedWorker.agentName} precisa de escrita autônoma confinada e autenticada. ${label} não possui essa qualificação nesta release.`;
      })()
    : null;
  const orchestratorRouteDeclared = Boolean(
    selectableOrchestratorAdapters.some(
      (adapter) => adapter.id === orchestratorAgent?.cli,
    ) && orchestratorModelAuthenticated,
  );
  const orchestratorProofEvidence = orchestratorRouteDeclared
    ? "verified"
    : "unsupported";
  const orchestratorManualOnly = Boolean(
    orchestratorAdapter &&
      adapterCapabilityMatrixOf(orchestratorAdapter).launchable &&
      !adapterCapabilityMatrixOf(orchestratorAdapter).verifiedMaestro &&
      !operatorChoice,
  );
  const orchestratorBlockedReason = !orchestratorAgent
    ? "O squad não tem Maestro."
    : !orchestratorAgent.cli
      ? operatorChoice
        ? "Nenhum Maestro autenticado está disponível. Escolha um provider abaixo."
        : "Nenhum Maestro verificado está disponível automaticamente. Escolha um provider abaixo."
      : !orchestratorAdapter
        ? `O provider ${orchestratorAgent.cli} não foi carregado. Escolha outro em Configurações › Squads.`
        : !operatorChoice &&
            !adapterCapabilityMatrixOf(orchestratorAdapter).verifiedMaestro
          ? `${orchestratorAdapter.label} está disponível no Terminal, mas não concluiu o gate de Maestro desta release. Escolha um Maestro verificado ou ative Escolha livre em Configurações › Orquestração.`
          : !orchestratorModelAuthenticated
            ? `${orchestratorAdapter.label} precisa de autenticação válida para o modelo selecionado.`
            : !orchestratorRouteDeclared
              ? `${orchestratorAdapter.label} não está disponível para coordenar squads. Escolha outro em Configurações › Squads.`
              : null;
  const [savingRoster, setSavingRoster] = useState(false);
  const [saveAnnouncement, setSaveAnnouncement] = useState("");

  useEffect(() => {
    if (rosterSaved) setSaveAnnouncement("Configuração salva.");
  }, [rosterSaved]);

  async function handleSaveRoster() {
    if (savingRoster) return;
    setSavingRoster(true);
    setSaveAnnouncement("");
    try {
      await onSaveRoster();
    } finally {
      setSavingRoster(false);
    }
  }

  return (
    <div className="wizard__section">
      <div
        className={`wizard__review-intro${
          guided ? " wizard__review-intro--guided" : ""
        }`}
      >
        <div>
          <p className="wizard__label">
            {guided ? "Equipe preparada" : squad.name}
          </p>
          {guided && <p className="wizard__review-summary">{roundtable.guidedSummary}</p>}
        </div>
        {guided && (
          <span
            className={`wizard__review-proof wizard__review-proof--${orchestratorProofEvidence}`}
          >
            {orchestratorProofEvidence === "verified"
              ? "Coordenação verificada"
              : "Coordenação não pronta"}
          </span>
        )}
      </div>
      {orchestratorManualOnly && (
        <div className="wizard__route-notice" role="note">
          <div>
            <strong>Disponível somente no Terminal</strong>
            <p>
              {orchestratorAdapter?.label} pode ser aberto manualmente, mas não
              concluiu o gate de Maestro nem recebe escrita autônoma nesta
              release.
            </p>
          </div>
        </div>
      )}
      {orchestratorBlockedReason && !orchestratorManualOnly && (
        <p className="wizard__error" role="alert">
          {orchestratorBlockedReason}
        </p>
      )}
      <details
        className="wizard__advanced-roster"
        open={rosterPanelOpen}
        onToggle={(event) => {
          setRosterPanelOpen(
            (event.currentTarget as HTMLDetailsElement).open,
          );
        }}
      >
        <summary>
          <span>
            {guided
              ? "Personalizar equipe (CLIs e papéis)"
              : "Configuração da equipe"}
          </span>
          <span className="wizard__advanced-roster-meta">
            {roster.length} {roster.length === 1 ? "função" : "funções"} ·
            quantos e quais CLIs você quiser
          </span>
        </summary>
        <div className="wizard__advanced-roster-body">
          <div className="wizard__review-head">
            <p className="wizard__label">Equipe editável</p>
            <button
              className="wizard__btn"
              onClick={() => void handleSaveRoster()}
              disabled={savingRoster || spawning}
              title="Guarda estas edições sem iniciar agentes ou consumir tokens"
            >
              {savingRoster
                ? "Salvando…"
                : rosterSaved
                  ? "Configuração salva"
                  : "Salvar configuração"}
            </button>
            <span className="wizard__sr-only" role="status" aria-live="polite">
              {saveAnnouncement}
            </span>
          </div>
          <p className="wizard__hint-sm">
            {roundtable.configurationHint(operatorChoice)} O desenho inicial é
            só um ponto de partida: troque CLI/modelo, adicione ou remova
            integrantes — o Maestro permanece um; workers e revisores são
            livres.
          </p>
          <p className="wizard__hint-sm">
            Use * só no orquestrador; workers precisam de tools explícitas ou
            vazio. Gaps explícitos: gap:nome: motivo.
          </p>
          {(onAddAgent || onRemoveAgent) && (
            <div
              className="wizard__roster-add"
              role="group"
              aria-label="Adicionar integrantes à equipe"
            >
              {onAddAgent && (
                <>
                  <button
                    type="button"
                    className="wizard__btn wizard__btn--ghost"
                    disabled={spawning || roster.length >= 12}
                    onClick={() => onAddAgent("executor")}
                  >
                    + Executor
                  </button>
                  <button
                    type="button"
                    className="wizard__btn wizard__btn--ghost"
                    disabled={spawning || roster.length >= 12}
                    onClick={() => onAddAgent("reviewer")}
                  >
                    + Revisor / QA
                  </button>
                  <button
                    type="button"
                    className="wizard__btn wizard__btn--ghost"
                    disabled={spawning || roster.length >= 12}
                    onClick={() => onAddAgent("scout")}
                  >
                    + Scout / advisor
                  </button>
                </>
              )}
            </div>
          )}
          <ul className="wizard__roster wizard__roster--edit">
            {roster.map((a) => {
              const isOrchestrator = a.category === "orchestrator";
              const cliAdapter = adapters.find((x) => x.id === a.cli);
              const models = cliAdapter?.models.list ?? [];
              const canRemove =
                !isOrchestrator &&
                Boolean(onRemoveAgent) &&
                roster.filter((row) => row.category !== "orchestrator").length >
                  1;
              return (
                <li
                  key={a.id}
                  data-agent-id={a.id}
                  className={`wizard__roster-row${a.id === highlightedAgentId ? " wizard__roster-row--invalid" : ""}`}
                >
                  <div className="wizard__agent-main">
                    <div className="wizard__agent-identity">
                      <AgentAvatar
                        category={a.category}
                        state="offline"
                        size="card"
                        label={a.agentName}
                      />
                      <span className="wizard__roster-role">{a.category}</span>
                      <span className="wizard__roster-name" title={a.agentName}>
                        {a.agentName}
                      </span>
                      {canRemove && (
                        <button
                          type="button"
                          className="wizard__btn wizard__btn--ghost wizard__roster-remove"
                          aria-label={`Remover ${a.agentName}`}
                          title="Remover desta missão"
                          disabled={spawning}
                          onClick={() => onRemoveAgent?.(a.id)}
                        >
                          Remover
                        </button>
                      )}
                    </div>
                    <div className="wizard__agent-controls">
                      <span className="wizard__provider-select">
                        <ProviderLogo
                          adapterId={a.cli}
                          label={cliAdapter?.label ?? a.cli}
                          fallback={cliAdapter?.icon}
                          size="xs"
                        />
                        {isOrchestrator ? (
                          <select
                            className="wizard__mini-select"
                            aria-label="Provider do Maestro"
                            value={a.cli}
                            onChange={(event) =>
                              onSelectOrchestratorAdapter?.(event.target.value)
                            }
                          >
                            {!a.cli && (
                              <option value="" disabled>
                                Escolha um Maestro
                              </option>
                            )}
                            {selectableOrchestratorAdapters.map((adapter) => (
                              <option key={adapter.id} value={adapter.id}>
                                {adapter.label} ·{" "}
                                {operatorChoice
                                  ? "pronta · web"
                                  : "verificado"}
                              </option>
                            ))}
                            {a.cli &&
                              !selectableOrchestratorAdapters.some(
                                (adapter) => adapter.id === a.cli,
                              ) && (
                                // Part (a): the CURRENT Maestro must stay a
                                // selectable value even when it is not in the
                                // credentialed set — a disabled current option
                                // renders a dead picker the operator cannot
                                // operate. Availability is surfaced by the
                                // label + blocked reason, not by killing the
                                // control.
                                <option value={a.cli}>
                                  {cliAdapter?.label ?? a.cli} ·{" "}
                                  {operatorChoice
                                    ? orchestratorModelAuthenticated
                                      ? "indisponível"
                                      : "login necessário"
                                    : orchestratorManualOnly
                                      ? "somente manual"
                                      : "indisponível"}
                                </option>
                              )}
                          </select>
                        ) : (
                          <select
                            className="wizard__mini-select"
                            aria-label={`Provider de ${a.agentName}`}
                            value={a.cli}
                            onChange={(e) =>
                              onUpdateAgent(a.id, {
                                cli: e.target.value,
                                model: defaultSquadModelForAdapter(
                                  e.target.value,
                                ),
                              })
                            }
                          >
                            {workerAdapterCandidates.map((x) => {
                              const candidateModel =
                                x.id === a.cli
                                  ? a.model
                                  : x.models.default;
                              const authenticated = isAdapterModelAuthenticated(
                                x,
                                providers,
                                candidateModel,
                                accounts,
                              );
                              const qualified = workerAdapterQualified(
                                a,
                                x,
                                candidateModel,
                              );
                              return (
                                <option
                                  key={x.id}
                                  value={x.id}
                                  // Part (a): never disable the option that is
                                  // already selected — the operator must always
                                  // be able to keep/re-affirm the current CLI,
                                  // even if it is not currently qualified.
                                  disabled={!qualified && x.id !== a.cli}
                                >
                                  {x.label} ·{" "}
                                  {workerCapabilityLabel(
                                    adapterCapabilityMatrixOf(x),
                                    x.id,
                                    a.category,
                                    orchestratorAgent?.cli,
                                    {
                                      operatorChoice,
                                      authenticated,
                                      selectable: qualified,
                                    },
                                  )}
                                </option>
                              );
                            })}
                            {!workerAdapterCandidates.some(
                              (x) => x.id === a.cli,
                            ) && (
                              <option value={a.cli} disabled>
                                {cliAdapter?.label ?? a.cli} · indisponível
                              </option>
                            )}
                          </select>
                        )}
                      </span>
                      <div className="wizard__model-cell">
                        <select
                          className="wizard__mini-select"
                          aria-label={`Modelo de ${a.agentName}`}
                          value={a.model ?? cliAdapter?.models.default ?? ""}
                          onChange={(e) =>
                            onUpdateAgent(a.id, { model: e.target.value })
                          }
                        >
                          {models.length === 0 && (
                            <option value={a.model ?? ""}>
                              {a.model ?? "—"}
                            </option>
                          )}
                          {models.map((m) => (
                            <option
                              key={m}
                              value={m}
                              // Part (a): the currently selected model stays
                              // selectable so the picker is never dead; only
                              // OTHER unauthenticated models are disabled.
                              disabled={
                                m !== (a.model ?? cliAdapter?.models.default) &&
                                (!cliAdapter ||
                                  !isAdapterModelAuthenticated(
                                    cliAdapter,
                                    providers,
                                    m,
                                    accounts,
                                  ))
                              }
                            >
                              {modelLabel(a.cli, m)}
                              {!cliAdapter ||
                              !isAdapterModelAuthenticated(
                                cliAdapter,
                                providers,
                                m,
                                accounts,
                              )
                                ? " · login necessário"
                                : ""}
                            </option>
                          ))}
                        </select>
                        <ModelMetaBadge
                          adapterId={a.cli}
                          modelId={a.model ?? cliAdapter?.models.default}
                          className="wizard__model-meta"
                        />
                      </div>
                      <select
                        className="wizard__mini-select wizard__mini-select--effort"
                        aria-label={`Esforço de ${a.agentName}`}
                        value={a.effort ?? "medium"}
                        onChange={(e) =>
                          onUpdateAgent(a.id, {
                            effort: e.target.value as SquadAgent["effort"],
                          })
                        }
                      >
                        {(() => {
                          const advertised =
                            providers.find((p) => p.adapterId === a.cli)
                              ?.efforts ?? [];
                          const current = a.effort ?? "medium";
                          const efforts =
                            advertised.length > 0
                              ? [...new Set([...advertised, current])]
                              : [
                                  ...new Set([
                                    "low",
                                    "medium",
                                    "high",
                                    "xhigh",
                                    "max",
                                    current,
                                  ]),
                                ];
                          return efforts.map((effort) => (
                            <option key={effort} value={effort}>
                              {effort}
                            </option>
                          ));
                        })()}
                      </select>
                    </div>
                  </div>
                  <div className="wizard__agent-spec">
                    <label className="wizard__agent-spec-label">
                      tools
                      <input
                        className={`wizard__agent-spec-input${!isOrchestrator && a.allowedTools == null ? " wizard__agent-spec-input--error" : ""}`}
                        value={specValue(a.allowedTools, isOrchestrator)}
                        placeholder={
                          isOrchestrator
                            ? "* (irrestrito) ou Bash, Read, Edit…"
                            : "Bash, Read, Edit… (vazio = bloquear todas)"
                        }
                        spellCheck={false}
                        onChange={(e) => {
                          if (
                            !isOrchestrator &&
                            e.target.value.trim() === "*"
                          ) {
                            onError(
                              "Workers não podem usar * em tools; deixe vazio ou liste tools explícitas.",
                            );
                          }
                          onUpdateAgent(a.id, {
                            allowedTools: parseSpecList(
                              e.target.value,
                              isOrchestrator,
                            ),
                          });
                        }}
                      />
                    </label>
                    <label className="wizard__agent-spec-label">
                      skills
                      <input
                        className="wizard__agent-spec-input"
                        value={specValue(a.allowedSkills, true)}
                        placeholder="react-patterns, graphify… (vazio = bloquear)"
                        spellCheck={false}
                        onChange={(e) =>
                          onUpdateAgent(a.id, {
                            allowedSkills: parseSpecList(e.target.value, true),
                          })
                        }
                      />
                    </label>
                    {!isOrchestrator && a.allowedTools == null && (
                      <p className="wizard__row-error">
                        Tools bloqueadas. Liste explicitamente ou deixe vazio
                        para bloquear todas.
                      </p>
                    )}
                    {!isOrchestrator && !workerAgentQualified(a) && (
                      <p className="wizard__row-error">
                        {operatorChoice
                          ? "CLI precisa estar instalada e autenticada para rodar neste papel."
                          : roundtable.governedQualificationMessage(a.category)}{" "}
                        {operatorChoice
                          ? "Faça login na CLI ou troque o provider."
                          : "Escolha uma CLI qualificada; as opções marcadas como somente manual não iniciam workers."}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </details>
      {error && (
        <p className="wizard__error" role="alert" aria-live="assertive">
          {error}
        </p>
      )}
      {workerBlockedReason && (
        <p className="wizard__error" role="alert">
          {workerBlockedReason}
        </p>
      )}
      {guided && (
        <p className="wizard__hint-sm">
          A aprovação nativa é a única confirmação necessária para iniciar.
        </p>
      )}
      <div className="wizard__actions">
        <button className="wizard__btn" onClick={onBack}>
          ‹ Voltar
        </button>
        <div className="wizard__actions-right">
          <button className="wizard__btn wizard__btn--ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="wizard__btn wizard__btn--primary"
            data-nexus-real-mission-wizard-launch="true"
            onClick={onLaunch}
            disabled={
              spawning ||
              !!rosterInvalidAgent ||
              Boolean(workerBlockedReason) ||
              Boolean(orchestratorBlockedReason)
            }
            title={
              rosterInvalidAgent
                ? `Worker "${rosterInvalidAgent.agentName}" está sem allowlist de tools. Corrija o campo "tools" antes de iniciar.`
                : (workerBlockedReason ??
                  orchestratorBlockedReason ??
                  undefined)
            }
          >
            {spawning
              ? "Preparando aprovação…"
              : (launchLabel ??
                (guided ? "Continuar para aprovação" : "Usar este squad"))}
          </button>
        </div>
      </div>
    </div>
  );
}
