import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountInfo } from "../../shared/account-types";
import type { AdapterInfo } from "../../shared/types";
import type { ProviderSettingsInfo } from "../../shared/provider-settings-types";
import type { Squad } from "../../shared/orch-types";
import { useHomeStore } from "../state/home-store";
import { useOrchStore } from "../state/orch-store";
import { useLayoutStore } from "../state/layout-store";
import { useWorkspaceStore } from "../state/workspace-store";
import { useMissionWizardStore } from "../state/mission-wizard-store";
import { useSettingsStore } from "../state/settings-store";
import { listPanes } from "../lib/split-tree";
import { primaryShortcuts } from "../lib/shortcuts";
import { PixelIcon } from "./PixelIcon";
import { AgentAvatar } from "./AgentAvatar";
import { EndorphinPresence } from "./EndorphinPresence";
import { MissionComposer } from "./MissionComposer";
import {
  homeCliBeat,
  homeReadyBeat,
  homeSetupBeat,
  homeWarmingBeat,
} from "../../shared/endorphin";
import {
  formatReadyProviderIds,
  missionRuntimeReadiness,
} from "../orch/mission-runtime-readiness";
import {
  DEFAULT_ORCH_SETTINGS,
  type SquadCliPolicy,
} from "../../shared/settings-types";

/**
 * Home deck — the ops-deck empty state rendered over the pane area when a
 * workspace opens without a saved mission. Non-modal: the shell pane stays
 * live underneath and one click dismisses into it. Answers "what can I run
 * right now?" with a goal-first path. Infrastructure and saved teams remain
 * available under progressive disclosure for experienced users.
 */

function workerCount(squad: Squad): string {
  const workers = squad.agents.filter(
    (a) => a.category !== "orchestrator",
  ).length;
  const hasOrch = squad.agents.some((a) => a.category === "orchestrator");
  return hasOrch
    ? `orquestrador + ${workers} agente${workers === 1 ? "" : "s"}`
    : `${workers} agentes`;
}

