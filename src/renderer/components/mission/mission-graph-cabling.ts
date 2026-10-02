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
  /** Curva do cabo (cubic Bézier) no espaço do canvas. */
  readonly d: string;
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

  return usable.map((spec, index) => {
    const source = ports[index]!.source!;
    const target = ports[index]!.target!;
    const sourceAgent = input.agents.get(spec.sourceAgentId)!;
    const targetAgent = input.agents.get(spec.targetAgentId)!;
    return {
      ...spec,
      source,
      target,
      d: cablePath(source, target),
      live: isCableLive(input.missionState, spec.kind, sourceAgent, targetAgent),
      workerState: cableWorkerEnd(spec.kind, sourceAgent, targetAgent).state,
      glyphs: [packetGlyph(spec.id), packetGlyph(`${spec.id}\u00002`)] as const,
    };
  });
}
