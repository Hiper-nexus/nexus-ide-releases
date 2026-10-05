import type {
  MissionAgentSnapshot,
  MissionEdge,
  MissionLifecycleState,
} from '../../../shared/mission-engine-contract';

/**
 * Sala de racks da missão: cada agente é um rack (o coordenador é o núcleo,
 * mais largo, com o painel de portas embaixo) e cada relação é um cabo que
 * sai de uma porta e entra em outra. Tudo aqui é puro: geometria estática em
 * pixels do canvas, sem física nem estado mutável.
 */

export const RACK_WIDTH = 208;
export const RACK_HEIGHT = 150;
export const CORE_WIDTH = 304;
export const CORE_HEIGHT = 162;
/** Chip máximo de 28px + folga; a capa do cabo mede 7px. */
export const CABLE_LANE_SPACING = 32;
export const CABLE_BRANCH_SPACING = 8;

/** Recuo das portas em relação à quina do rack (o cabo não sai da quina). */
const PORT_INSET_HORIZONTAL = 30;
const PORT_INSET_VERTICAL = 24;
/** Folga mínima entre racks para o cabo sair por cima/baixo e não de lado. */
const VERTICAL_GAP_THRESHOLD = 12;

/** Missão nesses estados tem trabalho correndo pelos cabos. */
const LIVE_MISSION_STATES: ReadonlySet<MissionLifecycleState> = new Set([
  'starting',
  'running',
  'recovering',
]);

/**
 * Tokens que correm pelo cabo vivo. Só forma: dizem "trabalho passando", não
 * carregam conteúdo da missão (nada do texto da tarefa entra no desenho).
 */
export const PACKET_GLYPHS = ['λ', 'fn', '{ }', '0x', '=>', '[ ]', '∑', '01'] as const;

export type CableKind = MissionEdge['kind'] | 'topology';
export type PortSide = 'top' | 'bottom' | 'left' | 'right';

export interface RackBox {
  readonly agentId: string;
  /** Centro do rack no canvas. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CablePort {
  readonly x: number;
  readonly y: number;
  readonly side: PortSide;
}

export interface CableSpec {
  readonly id: string;
  readonly kind: CableKind;
  readonly sourceAgentId: string;
  readonly targetAgentId: string;
  readonly label?: string;
}

export interface Cable extends CableSpec {
  readonly source: CablePort;
  readonly target: CablePort;
  /** Caminho do cabo no canvas: curva livre ou desvio pelos corredores. */
  readonly d: string;
  /** Trecho exclusivo do corredor: glifos não entram no leque de portas. */
  readonly packetPath?: string;
  /** Energia passando: a missão está viva e a ponta de trabalho trabalha. */
  readonly live: boolean;
  /** Estado de quem trabalha na ponta do cabo — pinta o cabo parado. */
  readonly workerState: MissionAgentSnapshot['state'];
  readonly glyphs: readonly [string, string];
}

export function rackSize(
  agent: Pick<MissionAgentSnapshot, 'category'>,
): { readonly width: number; readonly height: number } {
  return agent.category === 'orchestrator'
    ? { width: CORE_WIDTH, height: CORE_HEIGHT }
    : { width: RACK_WIDTH, height: RACK_HEIGHT };
}

/**
 * Ponta "de trabalho" do cabo: quem recebe a delegação (ou a dependência) e
 * quem entrega o handoff ou revisa. É o estado dela que acende o cabo.
 */
export function cableWorkerEnd<T>(kind: CableKind, source: T, target: T): T {
  return kind === 'handoff' || kind === 'review' ? source : target;
}

export function isCableLive(
  missionState: MissionLifecycleState,
  kind: CableKind,
  source: Pick<MissionAgentSnapshot, 'state'>,
  target: Pick<MissionAgentSnapshot, 'state'>,
): boolean {
  if (!LIVE_MISSION_STATES.has(missionState)) return false;
  return cableWorkerEnd(kind, source, target).state === 'working';
}

