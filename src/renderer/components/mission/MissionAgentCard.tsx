import type { CSSProperties } from 'react';
import type {
  MissionAgentSnapshot,
  MissionUnit,
} from '../../../shared/mission-engine-contract';
import { PixelIcon, type PixelIconName } from '../PixelIcon';

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

export interface MissionAgentCardPosition {
  readonly x: number;
  readonly y: number;
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

export function MissionAgentCard({
  agent,
  currentUnit,
  selected,
  position,
  onSelectAgent,
}: MissionAgentCardProps) {
  const categoryLabel = CATEGORY_LABELS[agent.category];
  const stateLabel = STATE_LABELS[agent.state];
  const currentUnitId = currentUnit?.id ?? agent.currentUnitId;
  const currentUnitTitle = currentUnit?.title;
  const accessibleText = [
    agent.agentName,
    `Papel: ${categoryLabel}`,
    `Estado: ${stateLabel}`,
    currentUnitId
      ? currentUnitTitle
        ? `Unidade atual: ${currentUnitTitle} (${currentUnitId})`
        : `Unidade atual: ${currentUnitId}`
      : null,
    agent.detail ? `Detalhe: ${agent.detail}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ');
  const positionStyle: PositionedCardStyle = {
    '--mission-agent-x': `${position.x}px`,
    '--mission-agent-y': `${position.y}px`,
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

      {currentUnitId && (
        <span className="mission-agent-card__unit">
          <span className="mission-agent-card__unit-label">Unidade atual</span>
          {currentUnitTitle && (
            <span
              className="mission-agent-card__unit-title"
              title={currentUnitTitle}
            >
              {currentUnitTitle}
            </span>
          )}
          <code className="mission-agent-card__unit-id" title={currentUnitId}>
            {currentUnitId}
          </code>
        </span>
      )}

      {agent.detail && (
        <span className="mission-agent-card__detail" title={agent.detail}>
          {agent.detail}
        </span>
      )}
    </button>
  );
}
