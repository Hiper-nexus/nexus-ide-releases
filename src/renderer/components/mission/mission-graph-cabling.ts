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
/** Passo nominal dos fios; escala com a densidade nos gutters de 960px. */
export const CABLE_LANE_SPACING = 8;
/** Chips de 14px de altura + folga nas bandas horizontais entre fileiras. */
export const CABLE_PACKET_BAND_SPACING = 20;
const CABLE_CANVAS_WIDTH = 960;
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

export type GraphOrientation = 'vertical' | 'horizontal';

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
  /** A borda externa pode ampliar o canvas, sem recortar cabos/pacotes. */
  readonly extent?: { readonly right: number; readonly bottom: number };
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
  source: Pick<MissionAgentSnapshot, 'state' | 'terminalLive'>,
  target: Pick<MissionAgentSnapshot, 'state' | 'terminalLive'>,
): boolean {
  if (!LIVE_MISSION_STATES.has(missionState)) return false;
  const worker = cableWorkerEnd(kind, source, target);
  return worker.state === 'working' && worker.terminalLive !== false;
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
  readonly routes: CablePoint[][];
  readonly verticalRuns: Map<number, [number, number][]>;
  readonly horizontalRuns: Map<number, [number, number][]>;
  readonly lanes: (readonly [CablePoint, CablePoint])[];
  readonly packetLanes: (readonly [CablePoint, CablePoint])[];
  readonly pitch: number;
  readonly rootY: number;
  readonly segmentClear: (a: CablePoint, b: CablePoint) => boolean;
}

/** Candidatos únicos e retângulos compartilhados por toda a renderização. */
function routingGeometry(boxes: readonly RackBox[], count: number): RoutingGeometry {
  const pitch = Math.min(CABLE_LANE_SPACING, 64 / Math.max(1, count));
  const tracks = (axis: 'x' | 'y', size: 'width' | 'height') => {
    const edges = [...new Set([...(axis === 'x' ? [0, CABLE_CANVAS_WIDTH] : []),
      ...boxes.flatMap((box) => [box[axis] - box[size] / 2, box[axis] + box[size] / 2]),
    ])].sort((a, b) => a - b);
    const positions = new Set(edges.flatMap((edge) => [edge - 8, edge + 8]));
    const step = axis === 'x' ? pitch : CABLE_PACKET_BAND_SPACING;
    for (let i = 1; i < edges.length; i++) {
      for (let n = edges[i - 1]! + 4; n <= edges[i]! - 4; n += step) {
        positions.add(Math.round(n * 1000) / 1000);
      }
    }
    return [...positions].filter((n) => n >= 4 && (axis !== 'x' || n <= CABLE_CANVAS_WIDTH - 4)).sort((a, b) => a - b);
  };
  const xBoxes = new Map<number, readonly RackBox[]>();
  const yBoxes = new Map<number, readonly RackBox[]>();
  const segmentClear = (a: CablePoint, b: CablePoint) => {
    const vertical = a.x === b.x;
    const coordinate = vertical ? a.x : a.y;
    const cache = vertical ? xBoxes : yBoxes;
    let candidates = cache.get(coordinate);
    if (!candidates) {
      candidates = boxes.filter((box) => vertical
        ? coordinate >= box.x - box.width / 2 - 6 && coordinate <= box.x + box.width / 2 + 6
        : coordinate >= box.y - box.height / 2 - 6 && coordinate <= box.y + box.height / 2 + 6);
      cache.set(coordinate, candidates);
    }
    return candidates.every((box) => !overlapsBox(a, b, box));
  };
  return { boxes, xs: tracks('x', 'width'), ys: tracks('y', 'height'),
    routes: [], verticalRuns: new Map(), horizontalRuns: new Map(), lanes: [], packetLanes: [], segmentClear, pitch, rootY: Math.min(...boxes.map((box) => box.y)) };
}

function intervalOverlap(a: number, b: number, c: number, d: number): number {
  return Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d));
}