/** Glifo estável por cabo: o mesmo cabo mostra sempre os mesmos tokens. */
export function packetGlyph(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return PACKET_GLYPHS[hash % PACKET_GLYPHS.length]!;
}

function sidesFor(source: RackBox, target: RackBox): readonly [PortSide, PortSide] {
  const dy = target.y - source.y;
  const verticalGap = Math.abs(dy) - (source.height + target.height) / 2;
  if (verticalGap > VERTICAL_GAP_THRESHOLD) {
    return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  }
  return target.x >= source.x ? ['right', 'left'] : ['left', 'right'];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Posição da i-ésima de n portas num lado do rack, sem encostar na quina. */
function portOn(box: RackBox, side: PortSide, index: number, count: number): CablePort {
  if (side === 'top' || side === 'bottom') {
    const span = Math.max(0, box.width - PORT_INSET_HORIZONTAL * 2);
    const x = box.x - span / 2 + (span * (index + 0.5)) / count;
    const y = box.y + (side === 'bottom' ? box.height / 2 : -box.height / 2);
    return { x: round(x), y: round(y), side };
  }
  const span = Math.max(0, box.height - PORT_INSET_VERTICAL * 2);
  const y = box.y - span / 2 + (span * (index + 0.5)) / count;
  const x = box.x + (side === 'right' ? box.width / 2 : -box.width / 2);
  return { x: round(x), y: round(y), side };
}

/**
 * Curva de cabo: sai da porta na direção do lado (vertical para cima/baixo,
 * horizontal com barriga para os lados) e entra na outra porta do mesmo jeito.
 */
export function cablePath(source: CablePort, target: CablePort): string {
  if (source.side === 'top' || source.side === 'bottom') {
    const direction = source.side === 'bottom' ? 1 : -1;
    const reach = Math.max(36, Math.abs(target.y - source.y) * 0.5);
    return (
      `M ${source.x} ${source.y} ` +
      `C ${source.x} ${round(source.y + direction * reach)} ` +
      `${target.x} ${round(target.y - direction * reach)} ` +
      `${target.x} ${target.y}`
    );
  }
  const direction = source.side === 'right' ? 1 : -1;
  const span = Math.abs(target.x - source.x);
  const reach = Math.max(32, span * 0.45);
  const sag = round(Math.min(64, 18 + span * 0.12));
  return (
    `M ${source.x} ${source.y} ` +
    `C ${round(source.x + direction * reach)} ${round(source.y + sag)} ` +
    `${round(target.x - direction * reach)} ${round(target.y + sag)} ` +
    `${target.x} ${target.y}`
  );
}

interface Attachment {
  readonly cableIndex: number;
  readonly end: 'source' | 'target';
  /** Coordenada da outra ponta ao longo do lado (ordena para não cruzar). */
  readonly order: number;
}

type CablePoint = Pick<CablePort, 'x' | 'y'>;

/** Retângulo conservador do segmento; nos desvios os segmentos são ortogonais. */
function overlapsBox(a: CablePoint, b: CablePoint, box: RackBox, clearance = 6): boolean {
  return Math.max(a.x, b.x) >= box.x - box.width / 2 - clearance &&
    Math.min(a.x, b.x) <= box.x + box.width / 2 + clearance &&
    Math.max(a.y, b.y) >= box.y - box.height / 2 - clearance &&
    Math.min(a.y, b.y) <= box.y + box.height / 2 + clearance;
}

interface RoutingGeometry {
  readonly boxes: readonly RackBox[];
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly rootY: number;
  readonly routes: CablePoint[][];
  readonly lanes: (readonly [CablePoint, CablePoint])[];
}

/** Candidatos únicos e retângulos compartilhados por toda a renderização. */
function routingGeometry(boxes: readonly RackBox[]): RoutingGeometry {
  const tracks = (axis: 'x' | 'y', size: 'width' | 'height') => {
    const edges = [...new Set(boxes.flatMap((box) =>
      [box[axis] - box[size] / 2, box[axis] + box[size] / 2],
    ))].sort((a, b) => a - b);
    const positions = new Set(edges.flatMap((edge) => [edge - 16, edge + 16]));
    for (let i = 1; i < edges.length; i++) {
      for (let n = edges[i - 1]! + 16; n <= edges[i]! - 16; n += CABLE_LANE_SPACING) {
        positions.add(n);
      }
    }
    return [...positions].sort((a, b) => a - b);
  };
  return { boxes, xs: tracks('x', 'width'), ys: tracks('y', 'height'),
    rootY: Math.min(...boxes.map((box) => box.y)), routes: [], lanes: [] };
}

function intervalOverlap(a: number, b: number, c: number, d: number): number {
  return Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d));
}

