import type { CSSProperties } from 'react';
import type {
  MissionAgentSnapshot,
  MissionUnit,
} from '../../../shared/mission-engine-contract';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { ProviderLogo } from '../ProviderLogo';

const CATEGORY_LABELS: Readonly<
  Record<MissionAgentSnapshot['category'], string>
> = {
  orchestrator: 'Coordenação',
  scout: 'Pesquisa',
  executor: 'Execução',
  reviewer: 'Revisão',
  architect: 'Arquitetura',
};

const CATEGORY_ICONS = {
  orchestrator: 'orch',
  scout: 'search',
  executor: 'terminal',
  reviewer: 'check',
  architect: 'grid',
} as const satisfies Readonly<
  Record<MissionAgentSnapshot['category'], PixelIconName>
>;

const STATE_LABELS: Readonly<Record<MissionAgentSnapshot['state'], string>> = {
  queued: 'Na fila',
  working: 'Trabalhando',
  waiting: 'Aguardando',
  blocked: 'Bloqueado',
  done: 'Concluído',
  failed: 'Falhou',
  stopped: 'Interrompido',
};

/** Régua de LEDs de atividade do rack (só desenho; o estado vem em palavra). */
const ACTIVITY_LEDS = 12;

export interface MissionAgentCardPosition {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
}

export interface MissionAgentCardProps {
  readonly agent: MissionAgentSnapshot;
  readonly currentUnit?: MissionUnit;
  readonly selected: boolean;
  readonly position: MissionAgentCardPosition;
  readonly onSelectAgent: (agentId: string) => void;
}

type PositionedCardStyle = CSSProperties & {
  readonly '--mission-agent-x': string;
  readonly '--mission-agent-y': string;
};

/** Ferramenta e modelo do rack, como o operador os reconhece. */
export function rackToolLabel(
  agent: Pick<MissionAgentSnapshot, 'cli' | 'model'>,
): string {
  return agent.model ? `${agent.cli} · ${agent.model}` : agent.cli;
}

/**
 * Um agente da missão desenhado como rack: trilhos com parafusos, a
 * ferramenta (logo + CLI + modelo), o LED e a palavra do estado, a régua de
 * atividade e o visor com a unidade atual. O coordenador é o núcleo, mais
 * largo, com o painel de portas onde os cabos se ligam.
 */
export function MissionAgentCard({
  agent,
  currentUnit,
  selected,
  position,
  onSelectAgent,
}: MissionAgentCardProps) {
  const categoryLabel = CATEGORY_LABELS[agent.category];
  const stateLabel = STATE_LABELS[agent.state];
  const toolLabel = rackToolLabel(agent);
  const currentUnitId = currentUnit?.id;
  const currentUnitTitle = currentUnit?.title;
  const idleLabel = agent.terminalLive === false
    ? 'Sem terminal ativo'
    : agent.terminalLive === true
      ? 'Terminal ativo · Sem tarefa vinculada'
      : 'Sem tarefa vinculada';
  const accessibleText = [
    agent.agentName,
    agent.operatorOpened === true ? 'Aberto por você' : null,
    `Papel: ${categoryLabel}`,
    `Ferramenta: ${toolLabel}`,
    `Estado: ${stateLabel}`,
    agent.terminalLive === false || !currentUnitId ? idleLabel : null,
    agent.terminalLive === false && !currentUnitId ? 'Sem tarefa vinculada' : null,
    currentUnitId
      ? currentUnitTitle
        ? `Unidade atual: ${currentUnitTitle} (${currentUnitId})`
        : `Unidade atual: ${currentUnitId}`
      : null,
    agent.detail ? `Detalhe: ${agent.detail}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ');
  const isCore = agent.category === 'orchestrator';
  const positionStyle: PositionedCardStyle = {
    '--mission-agent-x': `${position.x}px`,
    '--mission-agent-y': `${position.y}px`,
    // A caixa renderizada tem as mesmas dimensões usadas pelo roteador.
    ...(position.width === undefined ? {} : {
      [isCore ? '--mission-core-width' : '--mission-rack-width']: `${position.width}px`,
    }),
    ...(position.height === undefined ? {} : {
      [isCore ? '--mission-core-height' : '--mission-rack-height']: `${position.height}px`,
    }),
  };

  return (
    <button
      type="button"
      className={`mission-agent-card${
        selected ? ' mission-agent-card--selected' : ''
      }`}
      data-agent-id={agent.id}
      data-category={agent.category}
      data-state={agent.state}
      data-activity-live={agent.state === 'working' && agent.terminalLive !== false ? 'true' : 'false'}
      aria-label={accessibleText}
      aria-pressed={selected}
      title={accessibleText}
      style={positionStyle}
      onClick={() => onSelectAgent(agent.id)}
    >
      <span className="mission-agent-card__meta">
        <span className="mission-agent-card__category">
          <span
            className="mission-agent-card__category-icon"
            data-agent-category-icon={agent.category}
          >
            <PixelIcon name={CATEGORY_ICONS[agent.category]} size={12} />
          </span>
          <span className="mission-agent-card__category-label">
            {categoryLabel}
          </span>
        </span>
        <span className="mission-agent-card__state">{stateLabel}</span>
      </span>

      <strong className="mission-agent-card__name" title={agent.agentName}>
        {agent.agentName}
      </strong>

      <span className="mission-agent-card__tool" title={toolLabel}>
        <ProviderLogo adapterId={agent.cli} label={agent.cli} size="xs" />
        <code className="mission-agent-card__tool-label">{toolLabel}</code>
      </span>

      <span className="mission-agent-card__activity" aria-hidden="true">
        {Array.from({ length: ACTIVITY_LEDS }, (_, index) => (
          <span
            key={index}
            className="mission-agent-card__led"
            style={{ '--mission-led-index': index } as CSSProperties}
          />
        ))}
      </span>

      {agent.operatorOpened === true && (
        <span className="mission-agent-card__operator-opened">
          aberto por você
        </span>
      )}

      <span className="mission-agent-card__display">
        {(agent.terminalLive === false || !currentUnitId) && (
          <span className="mission-agent-card__idle" aria-hidden="true">
            {idleLabel}
            {agent.terminalLive === false && !currentUnitId ? ' · Sem tarefa vinculada' : null}
          </span>
        )}
        {(currentUnitId || agent.detail) && (
          <>
          {currentUnitId && (
            <span className="mission-agent-card__unit">
              <span className="mission-agent-card__unit-label">
                Unidade atual
              </span>
              {currentUnitTitle && (
                <span
                  className="mission-agent-card__unit-title"
                  title={currentUnitTitle}
                >
                  {currentUnitTitle}
                </span>
              )}
              <code
                className="mission-agent-card__unit-id"
                title={currentUnitId}
              >
                {currentUnitId}
              </code>
            </span>
          )}

          {agent.detail && (
            <span className="mission-agent-card__detail" title={agent.detail}>
              {agent.detail}
            </span>
          )}
          </>
        )}
      </span>

      {isCore && <span className="mission-agent-card__patch" aria-hidden="true" />}
    </button>
  );
}