/** Só segmentos no mesmo eixo/coordenada podem coincidir: consulta indexada. */
function runIsFree(geometry: RoutingGeometry, a: CablePoint, b: CablePoint): boolean {
  const vertical = a.x === b.x;
  const runs = (vertical ? geometry.verticalRuns : geometry.horizontalRuns).get(vertical ? a.x : a.y) ?? [];
  return runs.every(([start, end]) => intervalOverlap(vertical ? a.y : a.x,
    vertical ? b.y : b.x, start, end) <= 12);
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
  sourceRank: number,
  targetRank: number,
  dense: boolean,
  workerSource: boolean,
): Pick<Cable, 'd' | 'packetPath' | 'extent'> {
  const { boxes, routes, lanes } = geometry;
  const obstacles = boxes.filter((box) =>
    box.agentId !== sourceAgentId && box.agentId !== targetAgentId,
  );
  // O casco convexo dos controles contém toda a curva: só é liberada se livre.
  const curve = cablePath(source, target);
  if (!dense) {
    const n = curve.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const xs = n.filter((_, i) => i % 2 === 0);
    const ys = n.filter((_, i) => i % 2 === 1);
    const a = { x: Math.min(...xs), y: Math.min(...ys) };
    const b = { x: Math.max(...xs), y: Math.max(...ys) };
    if (!obstacles.some((box) => overlapsBox(a, b, box))) return { d: curve };
  }
  const lead = (port: CablePort, rank: number, id: string): CablePoint => {
    const spacing = boxes.find((box) => box.agentId === id)!.y === geometry.rootY
      ? CABLE_BRANCH_SPACING : CABLE_PACKET_BAND_SPACING;
    const offset = 12 + (dense ? rank * spacing : 0);
    return {
      x: port.x + (port.side === 'right' ? offset : port.side === 'left' ? -offset : 0),
      y: port.y + (port.side === 'bottom' ? offset : port.side === 'top' ? -offset : 0),
    };
  };
  const start = lead(source, sourceRank, sourceAgentId);
  const end = lead(target, targetRank, targetAgentId);
  const vertical = source.side === 'top' || source.side === 'bottom';
  let route: CablePoint[] | undefined;
  let shortest = Infinity;
  const packetEnds = (points: readonly CablePoint[]): readonly [CablePoint, CablePoint] => workerSource
    ? [points[1]!, points[2]!] : [points[points.length - 3]!, points[points.length - 2]!];
  const packetOverlap = (a: CablePoint, b: CablePoint, c: CablePoint, d: CablePoint) =>
    Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + 7 > Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) - 7 &&
    Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + 14 > Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) - 14;
  if (!obstacles.every((box) => !overlapsBox(source, start, box) && !overlapsBox(end, target, box))) {
    throw new Error(`No safe cable exit: ${sourceAgentId} -> ${targetAgentId}`);
  }
  const accept = (points: CablePoint[]) => {
    if (points.some((point) => point.x < 4 || point.x > CABLE_CANVAS_WIDTH - 4)) return false;
    const [p, q] = packetEnds(points);
    if (dense && Math.abs(p.x - q.x) + Math.abs(p.y - q.y) < 96) return false;
    for (let i = 1; i < points.length - 2; i++) {
      if (!geometry.segmentClear(points[i]!, points[i + 1]!)) return false;
    }
    if (geometry.packetLanes.some(([c, d]) => packetOverlap(p, q, c, d))) return false;
    const a = points[2]!;
    const b = points[3]!;
    if (lanes.some(([c, d]) => a.x === b.x
      ? c.x === d.x && Math.abs(a.x - c.x) + 0.001 < geometry.pitch && intervalOverlap(a.y, b.y, c.y, d.y) > 0
      : c.y === d.y && Math.abs(a.y - c.y) + 0.001 < geometry.pitch && intervalOverlap(a.x, b.x, c.x, d.x) > 0)) return false;
    return points.slice(1).every((point, i) => runIsFree(geometry, points[i]!, point));
  };
  const stubLength = Math.abs(source.x - start.x) + Math.abs(source.y - start.y) +
    Math.abs(target.x - end.x) + Math.abs(target.y - end.y);
  const spineLength = vertical ? Math.abs(start.y - end.y) : Math.abs(start.x - end.x);
  for (const track of vertical ? geometry.xs : geometry.ys) {
    const length = stubLength + spineLength + (vertical
      ? Math.abs(start.x - track) + Math.abs(end.x - track)
      : Math.abs(start.y - track) + Math.abs(end.y - track));
    if (length >= shortest) continue;
    if (dense && (vertical ? Math.abs((workerSource ? start.x : end.x) - track)
      : Math.abs((workerSource ? start.y : end.y) - track)) < 96) continue;
    const a = vertical ? { x: track, y: start.y } : { x: start.x, y: track };
    const b = vertical ? { x: track, y: end.y } : { x: end.x, y: track };
    if (!geometry.segmentClear(a, b)) continue;
    const points = [source, start, a, b, end, target];
    if (!accept(points)) continue;
    shortest = length;
    route = points;
  }
  if (!route) {
    // Fallback dentro das bordas: tenta as bandas livres entre/abaixo dos racks.
    const bottom = Math.max(...boxes.map((box) => box.y + box.height / 2),
      ...routes.flatMap((prior) => prior.map((point) => point.y)));
    for (const y of [...geometry.ys, bottom + CABLE_PACKET_BAND_SPACING]) {
      const points = [source, start, { x: start.x, y }, { x: end.x, y }, end, target];
      if (!accept(points)) continue;
      route = points;
      break;
    }
  }
  // Geometria impossível não vira uma curva que atravessa cards silenciosamente.
  if (!route) throw new Error(`No safe cable route: ${sourceAgentId} -> ${targetAgentId}`);
  routes.push(route);
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const vertical = a.x === b.x;
    const index = vertical ? geometry.verticalRuns : geometry.horizontalRuns;
    const coordinate = vertical ? a.x : a.y;
    const runs = index.get(coordinate) ?? [];
    runs.push(vertical ? [a.y, b.y] : [a.x, b.x]);
    index.set(coordinate, runs);
  }
  const a = route[2]!;
  const b = route[3]!;
  lanes.push([a, b]);
  const [p, q] = packetEnds(route);
  const dx = Math.sign(q.x - p.x) * 16;
  const dy = Math.sign(q.y - p.y) * 16;
  const packetPoints = [{ x: p.x + dx, y: p.y + dy }, { x: q.x - dx, y: q.y - dy }] as const;
  geometry.packetLanes.push(packetPoints);
  const packetPath = Math.abs(p.x - q.x) + Math.abs(p.y - q.y) >= 96 ? pathThrough(packetPoints) : undefined;
  return { d: pathThrough(route), packetPath,
    extent: { right: CABLE_CANVAS_WIDTH,
      bottom: Math.max(...route.map((point) => point.y)) + 32 } };

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
  readonly orientation?: GraphOrientation;
}): readonly Cable[] {
  if (input.orientation === 'horizontal') {
    // Route against the same verified corridors on a transposed geometric canvas.
    // Cards and packet glyphs remain upright; only points and port faces swap axes.
    const boxes = new Map([...input.boxes].map(([id, box]) => [id, {
      ...box, x: box.y, y: box.x, width: box.height, height: box.width,
    }]));
    const sides: Readonly<Record<PortSide, PortSide>> = { top: 'left', bottom: 'right', left: 'top', right: 'bottom' };
    const transposePath = (path: string): string => {
      const values = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      let index = 0;
      return path.replace(/-?\d+(?:\.\d+)?/g, () => String(values[index++ ^ 1]));
    };
    const transposePort = (port: CablePort): CablePort => ({ x: port.y, y: port.x, side: sides[port.side] });
    return layoutCables({ ...input, boxes, orientation: 'vertical' }).map(cable => ({
      ...cable, source: transposePort(cable.source), target: transposePort(cable.target),
      d: transposePath(cable.d), packetPath: cable.packetPath ? transposePath(cable.packetPath) : undefined,
      extent: cable.extent ? { right: cable.extent.bottom, bottom: cable.extent.right } : undefined,
    }));
  }
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

  const ranks = usable.map(() => ({ source: 0, target: 0 }));
  const channels = new Map<string, Attachment[]>();
  ports.forEach((ends, cableIndex) => {
    for (const end of ['source', 'target'] as const) {
      const port = ends[end]!;
      const vertical = port.side === 'top' || port.side === 'bottom';
      const key = `${port.side}:${vertical ? port.y : port.x}`;
      const channel = channels.get(key) ?? [];
      channel.push({ cableIndex, end, order: vertical ? port.x : port.y });
      channels.set(key, channel);
    }
  });
  for (const channel of channels.values()) {
    channel.sort((a, b) => a.order - b.order || a.cableIndex - b.cableIndex);
    channel.forEach((attachment, rank) => { ranks[attachment.cableIndex]![attachment.end] = rank; });
  }
  const geometry = routingGeometry([...input.boxes.values()], usable.length);
  return usable.map((spec, index) => {
    const source = ports[index]!.source!;
    const target = ports[index]!.target!;
    const sourceAgent = input.agents.get(spec.sourceAgentId)!;
    const targetAgent = input.agents.get(spec.targetAgentId)!;
    let path: Pick<Cable, 'd' | 'packetPath' | 'extent'>;
    try {
      path = routedCablePath(source, target, geometry, spec.sourceAgentId, spec.targetAgentId,
        ranks[index]!.source, ranks[index]!.target, usable.length > 4, cableWorkerEnd(spec.kind, true, false));
    } catch {
      // Sem rota verificada: a curva simples, sem pacotes, mantém o grafo de pé.
      path = { d: cablePath(source, target), packetPath: undefined,
        extent: { right: CABLE_CANVAS_WIDTH, bottom: Math.max(source.y, target.y) + 32 } };
    }
    return {
      ...spec,
      source,
      target,
      ...path,
      live: isCableLive(input.missionState, spec.kind, sourceAgent, targetAgent),
      workerState: cableWorkerEnd(spec.kind, sourceAgent, targetAgent).state,
      glyphs: [packetGlyph(spec.id), packetGlyph(`${spec.id}\u00002`)] as const,
    };
  });
}