function coincidentRun(a: CablePoint, b: CablePoint, c: CablePoint, d: CablePoint): number {
  if (a.x === b.x && c.x === d.x && a.x === c.x) return intervalOverlap(a.y, b.y, c.y, d.y);
  if (a.y === b.y && c.y === d.y && a.y === c.y) return intervalOverlap(a.x, b.x, c.x, d.x);
  return 0;
}

function pathThrough(points: readonly CablePoint[]): string {
  return points.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
}

/** Reserva uma faixa por cabo; os chips percorrem só seu trecho exclusivo. */
function routedCablePath(
  source: CablePort,
  target: CablePort,
  geometry: RoutingGeometry,
  sourceAgentId: string,
  targetAgentId: string,
  index: number,
  dense: boolean,
): Pick<Cable, 'd' | 'packetPath'> {
  const { boxes, routes, lanes } = geometry;
  const obstacles = boxes.filter((box) =>
    box.agentId !== sourceAgentId && box.agentId !== targetAgentId,
  );
  const envelopeEnd = { x: target.x, y: Math.max(source.y, target.y) + 64 };
  const envelopeStart = { x: source.x, y: Math.min(source.y, target.y) };
  if (!dense && !obstacles.some((box) => overlapsBox(envelopeStart, envelopeEnd, box))) {
    return { d: cablePath(source, target) };
  }
  const lead = (port: CablePort, id: string): CablePoint => {
    const root = boxes.find((box) => box.agentId === id)!.y === geometry.rootY;
    const offset = 12 + (dense ? (root ? index : index % 4) * CABLE_BRANCH_SPACING : 0);
    return {
      x: port.x + (port.side === 'right' ? offset : port.side === 'left' ? -offset : 0),
      y: port.y + (port.side === 'bottom' ? offset : port.side === 'top' ? -offset : 0),
    };
  };
  const start = lead(source, sourceAgentId);
  const end = lead(target, targetAgentId);
  const vertical = source.side === 'top' || source.side === 'bottom';
  let route: CablePoint[] | undefined;
  let shortest = Infinity;
  for (const track of vertical ? geometry.xs : geometry.ys) {
    const a = vertical ? { x: track, y: start.y } : { x: start.x, y: track };
    const b = vertical ? { x: track, y: end.y } : { x: end.x, y: track };
    const points = [source, start, a, b, end, target];
    const length = points.slice(1).reduce((total, point, i) =>
      total + Math.abs(point.x - points[i]!.x) + Math.abs(point.y - points[i]!.y), 0);
    if (length >= shortest) continue;
    if (dense && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 88) continue;
    if (lanes.some(([c, d]) => vertical
      ? c.x === d.x && Math.abs(a.x - c.x) < CABLE_LANE_SPACING && intervalOverlap(a.y, b.y, c.y, d.y) > 0
      : c.y === d.y && Math.abs(a.y - c.y) < CABLE_LANE_SPACING && intervalOverlap(a.x, b.x, c.x, d.x) > 0)) continue;
    if (!points.slice(1).every((point, i) =>
      (i === 0 || i === points.length - 2 ? obstacles : boxes).every((box) =>
        !overlapsBox(points[i]!, point, box, 6),
      ) && routes.every((prior) => prior.slice(1).every((other, j) =>
        coincidentRun(points[i]!, point, prior[j]!, other) <= 12,
      )),
    )) continue;
    shortest = length;
    route = points;
  }
  if (!route) return { d: cablePath(source, target) };
  routes.push(route);
  const a = route[2]!;
  const b = route[3]!;
  lanes.push([a, b]);
  const dx = Math.sign(b.x - a.x) * 16;
  const dy = Math.sign(b.y - a.y) * 16;
  const packetPath = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) >= 88
    ? pathThrough([{ x: a.x + dx, y: a.y + dy }, { x: b.x - dx, y: b.y - dy }])
    : undefined;
  return { d: pathThrough(route), packetPath };
}

