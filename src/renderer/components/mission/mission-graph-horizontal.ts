import type { MissionAgentSnapshot } from '../../../shared/mission-engine-contract';
import {
  CABLE_BRANCH_SPACING,
  CABLE_PACKET_BAND_SPACING,
  RACK_WIDTH,
  rackSize,
  type CableSpec,
  type RackBox,
} from './mission-graph-cabling';

const CROSS_AXIS = 960;
const PER_COLUMN = 4;

/** Only forward delegation/dependency edges define layers; deliveries are feedback. */
export function layoutHorizontalMissionGraph(
  agents: readonly MissionAgentSnapshot[],
  relations: readonly CableSpec[] = [],
): readonly RackBox[] {
  if (!agents.length) return [];
  const root =
    agents.find((agent) => agent.category === 'orchestrator') ?? agents[0];
  const workers = agents.filter((agent) => agent.id !== root.id);
  const ids = new Set(agents.map((agent) => agent.id));
  const forward = relations.filter(
    (edge) =>
      (edge.kind === 'delegation' || edge.kind === 'dependency') &&
      ids.has(edge.sourceAgentId) &&
      ids.has(edge.targetAgentId) &&
      edge.sourceAgentId !== edge.targetAgentId &&
      edge.targetAgentId !== root.id,
  );
  const levels = new Map([[root.id, 0]]);
  const pending = new Set(workers.map((agent) => agent.id));
  while (pending.size) {
    let progressed = false;
    for (const agent of workers) {
      if (!pending.has(agent.id)) continue;
      const parents = forward
        .filter((edge) => edge.targetAgentId === agent.id)
        .map((edge) => edge.sourceAgentId);
      if (parents.some((id) => !levels.has(id))) continue;
      levels.set(
        agent.id,
        Math.max(0, ...parents.map((id) => levels.get(id)!)) + 1,
      );
      pending.delete(agent.id);
      progressed = true;
    }
    // A historical cycle remains inspectable, without inventing an execution order.
    if (!progressed) {
      for (const id of pending) levels.set(id, 1);
      break;
    }
  }
  const columns: MissionAgentSnapshot[][] = [];
  for (const level of [
    ...new Set(workers.map((agent) => levels.get(agent.id)!)),
  ].sort((a, b) => a - b)) {
    const layer = workers.filter((agent) => levels.get(agent.id) === level);
    for (let i = 0; i < layer.length; i += PER_COLUMN)
      columns.push(layer.slice(i, i + PER_COLUMN));
  }
  const columnById = new Map([
    [root.id, -1],
    ...columns.flatMap((column, index) =>
      column.map((agent) => [agent.id, index] as const),
    ),
  ]);
  const visible = relations.filter(
    (edge) =>
      columnById.has(edge.sourceAgentId) &&
      columnById.has(edge.targetAgentId) &&
      edge.sourceAgentId !== edge.targetAgentId,
  );
  const specs = visible.length
    ? visible
    : workers.map((agent) => ({
        sourceAgentId: root.id,
        targetAgentId: agent.id,
      }));
  const outgoing = new Map<number, number>(),
    incoming = new Map<number, number>();
  for (const spec of specs) {
    const a = columnById.get(spec.sourceAgentId)!,
      b = columnById.get(spec.targetAgentId)!;
    if (a === b) continue;
    outgoing.set(Math.min(a, b), (outgoing.get(Math.min(a, b)) ?? 0) + 1);
    incoming.set(Math.max(a, b), (incoming.get(Math.max(a, b)) ?? 0) + 1);
  }
  const size = rackSize(root);
  const coreHeight =
    root.category === 'orchestrator'
      ? Math.min(
          CROSS_AXIS - 64,
          Math.max(size.height, (outgoing.get(-1) ?? 0) * 12 + 60),
        )
      : size.height;
  const positions: RackBox[] = [
    {
      agentId: root.id,
      x: 32 + size.width / 2,
      y: CROSS_AXIS / 2,
      ...size,
      height: coreHeight,
    },
  ];
  let right = 32 + size.width;
  columns.forEach((column, index) => {
    const gap = Math.max(
      132,
      specs.length > 4
        ? (outgoing.get(index - 1) ?? 0) * CABLE_BRANCH_SPACING +
            (incoming.get(index) ?? 0) * CABLE_PACKET_BAND_SPACING +
            112
        : 0,
    );
    const x = right + gap + RACK_WIDTH / 2;
    column.forEach((agent, row) =>
      positions.push({
        agentId: agent.id,
        x,
        y:
          (CROSS_AXIS - (column.length - 1) * (CROSS_AXIS / PER_COLUMN)) / 2 +
          row * (CROSS_AXIS / PER_COLUMN),
        ...rackSize(agent),
      }),
    );
    right = x + RACK_WIDTH / 2;
  });
  return positions;
}
