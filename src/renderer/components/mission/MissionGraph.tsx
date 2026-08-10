import type { CSSProperties } from 'react';
import type {
  MissionAgentSnapshot,
  MissionEdge,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { MissionAgentCard } from './MissionAgentCard';
import { ActionCard, EmptyState } from '../ActionCard';

const AGENTS_PER_ROW = 4;
const GRAPH_WIDTH = 960;
const COLUMN_STEP = GRAPH_WIDTH / AGENTS_PER_ROW;
const ROOT_Y = 96;
const FIRST_WORKER_ROW_Y = 288;
const WORKER_ROW_STEP = 192;
const GRAPH_BOTTOM_SPACE = 120;
const MIN_GRAPH_HEIGHT = 240;

const EDGE_KIND_LABELS = {
  delegation: 'Delegação',
  handoff: 'Entrega',
  dependency: 'Dependência',
  review: 'Revisão',
} as const satisfies Readonly<Record<MissionEdge['kind'], string>>;
const EDGE_KINDS = [
  'delegation',
  'handoff',
  'dependency',
  'review',
] as const satisfies readonly MissionEdge['kind'][];

export interface MissionGraphPosition {
  readonly agentId: string;
  readonly x: number;
  readonly y: number;
}

export interface MissionGraphProps {
  readonly snapshot: MissionSnapshot;
  readonly selectedAgentId: string | null;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onRetry: () => void;
}

interface PositionedEdge {
  readonly edge: MissionEdge;
  readonly source: MissionGraphPosition;
  readonly target: MissionGraphPosition;
  readonly sourceAgent: MissionAgentSnapshot;
  readonly targetAgent: MissionAgentSnapshot;
}

interface VisualEdge {
  readonly id: string;
  readonly kind: MissionEdge['kind'] | 'topology';
  readonly label?: string;
  readonly source: MissionGraphPosition;
  readonly target: MissionGraphPosition;
}

type GraphSurfaceStyle = CSSProperties & {
  readonly '--mission-graph-width': string;
  readonly '--mission-graph-height': string;
};

/**
 * Produces one stable visual root followed by the remaining agents in input
 * order. Coordinates are static canvas pixels, so rendering never needs a
 * physics loop or mutable simulation state.
 */
export function layoutMissionGraph(
  agents: readonly MissionAgentSnapshot[],
): readonly MissionGraphPosition[] {
  if (agents.length === 0) return [];

  const orchestratorIndex = agents.findIndex(
    ({ category }) => category === 'orchestrator',
  );
  const rootIndex = orchestratorIndex >= 0 ? orchestratorIndex : 0;
  const root = agents[rootIndex];
  const workers = agents.filter((_, index) => index !== rootIndex);
  const positions: MissionGraphPosition[] = [
    { agentId: root.id, x: GRAPH_WIDTH / 2, y: ROOT_Y },
  ];

  for (let index = 0; index < workers.length; index += 1) {
    const row = Math.floor(index / AGENTS_PER_ROW);
    const rowStart = row * AGENTS_PER_ROW;
    const rowSize = Math.min(AGENTS_PER_ROW, workers.length - rowStart);
    const column = index - rowStart;
    const firstX = (GRAPH_WIDTH - (rowSize - 1) * COLUMN_STEP) / 2;

    positions.push({
      agentId: workers[index].id,
      x: firstX + column * COLUMN_STEP,
      y: FIRST_WORKER_ROW_Y + row * WORKER_ROW_STEP,
    });
  }

  return positions;
}

function graphHeight(layout: readonly MissionGraphPosition[]): number {
  let lowestY = ROOT_Y;
  for (const position of layout) {
    if (position.y > lowestY) lowestY = position.y;
  }
  return Math.max(MIN_GRAPH_HEIGHT, lowestY + GRAPH_BOTTOM_SPACE);
}

function positionedEdges(
  edges: readonly MissionEdge[],
  positions: ReadonlyMap<string, MissionGraphPosition>,
  agents: ReadonlyMap<string, MissionAgentSnapshot>,
): readonly PositionedEdge[] {
  const visibleEdges: PositionedEdge[] = [];
  for (const edge of edges) {
    const source = positions.get(edge.sourceAgentId);
    const target = positions.get(edge.targetAgentId);
    const sourceAgent = agents.get(edge.sourceAgentId);
    const targetAgent = agents.get(edge.targetAgentId);
    if (!source || !target || !sourceAgent || !targetAgent) continue;
    visibleEdges.push({ edge, source, target, sourceAgent, targetAgent });
  }
  return visibleEdges;
}

export function MissionGraph({
  snapshot,
  selectedAgentId,
  onSelectAgent,
  onRetry,
}: MissionGraphProps) {
  const layout = layoutMissionGraph(snapshot.agents);

  if (layout.length === 0) {
    return (
      <section
        className="mission-graph mission-graph--empty"
        aria-label={`Equipe e conexões da missão ${snapshot.title}`}
      >
        <EmptyState
          className="mission-graph__empty"
          icon="users"
          title="Nenhum agente na missão"
          body={<p>Não foi possível carregar a equipe desta missão.</p>}
          action={
            <ActionCard
              className="mission-graph__retry"
              size="sm"
              variant="primary"
              title="Tentar carregar novamente"
              onClick={onRetry}
            />
          }
        />
      </section>
    );
  }

  const height = graphHeight(layout);
  const surfaceStyle: GraphSurfaceStyle = {
    '--mission-graph-width': `${GRAPH_WIDTH}px`,
    '--mission-graph-height': `${height}px`,
  };
  const positionsByAgentId = new Map(
    layout.map((position) => [position.agentId, position] as const),
  );
  const agentsById = new Map(
    snapshot.agents.map((agent) => [agent.id, agent] as const),
  );
  const unitsById = new Map(
    snapshot.units.map((unit) => [unit.id, unit] as const),
  );
  const edges = positionedEdges(
    snapshot.edges,
    positionsByAgentId,
    agentsById,
  );
  const visualEdges: readonly VisualEdge[] =
    edges.length > 0
      ? edges.map(({ edge, source, target }) => ({
          id: edge.id,
          kind: edge.kind,
          label: edge.label,
          source,
          target,
        }))
      : layout.slice(1).map((target) => ({
          id: `topology-${layout[0].agentId}-${target.agentId}`,
          kind: 'topology',
          source: layout[0],
          target,
        }));

  return (
    <section
      className="mission-graph"
      aria-label={`Equipe e conexões da missão ${snapshot.title}`}
      data-mission-state={snapshot.state}
    >
      <div className="mission-graph__surface" style={surfaceStyle}>
        <svg
          className="mission-graph__edges"
          viewBox={`0 0 ${GRAPH_WIDTH} ${height}`}
          width="100%"
          height="100%"
          aria-hidden="true"
          focusable="false"
        >
          {visualEdges.map(({ id, kind, label, source, target }) => (
            <g key={id}>
              <line
                className={`mission-graph__edge mission-graph__edge--${kind}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                data-edge-id={id}
                data-edge-kind={kind}
                data-edge-label={label}
                vectorEffect="non-scaling-stroke"
              />
              <line
                className="mission-graph__edge-signal"
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                data-edge-signal-for={id}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>

        <div className="mission-graph__cards">
          {layout.map((position) => {
            const agent = agentsById.get(position.agentId);
            if (!agent) return null;
            const currentUnit = agent.currentUnitId
              ? unitsById.get(agent.currentUnitId)
              : undefined;

            return (
              <MissionAgentCard
                key={agent.id}
                agent={agent}
                currentUnit={currentUnit}
                selected={selectedAgentId === agent.id}
                position={position}
                onSelectAgent={onSelectAgent}
              />
            );
          })}
        </div>
      </div>

      {edges.length > 0 ? (
        <section
          className="mission-graph__relationships"
          aria-label="Relações entre agentes"
        >
          <h3 className="mission-graph__relationships-title">
            Relações entre agentes
          </h3>
          <ul className="mission-graph__relationship-list">
            {edges.map(({ edge, sourceAgent, targetAgent }) => {
              const kindLabel = EDGE_KIND_LABELS[edge.kind];
              const relationshipName = `${kindLabel}: de ${sourceAgent.agentName} para ${targetAgent.agentName}${edge.label ? `. ${edge.label}` : ''}`;

              return (
                <li
                  key={edge.id}
                  className="mission-graph__relationship"
                  data-edge-kind={edge.kind}
                  aria-label={relationshipName}
                >
                  <span className="mission-graph__relationship-kind">
                    {kindLabel}
                  </span>
                  <span className="mission-graph__relationship-agents">
                    {sourceAgent.agentName}
                    <span aria-hidden="true"> → </span>
                    {targetAgent.agentName}
                  </span>
                  {edge.label ? (
                    <span className="mission-graph__relationship-label">
                      {edge.label}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <aside
        className="mission-graph__legend"
        aria-label="Legenda das relações entre agentes"
      >
        <p className="mission-graph__legend-title">Legenda</p>
        <ul className="mission-graph__legend-list">
          {EDGE_KINDS.map((kind) => (
            <li
              key={kind}
              className="mission-graph__legend-item"
              data-edge-kind={kind}
            >
              <span
                className="mission-graph__legend-line"
                aria-hidden="true"
              />
              <span className="mission-graph__legend-label">
                {EDGE_KIND_LABELS[kind]}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </section>
  );
}
