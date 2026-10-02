import type { CSSProperties } from 'react';
import type {
  MissionAgentSnapshot,
  MissionEdge,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { MissionAgentCard } from './MissionAgentCard';
import { ActionCard, EmptyState } from '../ActionCard';
import {
  CORE_HEIGHT,
  CORE_WIDTH,
  RACK_HEIGHT,
  RACK_WIDTH,
  layoutCables,
  rackSize,
  type Cable,
  type CablePort,
  type CableSpec,
  type RackBox,
} from './mission-graph-cabling';

const AGENTS_PER_ROW = 4;
const GRAPH_WIDTH = 960;
const COLUMN_STEP = GRAPH_WIDTH / AGENTS_PER_ROW;
/** Espaço vertical dos cabos entre o painel do núcleo e a primeira fileira. */
const CABLE_RUN = 132;
const ROOT_Y = 32 + CORE_HEIGHT / 2;
const FIRST_WORKER_ROW_Y = ROOT_Y + CORE_HEIGHT / 2 + CABLE_RUN + RACK_HEIGHT / 2;
const WORKER_ROW_STEP = RACK_HEIGHT + 84;
const GRAPH_BOTTOM_SPACE = RACK_HEIGHT / 2 + 48;
const MIN_GRAPH_HEIGHT = 240;
/** Uma volta completa de um pacote pelo cabo. */
const PACKET_DURATION_S = 3.2;
const JACK_LONG = 12;
const JACK_SHORT = 7;

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
  readonly onOpenAgentPane?: (paneId: string) => void;
  readonly onRetry: () => void;
}

interface PositionedEdge {
  readonly edge: MissionEdge;
  readonly sourceAgent: MissionAgentSnapshot;
  readonly targetAgent: MissionAgentSnapshot;
}

type GraphSurfaceStyle = CSSProperties & {
  readonly '--mission-graph-width': string;
  readonly '--mission-graph-height': string;
  readonly '--mission-rack-width': string;
  readonly '--mission-rack-height': string;
  readonly '--mission-core-width': string;
  readonly '--mission-core-height': string;
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
    const sourceAgent = agents.get(edge.sourceAgentId);
    const targetAgent = agents.get(edge.targetAgentId);
    if (
      !positions.has(edge.sourceAgentId) ||
      !positions.has(edge.targetAgentId) ||
      !sourceAgent ||
      !targetAgent
    ) {
      continue;
    }
    visibleEdges.push({ edge, sourceAgent, targetAgent });
  }
  return visibleEdges;
}

function jackRect(port: CablePort): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  const vertical = port.side === 'top' || port.side === 'bottom';
  const width = vertical ? JACK_LONG : JACK_SHORT;
  const height = vertical ? JACK_SHORT : JACK_LONG;
  return { x: port.x - width / 2, y: port.y - height / 2, width, height };
}

function CablePackets({ cable }: { readonly cable: Cable }) {
  return (
    <g className="mission-graph__packets" aria-hidden="true">
      {cable.glyphs.map((glyph, index) => {
        const chipWidth = glyph.length * 6 + 10;
        return (
          <g key={index} className="mission-graph__packet">
            <rect
              className="mission-graph__packet-chip"
              x={-chipWidth / 2}
              y={-7}
              width={chipWidth}
              height={14}
              rx={3}
            />
            <text
              className="mission-graph__packet-glyph"
              textAnchor="middle"
              dominantBaseline="central"
            >
              {glyph}
            </text>
            <animateMotion
              dur={`${PACKET_DURATION_S}s`}
              begin={`${-index * (PACKET_DURATION_S / cable.glyphs.length)}s`}
              repeatCount="indefinite"
              path={cable.d}
            />
          </g>
        );
      })}
    </g>
  );
}

export function MissionGraph({
  snapshot,
  selectedAgentId,
  onSelectAgent,
  onOpenAgentPane,
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
          title="Nenhum agente na missão ainda"
          body={
            <p>
              Os agentes aparecem aqui quando o orquestrador abre panes para
              esta missão.
            </p>
          }
          action={
            <ActionCard
              className="mission-graph__retry"
              size="sm"
              variant="primary"
              title="Atualizar"
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
    '--mission-rack-width': `${RACK_WIDTH}px`,
    '--mission-rack-height': `${RACK_HEIGHT}px`,
    '--mission-core-width': `${CORE_WIDTH}px`,
    '--mission-core-height': `${CORE_HEIGHT}px`,
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
  const boxes = new Map<string, RackBox>();
  for (const position of layout) {
    const agent = agentsById.get(position.agentId);
    if (!agent) continue;
    boxes.set(position.agentId, { ...position, ...rackSize(agent) });
  }
  const specs: readonly CableSpec[] =
    edges.length > 0
      ? edges.map(({ edge }) => ({
          id: edge.id,
          kind: edge.kind,
          label: edge.label,
          sourceAgentId: edge.sourceAgentId,
          targetAgentId: edge.targetAgentId,
        }))
      : layout.slice(1).map((target) => ({
          id: `topology-${layout[0].agentId}-${target.agentId}`,
          kind: 'topology' as const,
          sourceAgentId: layout[0].agentId,
          targetAgentId: target.agentId,
        }));
  const cables = layoutCables({
    specs,
    boxes,
    agents: agentsById,
    missionState: snapshot.state,
  });

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
          {cables.map((cable) => (
            <g
              key={cable.id}
              className="mission-graph__cable-group"
              data-edge-kind={cable.kind}
              data-edge-live={cable.live ? 'true' : 'false'}
              data-worker-state={cable.workerState}
            >
              <path className="mission-graph__cable" d={cable.d} />
              <path
                className={`mission-graph__edge mission-graph__edge--${cable.kind}`}
                d={cable.d}
                data-edge-id={cable.id}
                data-edge-kind={cable.kind}
                data-edge-label={cable.label}
                vectorEffect="non-scaling-stroke"
              />
              <path
                className="mission-graph__edge-signal"
                d={cable.d}
                data-edge-signal-for={cable.id}
                vectorEffect="non-scaling-stroke"
              />
              {cable.live ? <CablePackets cable={cable} /> : null}
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
                onSelectAgent={(agentId) => {
                  onSelectAgent(agentId);
                  const paneId = agent.paneId;
                  if (paneId) onOpenAgentPane?.(paneId);
                }}
              />
            );
          })}
        </div>

        <svg
          className="mission-graph__jacks"
          viewBox={`0 0 ${GRAPH_WIDTH} ${height}`}
          width="100%"
          height="100%"
          aria-hidden="true"
          focusable="false"
        >
          {cables.flatMap((cable) =>
            [cable.source, cable.target].map((port, end) => {
              const rect = jackRect(port);
              return (
                <rect
                  key={`${cable.id}-${end}`}
                  className="mission-graph__jack"
                  data-edge-kind={cable.kind}
                  data-edge-live={cable.live ? 'true' : 'false'}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  rx={2}
                />
              );
            }),
          )}
        </svg>
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
          <li className="mission-graph__legend-item mission-graph__legend-item--live">
            <span
              className="mission-graph__legend-line mission-graph__legend-line--live"
              aria-hidden="true"
            />
            <span className="mission-graph__legend-label">
              Pacotes no cabo: agente trabalhando agora
            </span>
          </li>
        </ul>
      </aside>
    </section>
  );
}