/**
 * Liga cada relação a uma porta própria: os cabos que chegam no mesmo lado de
 * um rack se espalham pelo painel, ordenados pela posição da outra ponta para
 * não se cruzarem logo na saída.
 */
export function layoutCables(input: {
  readonly specs: readonly CableSpec[];
  readonly boxes: ReadonlyMap<string, RackBox>;
  readonly agents: ReadonlyMap<string, MissionAgentSnapshot>;
  readonly missionState: MissionLifecycleState;
}): readonly Cable[] {
  const usable = input.specs.filter(
    (spec) =>
      spec.sourceAgentId !== spec.targetAgentId &&
      input.boxes.has(spec.sourceAgentId) &&
      input.boxes.has(spec.targetAgentId) &&
      input.agents.has(spec.sourceAgentId) &&
      input.agents.has(spec.targetAgentId),
  );
  const sides = usable.map((spec) =>
    sidesFor(input.boxes.get(spec.sourceAgentId)!, input.boxes.get(spec.targetAgentId)!),
  );
  const attachments = new Map<string, Attachment[]>();
  const attach = (agentId: string, side: PortSide, attachment: Attachment) => {
    const key = `${agentId}\u0000${side}`;
    const list = attachments.get(key) ?? [];
    list.push(attachment);
    attachments.set(key, list);
  };
  usable.forEach((spec, cableIndex) => {
    const [sourceSide, targetSide] = sides[cableIndex]!;
    const source = input.boxes.get(spec.sourceAgentId)!;
    const target = input.boxes.get(spec.targetAgentId)!;
    const along = (side: PortSide, other: RackBox) =>
      side === 'top' || side === 'bottom' ? other.x : other.y;
    attach(spec.sourceAgentId, sourceSide, {
      cableIndex,
      end: 'source',
      order: along(sourceSide, target),
    });
    attach(spec.targetAgentId, targetSide, {
      cableIndex,
      end: 'target',
      order: along(targetSide, source),
    });
  });

  const ports = usable.map(() => ({} as { source?: CablePort; target?: CablePort }));
  for (const [key, list] of attachments) {
    const [agentId, side] = key.split('\u0000') as [string, PortSide];
    const box = input.boxes.get(agentId)!;
    const ordered = [...list].sort(
      (left, right) => left.order - right.order || left.cableIndex - right.cableIndex,
    );
    ordered.forEach((attachment, index) => {
      ports[attachment.cableIndex]![attachment.end] = portOn(
        box,
        side,
        index,
        ordered.length,
      );
    });
  }

  const geometry = routingGeometry([...input.boxes.values()]);
  return usable.map((spec, index) => {
    const source = ports[index]!.source!;
    const target = ports[index]!.target!;
    const sourceAgent = input.agents.get(spec.sourceAgentId)!;
    const targetAgent = input.agents.get(spec.targetAgentId)!;
    return {
      ...spec,
      source,
      target,
      ...routedCablePath(source, target, geometry, spec.sourceAgentId, spec.targetAgentId,
        index, usable.length > 4),
      live: isCableLive(input.missionState, spec.kind, sourceAgent, targetAgent),
      workerState: cableWorkerEnd(spec.kind, sourceAgent, targetAgent).state,
      glyphs: [packetGlyph(spec.id), packetGlyph(`${spec.id}\u00002`)] as const,
    };
  });
}
