import {
  agentCountLabel,
  idleFleetLabel,
  workingNowLabel,
  type RosterAgent,
  type RosterAgentKind,
  type RosterFleet,
} from '../../lib/agent-roster';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { ProviderLogo } from '../ProviderLogo';

/**
 * Quem está trabalhando, à vista no rail.
 *
 * O rail mostrava "3 agentes" recolhido e, aberto, o título OSC da CLI cortado.
 * Aqui o sinal vem primeiro: a frase "N trabalhando agora" fica sempre na linha
 * do bloco, os agentes TRABALHANDO não somem atrás do recolher DESTE bloco (só
 * os demais obedecem a ele) e cada linha diz quem é, qual CLI/modelo e a
 * tarefa. Em paralelo (dois ou mais) o bloco ganha a marca "em paralelo".
 * Recolher o PROJETO inteiro segue escondendo as missões, por escolha do
 * operador; a linha do projeto mantém a contagem.
 *
 * A ordem das linhas é a do layout e não depende do estado — linha que muda de
 * lugar a cada busy↔idle é clique no alvo errado.
 */

/** Glifos do próprio sistema (os mesmos do chip da toolbar): a forma muda, não só a cor. */
const KIND_ICON: Record<RosterAgentKind, PixelIconName> = {
  working: 'status-busy',
  starting: 'status-spawning',
  waiting: 'status-idle',
  sleeping: 'status-hibernated',
  stopped: 'status-exited',
  unknown: 'info',
};

export interface RailAgentMeta {
  readonly label: string;
  readonly icon: string;
}

export interface RailAgentRosterProps {
  readonly fleet: RosterFleet;
  /** Complemento do nome acessível: "nesta missão", "nos terminais". */
  readonly scopeLabel: string;
  /**
   * Título visível do bloco. A missão tem o próprio cartão acima, que já diz de
   * quem são os agentes; o bloco dos terminais soltos não tem — sem título
   * ninguém sabe se "2 agentes" são da missão ou dos terminais.
   */
  readonly heading?: string;
  /** Mostra também os agentes que não estão trabalhando. */
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onFocusAgent: (paneId: string) => void;
  readonly adapterMeta: ReadonlyMap<string, RailAgentMeta>;
}

/**
 * Nome acessível do botão do bloco. O `aria-label` substitui o texto visível,
 * então ele CONTÉM todo o texto visível (título, contagens, "em paralelo"):
 * quem comanda por voz o que lê na tela ("Terminais", "em paralelo") é entendido.
 */
function rosterAccessibleName(
  fleet: RosterFleet,
  scopeLabel: string,
  heading: string | undefined,
): string {
  const total = agentCountLabel(fleet.agents.length);
  const parts = [
    heading ? total : `${total} ${scopeLabel}`,
    fleet.workingCount > 0
      ? workingNowLabel(fleet.workingCount)
      : idleFleetLabel(fleet),
    fleet.parallel ? 'em paralelo' : null,
  ]
    .filter(Boolean)
    .join(', ');
  return heading ? `${heading}: ${parts}` : parts;
}

function agentAccessibleName(agent: RosterAgent): string {
  return [
    `${agent.name}, ${agent.cliDetail}`,
    agent.stateLabel,
    agent.task,
  ]
    .filter(Boolean)
    .join('. ');
}

function agentTooltip(agent: RosterAgent): string {
  return [
    `Focar ${agent.name}`,
    agent.cliDetail,
    agent.task ? `${agent.stateLabel} · ${agent.task}` : agent.stateLabel,
    agent.paneNumber !== null ? `Pane ${agent.paneNumber}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function RailAgentRoster({
  fleet,
  scopeLabel,
  heading,
  expanded,
  onToggle,
  onFocusAgent,
  adapterMeta,
}: RailAgentRosterProps) {
  const total = fleet.agents.length;
  if (total === 0) return null;
  const live = fleet.workingCount > 0;
  // Recolhido, o bloco ainda mostra quem trabalha: o que se esconde é o resto.
  const visible = expanded
    ? fleet.agents
    : fleet.agents.filter((agent) => agent.working);
  const summary = rosterAccessibleName(fleet, scopeLabel, heading);

  return (
    <div
      className="workspace-rail__agents-block"
      data-working={live || undefined}
      data-parallel={fleet.parallel || undefined}
    >
      <button
        type="button"
        className="workspace-rail__agents-toggle"
        aria-expanded={expanded}
        aria-label={summary}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <span className="workspace-rail__agents-summary">
          {heading ? (
            <span className="workspace-rail__agents-scope">{heading}</span>
          ) : null}
          {live ? (
            <>
              <span className="workspace-rail__agents-live">
                <span
                  className="workspace-rail__live-dot"
                  aria-hidden="true"
                />
                {workingNowLabel(fleet.workingCount)}
              </span>
              {fleet.parallel ? (
                <span className="workspace-rail__live-tag">em paralelo</span>
              ) : null}
              {/* Sem separador de texto: ao quebrar de linha ele ficaria
                  pendurado; a cor mais baixa e o espaço já separam. */}
              <span className="workspace-rail__agents-total">
                {agentCountLabel(total)}
              </span>
            </>
          ) : (
            <span className="workspace-rail__agents-total">
              <PixelIcon name="users" size={10} />
              {agentCountLabel(total)} · {idleFleetLabel(fleet)}
            </span>
          )}
        </span>
        <span
          className={`workspace-rail__agents-chevron${
            expanded ? ' workspace-rail__agents-chevron--open' : ''
          }`}
          aria-hidden="true"
        >
          <PixelIcon name="chevron-down" size={9} />
        </span>
      </button>
      {visible.length > 0 ? (
        <ul
          className="workspace-rail__agents-list"
          aria-label={`Agentes ${scopeLabel}`}
        >
          {visible.map((agent) => {
            const meta = agent.adapterId
              ? adapterMeta.get(agent.adapterId)
              : undefined;
            return (
              <li
                key={agent.paneId}
                className="workspace-rail__agent-item"
                data-agent-state={agent.kind}
                data-pane-id={agent.paneId}
              >
                <button
                  type="button"
                  className="workspace-rail__agent-btn"
                  title={agentTooltip(agent)}
                  aria-label={agentAccessibleName(agent)}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFocusAgent(agent.paneId);
                  }}
                >
                  <span
                    className={`workspace-rail__agent-dot workspace-rail__agent-dot--${agent.kind}`}
                    aria-hidden="true"
                  >
                    <PixelIcon name={KIND_ICON[agent.kind]} size={11} />
                  </span>
                  {agent.adapterId ? (
                    <ProviderLogo
                      adapterId={agent.adapterId}
                      label={meta?.label ?? agent.adapterId}
                      fallback={meta?.icon}
                      size="xs"
                    />
                  ) : null}
                  <span className="workspace-rail__agent-copy">
                    <span className="workspace-rail__agent-head">
                      <span className="workspace-rail__agent-name">
                        {agent.orchestrator ? (
                          <PixelIcon
                            name="crown"
                            size={10}
                            className="workspace-rail__agent-crown"
                          />
                        ) : null}
                        {agent.name}
                      </span>
                      <span className="workspace-rail__agent-state">
                        {agent.stateLabel}
                      </span>
                    </span>
                    <span className="workspace-rail__agent-adapter">
                      {agent.cli}
                    </span>
                    {agent.task ? (
                      <span className="workspace-rail__agent-task">
                        {agent.task}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