export function HomeDeck() {
  const visible = useHomeStore((s) => s.visible);
  const hide = useHomeStore((s) => s.hide);
  const squads = useOrchStore((s) => s.squads);
  const mcpInfo = useOrchStore((s) => s.mcpInfo);
  const workspace = useWorkspaceStore((s) => s.current);
  const openAgentic = useMissionWizardStore((s) => s.openForAgentic);
  const openMission = useMissionWizardStore((s) => s.openForMission);
  const openForSquad = useMissionWizardStore((s) => s.openForSquad);
  // Um CTA de correção NUNCA pode ser toggle: com o drawer já aberto o clique
  // o fechava. E sem seção explícita o destino era "Minha conta" — o botão
  // dizia "Conectar uma IA" e entregava a tela de assinatura.
  const openSettings = useSettingsStore((s) => s.openDrawer);
  const addShellPane = useLayoutStore((s) => s.addShellPane);
  const claimStructuralPlaceholder = useLayoutStore(
    (s) => s.claimStructuralPlaceholder,
  );
  const paneCount = useLayoutStore((s) => listPanes(s.root).length);
  const viewKind = useLayoutStore((s) => s.viewKind);

  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [providers, setProviders] = useState<ProviderSettingsInfo[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [squadCliPolicy, setSquadCliPolicy] = useState<SquadCliPolicy>(
    DEFAULT_ORCH_SETTINGS.squadCliPolicy,
  );
  const [adaptersLoaded, setAdaptersLoaded] = useState(false);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);
  const [adapterLoadAttempt, setAdapterLoadAttempt] = useState(0);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let requestRevision = 0;
    const refreshInventory = (): void => {
      const revision = ++requestRevision;
      setAdaptersLoaded(false);
      setAdaptersError(null);
      void Promise.all([
        window.nexus.adapters.list(),
        window.nexus.providers.list(),
        window.nexus.accounts.list(),
        window.nexus.settings?.orchGet?.().catch(() => DEFAULT_ORCH_SETTINGS) ??
          Promise.resolve(DEFAULT_ORCH_SETTINGS),
      ])
        .then(([nextAdapters, nextProviders, nextAccounts, orchSettings]) => {
          if (cancelled || revision !== requestRevision) return;
          setAdapters(nextAdapters);
          setProviders(nextProviders);
          setAccounts(nextAccounts);
          setSquadCliPolicy(orchSettings.squadCliPolicy);
        })
        .catch((cause) => {
          if (cancelled || revision !== requestRevision) return;
          setAdapters([]);
          setProviders([]);
          setAccounts([]);
          setAdaptersError(
            cause instanceof Error && cause.message.trim()
              ? cause.message
              : "O inventário operacional de providers não respondeu.",
          );
        })
        .finally(() => {
          if (!cancelled && revision === requestRevision) {
            setAdaptersLoaded(true);
          }
        });
    };
    // Changed events already carry authoritative snapshots. Re-invoking every
    // list endpoint from their listeners creates a feedback loop because the
    // provider list schedules discovery and broadcasts its result. Consume the
    // pushed data directly so Home never flickers back to "Verificando…" after
    // it becomes ready.
    const stopAdapters = window.nexus.adapters.onChanged((next) => {
      if (!cancelled) setAdapters(next);
    });
    const stopProviders = window.nexus.providers.onChanged((next) => {
      if (!cancelled) setProviders(next);
    });
    const stopAccounts = window.nexus.accounts.onChanged((next) => {
      if (!cancelled) setAccounts(next);
    });
    refreshInventory();
    return () => {
      cancelled = true;
      requestRevision += 1;
      stopAdapters();
      stopProviders();
      stopAccounts();
    };
  }, [visible, adapterLoadAttempt]);

  // Anything spawning panes (missions, agents, orchestration) takes over.
  useEffect(() => {
    if (visible && paneCount > 1) hide();
  }, [visible, paneCount, hide]);

  useEffect(() => {
    if (visible && adaptersLoaded) primaryActionRef.current?.focus();
  }, [visible, adaptersLoaded]);

  // Escape dispensa o Home para o terminal ao fundo — saída sempre à mão.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, hide]);

  const readiness = useMemo(
    () =>
      missionRuntimeReadiness(
        adapters,
        providers,
        accounts,
        squadCliPolicy,
      ),
    [accounts, adapters, providers, squadCliPolicy],
  );
  // Seus squads (custom) primeiro — os originais re-semeiam sozinhos, então
  // nunca podem empurrar um squad seu para fora da lista.
  const featured = useMemo(
    () =>
      [...squads]
        .sort((a, b) => Number(a.builtin ?? false) - Number(b.builtin ?? false))
        .slice(0, 6),
    [squads],
  );
  const adapterLoadFailed = adaptersLoaded && adaptersError !== null;
  const adaptersLoading = !adaptersLoaded;
  const needsCli =
    adaptersLoaded &&
    !adapterLoadFailed &&
    readiness.detectedAdapters.length === 0;
  const needsExecutionSetup =
    adaptersLoaded &&
    !adapterLoadFailed &&
    readiness.detectedAdapters.length > 0 &&
    !readiness.hasOperationalRoute;
  const isReady =
    adaptersLoaded &&
    !adapterLoadFailed &&
    readiness.hasOperationalRoute &&
    Boolean(mcpInfo?.running);
  const beat = isReady
    ? homeReadyBeat(readiness.detectedAdapters.length, mcpInfo?.toolCount ?? 0)
    : needsCli
      ? homeCliBeat()
      : needsExecutionSetup
        ? homeSetupBeat()
      : homeWarmingBeat();

  const composerInputDisabled =
    adaptersLoading ||
    adapterLoadFailed ||
    needsCli ||
    needsExecutionSetup;

  function submitObjective(intent: string): void {
    if (adapterLoadFailed) {
      setAdapterLoadAttempt((attempt) => attempt + 1);
      return;
    }
    if (needsCli || needsExecutionSetup) {
      openSettings("providers");
      return;
    }
    // Com texto: piloto automático (objetivo-first). Sem texto: seletor de
    // modo (Livre / Squad / Agêntico) — o operador escolhe o formato, não
    // cai direto no REVISAR de um time default.
    if (intent.trim()) {
      openAgentic(intent.trim());
      return;
    }
    openMission();
  }

  function openTerminalFromHome(): void {
    const panes = listPanes(useLayoutStore.getState().root);
    const loneShell =
      panes.length === 1 &&
      panes[0]?.kind === "shell" &&
      !panes[0].orchRequestId;
    hide();
    if (loneShell) {
      claimStructuralPlaceholder(panes[0]!.id);
      useLayoutStore.getState().focus(panes[0]!.id);
      return;
    }
    addShellPane();
  }

  if (!visible) return null;

  return (
    <div
      className={`home-deck${isReady ? " home-deck--armed" : ""}`}
      role="region"
      aria-label="Início do workspace"
    >
      <div className="home-deck__panel">
        <header className="home-deck__head">
          <EndorphinPresence
            className="home-deck__presence endorphin-presence--row"
            mood={isReady ? "celebrating" : needsCli ? "idle" : "idle"}
            size={48}
          />
          <div className="home-deck__title-wrap">
            {beat.kicker ? (
              <span className="home-deck__kicker">{beat.kicker}</span>
            ) : null}
            <h1 className="home-deck__title">{beat.title}</h1>
            <p className="home-deck__ws" title={workspace?.path}>
              {workspace?.name ?? "workspace"}
            </p>
            {isReady ? (
              <span className="home-deck__ready-chip" role="status">
                <i className="home-deck__dot" aria-hidden="true" />
                Rota verificada
              </span>
            ) : null}
          </div>
          <button
            className="home-deck__close"
            onClick={hide}
            title="Fechar (Esc) — usa o terminal ao fundo"
            aria-label="Fechar o painel inicial"
          >
            <PixelIcon name="close" size={12} />
          </button>
        </header>

        <section className="home-deck__next" aria-labelledby="home-next-title">
          <div className="home-deck__next-copy">
            <p className="home-deck__next-label">Próxima ação</p>
            <h2 id="home-next-title">
              {adaptersLoading
                ? "Verificando suas IAs"
                : adapterLoadFailed
                  ? "Não consegui verificar suas IAs"
                  : needsCli
                    ? "Conectar uma IA"
                    : needsExecutionSetup
                      ? "Concluir configuração"
                      : "O que você quer criar?"}
            </h2>
            <p
              role={
                adapterLoadFailed
                  ? "alert"
                  : adaptersLoading
                    ? "status"
                    : undefined
              }
              aria-live={
                adapterLoadFailed
                  ? "assertive"
                  : adaptersLoading
                    ? "polite"
                    : undefined
              }
            >
              {adaptersLoading
                ? "Lendo os providers locais antes de liberar uma missão."
                : adapterLoadFailed
                  ? `Falha ao carregar os providers: ${adaptersError}`
                  : (beat.line ??
                    (needsCli
                      ? "Escolha uma conta compatível para começar."
                      : needsExecutionSetup
                        ? squadCliPolicy === "operator-choice"
                          ? "Habilite e autentique uma CLI com handoff para o Nexus conduzir a missão."
                          : "Habilite e autentique um Maestro verificado e um worker com escrita autônoma confinada."
                        : "Descreva o resultado. O Nexus transforma a ideia em plano, equipe, implementação e verificação."))}
            </p>
          </div>
          <div className="home-deck__actions">
            <MissionComposer
              inputDisabled={composerInputDisabled}
              submitDisabled={adaptersLoading}
              submitButtonRef={primaryActionRef}
              disabledReason={
                adaptersLoading
                  ? "Lendo os providers locais antes de liberar a missão."
                  : adapterLoadFailed
                    ? "O inventário de providers falhou — tente de novo para reler."
                    : needsCli
                      ? "Conecte uma IA para escrever o objetivo."
                      : needsExecutionSetup
                        ? "Conclua a configuração de execução para escrever o objetivo."
                        : undefined
              }
              submitIcon={
                adaptersLoading
                  ? "agent"
                  : adapterLoadFailed
                    ? "restart"
                    : needsCli || needsExecutionSetup
                      ? "config"
                      : "mission"
              }
              submitLabel={
                adaptersLoading
                  ? "Verificando…"
                  : adapterLoadFailed
                    ? "Tentar novamente"
                    : needsCli
                      ? "Conectar uma IA"
                      : needsExecutionSetup
                        ? "Configurar execução"
                        : "Descrever objetivo"
              }
              onSubmit={submitObjective}
              onOpenTerminal={openTerminalFromHome}
            />
          </div>
        </section>

        {/* Aberto por padrão quando há o que corrigir: fechado, o
            diagnóstico só era visto por quem já suspeitava dele. */}
        <details className="home-deck__advanced" open={!isReady}>
          <summary>Detalhes do ambiente</summary>
          <div
            className="home-deck__status"
            aria-label="Estado técnico do ambiente"
          >
            <span
              className={`home-deck__stat ${readiness.detectedAdapters.length > 0 ? "home-deck__stat--live" : ""}`}
            >
              <i className="home-deck__dot" aria-hidden="true" />
              {adapterLoadFailed
                ? "Falha ao verificar CLIs"
                : adaptersLoaded
                  ? `${readiness.detectedAdapters.length} CLI${readiness.detectedAdapters.length === 1 ? "" : "s"} detectada${readiness.detectedAdapters.length === 1 ? "" : "s"}`
                  : "Verificando CLIs"}
            </span>
            <span
              className={`home-deck__stat ${readiness.readyProviders.length > 0 ? "home-deck__stat--live" : ""}`}
              title={
                readiness.readyProviders.length > 0
                  ? formatReadyProviderIds(readiness)
                  : undefined
              }
            >
              <i className="home-deck__dot" aria-hidden="true" />
              {readiness.readyProviders.length > 0
                ? `${readiness.readyProviders.length} provider${readiness.readyProviders.length === 1 ? "" : "s"} pronto${readiness.readyProviders.length === 1 ? "" : "s"}: ${formatReadyProviderIds(readiness)}`
                : "Nenhum provider autenticado"}
            </span>
            <span
              className={`home-deck__stat ${readiness.multiProviderReady ? "home-deck__stat--live" : ""}`}
            >
              <i className="home-deck__dot" aria-hidden="true" />
              {readiness.multiProviderReady
                ? `Multi-LLM ativo · cota espalhada em ${readiness.readyProviders.length} CLIs`
                : readiness.readyProviders.length === 1
                  ? "Uma CLI só — autenticar mais providers multiplica economia e paralelismo"
                  : squadCliPolicy === "operator-choice"
                    ? "Nenhuma CLI autenticada"
                    : "Nenhum Maestro autenticado e verificado"}
            </span>
            <span
              className={`home-deck__stat ${readiness.qualifiedWorkers.length > 0 ? "home-deck__stat--live" : ""}`}
            >
              <i className="home-deck__dot" aria-hidden="true" />
              {readiness.qualifiedWorkers.length > 0
                ? squadCliPolicy === "operator-choice"
                  ? `${readiness.qualifiedWorkers.length} worker${readiness.qualifiedWorkers.length === 1 ? "" : "s"} com handoff (${readiness.qualifiedWorkers.map((w) => w.id).join(", ")})`
                  : `${readiness.qualifiedWorkers.length} worker${readiness.qualifiedWorkers.length === 1 ? "" : "s"} com escrita confinada`
                : squadCliPolicy === "operator-choice"
                  ? "Nenhum worker autenticado com handoff"
                  : "Nenhum worker autenticado com escrita confinada"}
            </span>
            <span
              className={`home-deck__stat ${mcpInfo?.running ? "home-deck__stat--live" : ""}`}
            >
              <i className="home-deck__dot" aria-hidden="true" />
              {mcpInfo?.running
                ? `MCP online · ${mcpInfo.toolCount} ferramentas`
                : mcpInfo
                  ? "MCP indisponível"
                  : "MCP conectando"}
            </span>
          </div>

          {/* Diagnóstico sem porta de saída é diagnóstico morto: a linha que
              nomeava "Configurações › Providers" era texto, e o operador tinha
              de garimpar a seção à mão. */}
          <button
            type="button"
            className="home-deck__stat-action"
            onClick={() => openSettings("providers")}
          >
            <PixelIcon name="key" size={11} />
            Abrir Providers
          </button>

        </details>

        {featured.length > 0 && (
          <section className="home-deck__squads" aria-label="Equipes salvas">
            <h2 className="home-deck__section-title">Equipes salvas</h2>
            <ul className="home-deck__squad-list">
              {featured.map((s) => (
                <li key={s.id}>
                  <button
                    className="home-deck__squad"
                    onClick={() => openForSquad(s.id)}
                  >
                    <span
                      className="agent-avatar-group home-deck__squad-avatars"
                      aria-label="Pessoas da equipe"
                    >
                      {s.agents.slice(0, 5).map((agent) => (
                        <AgentAvatar
                          key={agent.id}
                          category={agent.category}
                          state="offline"
                          size="card"
                          label={agent.agentName}
                          className="home-deck__squad-avatar"
                        />
                      ))}
                    </span>
                    <span className="home-deck__squad-name">{s.name}</span>
                    <span className="home-deck__squad-meta">
                      {workerCount(s)}
                    </span>
                    <span className="home-deck__squad-go" aria-hidden="true">
                      <PixelIcon name="chevron" size={10} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="home-deck__foot">
          <div className="home-deck__instrument" aria-label="Instrumentos operacionais">
            <div className="home-deck__instrument-signals">
              <span className="home-deck__instrument-signal">
                <i
                  className={`home-deck__instrument-dot${mcpInfo?.running ? " home-deck__instrument-dot--live" : ""}`}
                  aria-hidden="true"
                />
                {mcpInfo?.running ? "MCP online" : "MCP conectando"}
              </span>
              <span className="home-deck__instrument-signal">
                <i
                  className={`home-deck__instrument-dot${readiness.detectedAdapters.length > 0 ? " home-deck__instrument-dot--live" : ""}`}
                  aria-hidden="true"
                />
                {readiness.detectedAdapters.length} CLI
                {readiness.detectedAdapters.length === 1 ? "" : "s"} local
              </span>
            </div>
            {/* Mesma fonte do cheatsheet e de Configurações › Atalhos: três
                listas escritas à mão divergiram e ⌘⇧N não estava em nenhuma. */}
            <span className="home-deck__keys">
              {primaryShortcuts(viewKind === "canvas" ? "canvas" : "grid").map(
                (entry, index) => (
                  <span key={entry.id}>
                    {index > 0 ? " · " : null}
                    <kbd>{entry.keys}</kbd> {entry.short ?? entry.action}
                  </span>
                ),
              )}
              {viewKind === "canvas" ? " · arraste panes" : null}
            </span>
          </div>
          <button className="home-deck__dismiss" onClick={openTerminalFromHome}>
            Abrir terminal <PixelIcon name="chevron" size={10} />
          </button>
        </footer>
      </div>
    </div>
  );
}
