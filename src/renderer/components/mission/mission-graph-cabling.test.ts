import { describe, expect, it } from 'vitest';
import type { MissionAgentSnapshot } from '../../../shared/mission-engine-contract';
import {
  CORE_HEIGHT,
  CORE_WIDTH,
  PACKET_GLYPHS,
  RACK_HEIGHT,
  RACK_WIDTH,
  cableWorkerEnd,
  cablePath,
  isCableLive,
  layoutCables,
  packetGlyph,
  rackSize,
  type CableSpec,
  type RackBox,
} from './mission-graph-cabling';
import { layoutMissionGraph } from './MissionGraph';

/** Achatamento da curva apenas no teste, seguido de interseção segmento × retângulo. */
function intersectsCard(d: string, card: RackBox): boolean {
  const numbers = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const points: { x: number; y: number }[] = [];
  if (d.includes('C')) {
    for (let i = 0; i <= 512; i++) {
      const t = i / 512;
      const u = 1 - t;
      points.push({
        x: u ** 3 * numbers[0]! + 3 * u ** 2 * t * numbers[2]! + 3 * u * t ** 2 * numbers[4]! + t ** 3 * numbers[6]!,
        y: u ** 3 * numbers[1]! + 3 * u ** 2 * t * numbers[3]! + 3 * u * t ** 2 * numbers[5]! + t ** 3 * numbers[7]!,
      });
    }
  } else {
    for (let i = 0; i < numbers.length; i += 2) points.push({ x: numbers[i]!, y: numbers[i + 1]! });
  }
  return points.slice(1).some((b, i) => {
    const a = points[i]!;
    let enter = 0;
    let leave = 1;
    for (const [start, delta, min, max] of [
      [a.x, b.x - a.x, card.x - card.width / 2, card.x + card.width / 2],
      [a.y, b.y - a.y, card.y - card.height / 2, card.y + card.height / 2],
    ]) {
      if (delta === 0) {
        if (start < min || start > max) return false;
      } else {
        const t1 = (min - start) / delta;
        const t2 = (max - start) / delta;
        enter = Math.max(enter, Math.min(t1, t2));
        leave = Math.min(leave, Math.max(t1, t2));
      }
    }
    return enter <= leave;
  });
}

function agent(
  id: string,
  overrides: Partial<MissionAgentSnapshot> = {},
): MissionAgentSnapshot {
  return {
    id,
    agentName: id,
    category: 'executor',
    cli: 'codex',
    state: 'working',
    ...overrides,
  } as MissionAgentSnapshot;
}

function box(agentId: string, x: number, y: number, core = false): RackBox {
  return core
    ? { agentId, x, y, width: CORE_WIDTH, height: CORE_HEIGHT }
    : { agentId, x, y, width: RACK_WIDTH, height: RACK_HEIGHT };
}

const delegation = (id: string, from: string, to: string): CableSpec => ({
  id,
  kind: 'delegation',
  sourceAgentId: from,
  targetAgentId: to,
});

function straightSegments(d: string) {
  if (d.includes('C')) return [];
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return Array.from({ length: n.length / 2 - 1 }, (_, i) => ({
    x1: n[i * 2]!, y1: n[i * 2 + 1]!, x2: n[i * 2 + 2]!, y2: n[i * 2 + 3]!,
  }));
}

function sharedRun(a: string, b: string): number {
  let longest = 0;
  for (const s of straightSegments(a)) for (const t of straightSegments(b)) {
    const vertical = s.x1 === s.x2 && t.x1 === t.x2 && s.x1 === t.x1;
    const horizontal = s.y1 === s.y2 && t.y1 === t.y2 && s.y1 === t.y1;
    if (!vertical && !horizontal) continue;
    const [a1, a2, b1, b2] = vertical
      ? [s.y1, s.y2, t.y1, t.y2] : [s.x1, s.x2, t.x1, t.x2];
    longest = Math.max(longest,
      Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)),
    );
  }
  return longest;
}

describe('cabos da sala de racks', () => {
  it.each([[20, 8], [20, 20], [128, 128]])('%i delegações + %i entregas têm faixas e pacotes para todas as relações', (delegations, deliveries) => {
    const all = [agent('orq', { category: 'orchestrator' }),
      ...Array.from({ length: 20 }, (_, i) => agent(`w${i}`))];
    const agents = new Map(all.map((a) => [a.id, a]));
    const specs: CableSpec[] = [
      ...Array.from({ length: delegations }, (_, i) => delegation(`d-${i}`, 'orq', `w${i % 20}`)),
      ...Array.from({ length: deliveries }, (_, i) => ({
        id: `h-${i}`, kind: 'handoff' as const, sourceAgentId: `w${i % 20}`, targetAgentId: 'orq',
      })),
    ];
    const layout = layoutMissionGraph(all, specs);
    const boxes = new Map(layout.map((position) => [position.agentId, position]));
    for (const card of boxes.values()) {
      expect(card.x - card.width / 2).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width / 2).toBeLessThanOrEqual(960);
    }
    const cables = layoutCables({ specs, boxes, agents, missionState: 'running' });
    expect(cables).toHaveLength(delegations + deliveries);
    for (const cable of cables) {
      expect(cable.packetPath, cable.id).toBeDefined();
      for (const card of boxes.values()) {
        if ([cable.sourceAgentId, cable.targetAgentId].includes(card.agentId)) continue;
        expect(intersectsCard(cable.d, card), `${cable.id} × ${card.agentId}`).toBe(false);
      }
    }
    for (let i = 0; i < cables.length; i++) for (let j = i + 1; j < cables.length; j++) {
      expect(sharedRun(cables[i]!.d, cables[j]!.d),
        `${cables[i]!.id} × ${cables[j]!.id}`).toBeLessThanOrEqual(12);
    }
  });
  it('usa corredores verificados de 960px mesmo quando o trecho vertical é curto', () => {
    const agents = new Map([['orq', agent('orq', { category: 'orchestrator' })], ['w', agent('w')]]);
    const boxes = new Map([['orq', box('orq', 480, 113, true)], ['w', box('w', 120, 400)]]);
    const specs = Array.from({ length: 5 }, (_, i) => delegation(`e${i}`, 'orq', 'w'));
    const cables = layoutCables({ agents, boxes, specs, missionState: 'running' });
    expect(cables).toHaveLength(5);
    expect(cables.every((cable) => (cable.extent?.right ?? 960) <= 960)).toBe(true);
    for (const cable of cables) {
      expect(cable.packetPath).toBeDefined();
      for (const card of boxes.values()) {
        const s = straightSegments(cable.d);
        // Inclusive as pontas: somente o primeiro/último segmento toca sua porta.
        const interior = s.slice(1, -1).map((p, i) => `${i ? 'L' : 'M'} ${p.x1} ${p.y1} L ${p.x2} ${p.y2}`).join(' ');
        expect(intersectsCard(interior, card)).toBe(false);
      }
    }
    for (let i = 0; i < cables.length; i++) for (let j = i + 1; j < cables.length; j++) {
      expect(sharedRun(cables[i]!.d, cables[j]!.d)).toBeLessThanOrEqual(12);
    }
  });
  it.each(['delegation', 'handoff', 'topology'] as const)(
    'com 20 helpers vivos, %s não atravessa cards de outras pontas', (kind) => {
      const all = [agent('orq', { category: 'orchestrator' }),
        ...Array.from({ length: 20 }, (_, i) => agent(`w${i}`))];
      const agents = new Map(all.map((a) => [a.id, a]));
      const boxes = new Map(layoutMissionGraph(all).map((position) => [
        position.agentId, { ...position, ...rackSize(agents.get(position.agentId)!) },
      ]));
      const specs = all.slice(1).map((a) => ({
        id: `e-${a.id}`, kind,
        sourceAgentId: kind === 'handoff' ? a.id : 'orq',
        targetAgentId: kind === 'handoff' ? 'orq' : a.id,
      }));
      const cables = layoutCables({ specs, boxes, agents, missionState: 'running' });
      expect(cables).toHaveLength(20);
      for (let i = 0; i < cables.length; i++) {
        for (let j = i + 1; j < cables.length; j++) {
          expect(sharedRun(cables[i]!.d, cables[j]!.d),
            `${cables[i]!.id} × ${cables[j]!.id}`).toBeLessThanOrEqual(12);
        }
      }
      const packetBounds = cables.map((cable) => {
        expect(cable).toHaveProperty('packetPath');
        const path = (cable as { packetPath?: string }).packetPath ?? cable.d;
        const segments = straightSegments(path);
        expect(segments).toHaveLength(1);
        const s = segments[0]!;
        // Maior chip existente: 28 × 14 px; duas fichas separadas por meia volta.
        expect(Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1)).toBeGreaterThanOrEqual(56);
        return { left: Math.min(s.x1, s.x2) - 14, right: Math.max(s.x1, s.x2) + 14,
          top: Math.min(s.y1, s.y2) - 7, bottom: Math.max(s.y1, s.y2) + 7 };
      });
      for (let i = 0; i < packetBounds.length; i++) for (let j = i + 1; j < packetBounds.length; j++) {
        const a = packetBounds[i]!;
        const b = packetBounds[j]!;
        expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
          `glifos ${cables[i]!.id} × ${cables[j]!.id}`).toBe(true);
      }
      let oldCrossings = 0;
      for (const cable of cables) {
        expect(cable.live).toBe(true);
        for (const card of boxes.values()) {
          if ([cable.sourceAgentId, cable.targetAgentId].includes(card.agentId)) continue;
          if (intersectsCard(cablePath(cable.source, cable.target), card)) oldCrossings++;
          expect(intersectsCard(cable.d, card), `${cable.id} × ${card.agentId}`).toBe(false);
        }
      }
      // A mesma geometria com o cabo direto reproduz o defeito original.
      expect(oldCrossings).toBeGreaterThan(0);
    },
  );
  it('o coordenador é o núcleo, mais largo; os outros são racks', () => {
    expect(rackSize({ category: 'orchestrator' })).toEqual({ width: CORE_WIDTH, height: CORE_HEIGHT });
    expect(rackSize({ category: 'executor' })).toEqual({ width: RACK_WIDTH, height: RACK_HEIGHT });
  });

  it('a ponta de trabalho é quem recebe a delegação e quem entrega ou revisa', () => {
    expect(cableWorkerEnd('delegation', 'orq', 'worker')).toBe('worker');
    expect(cableWorkerEnd('dependency', 'a', 'b')).toBe('b');
    expect(cableWorkerEnd('topology', 'orq', 'worker')).toBe('worker');
    expect(cableWorkerEnd('handoff', 'worker', 'orq')).toBe('worker');
    expect(cableWorkerEnd('review', 'revisor', 'autor')).toBe('revisor');
  });

  it('energia só passa com a missão viva e a ponta de trabalho trabalhando', () => {
    const working = { state: 'working' as const };
    const done = { state: 'done' as const };
    expect(isCableLive('running', 'delegation', done, working)).toBe(true);
    expect(isCableLive('starting', 'delegation', done, working)).toBe(true);
    expect(isCableLive('recovering', 'delegation', done, working)).toBe(true);
    // Missão parada ou concluída: cabo quieto, mesmo com o agente marcado working.
    expect(isCableLive('completed', 'delegation', done, working)).toBe(false);
    expect(isCableLive('blocked_user', 'delegation', done, working)).toBe(false);
    // O estado que vale é o da ponta de trabalho.
    expect(isCableLive('running', 'delegation', working, done)).toBe(false);
    expect(isCableLive('running', 'handoff', working, done)).toBe(true);
  });

  it('os pacotes são só forma: glifo estável por cabo, nunca texto da missão', () => {
    expect(packetGlyph('e1')).toBe(packetGlyph('e1'));
    for (const seed of ['e1', 'e2', 'topology-a-b', 'missão secreta']) {
      expect(PACKET_GLYPHS).toContain(packetGlyph(seed));
    }
  });

  it('do núcleo para a fileira de baixo: sai pelo painel de portas e entra no topo do rack', () => {
    const agents = new Map([
      ['orq', agent('orq', { category: 'orchestrator' })],
      ['w1', agent('w1')],
    ]);
    const boxes = new Map([
      ['orq', box('orq', 480, 113, true)],
      ['w1', box('w1', 120, 400)],
    ]);
    const [cable] = layoutCables({
      specs: [delegation('e1', 'orq', 'w1')],
      boxes,
      agents,
      missionState: 'running',
    });
    expect(cable.source.side).toBe('bottom');
    expect(cable.source.y).toBe(113 + CORE_HEIGHT / 2);
    expect(cable.target.side).toBe('top');
    expect(cable.target.y).toBe(400 - RACK_HEIGHT / 2);
    expect(cable.d.startsWith(`M ${cable.source.x} ${cable.source.y} `)).toBe(true);
    expect(cable.d.endsWith(` ${cable.target.x} ${cable.target.y}`)).toBe(true);
    expect(cable.live).toBe(true);
    expect(cable.workerState).toBe('working');
    expect(cable.glyphs).toHaveLength(2);
  });

  it('cabos no mesmo lado se espalham pelo painel na ordem da outra ponta, sem cruzar na saída', () => {
    const ids = ['w1', 'w2', 'w3', 'w4'];
    const agents = new Map<string, MissionAgentSnapshot>([
      ['orq', agent('orq', { category: 'orchestrator' })],
      ...ids.map((id) => [id, agent(id)] as const),
    ]);
    const boxes = new Map<string, RackBox>([
      ['orq', box('orq', 480, 113, true)],
      // Fora de ordem de propósito: a ordem das portas segue o x da outra ponta.
      ['w3', box('w3', 600, 420)],
      ['w1', box('w1', 120, 420)],
      ['w4', box('w4', 840, 420)],
      ['w2', box('w2', 360, 420)],
    ]);
    const cables = layoutCables({
      specs: ['w3', 'w1', 'w4', 'w2'].map((id) => delegation(`e-${id}`, 'orq', id)),
      boxes,
      agents,
      missionState: 'running',
    });
    const portX = (id: string) => cables.find((c) => c.targetAgentId === id)!.source.x;
    expect(portX('w1')).toBeLessThan(portX('w2'));
    expect(portX('w2')).toBeLessThan(portX('w3'));
    expect(portX('w3')).toBeLessThan(portX('w4'));
    // As portas ficam dentro do painel, longe das quinas.
    for (const c of cables) {
      expect(c.source.x).toBeGreaterThan(480 - CORE_WIDTH / 2);
      expect(c.source.x).toBeLessThan(480 + CORE_WIDTH / 2);
    }
  });

  it('racks lado a lado se ligam pelas laterais', () => {
    const agents = new Map([
      ['a', agent('a')],
      ['b', agent('b', { state: 'done' })],
    ]);
    const boxes = new Map([
      ['a', box('a', 120, 400)],
      ['b', box('b', 360, 400)],
    ]);
    const [cable] = layoutCables({
      specs: [{ id: 'r', kind: 'review', sourceAgentId: 'b', targetAgentId: 'a' }],
      boxes,
      agents,
      missionState: 'running',
    });
    expect(cable.source.side).toBe('left');
    expect(cable.target.side).toBe('right');
    // Revisão: a ponta de trabalho é o revisor (b, concluído) — cabo quieto.
    expect(cable.live).toBe(false);
    expect(cable.workerState).toBe('done');
  });

  it('relação com agente fora do canvas ou de um agente com ele mesmo não vira cabo', () => {
    const agents = new Map([['a', agent('a')], ['b', agent('b')]]);
    const boxes = new Map([['a', box('a', 120, 400)], ['b', box('b', 360, 400)]]);
    const cables = layoutCables({
      specs: [
        delegation('ok', 'a', 'b'),
        delegation('self', 'a', 'a'),
        delegation('ghost', 'a', 'sumiu'),
      ],
      boxes,
      agents,
      missionState: 'running',
    });
    expect(cables.map((c) => c.id)).toEqual(['ok']);
  });
});

describe('cabo sem rota segura', () => {
  it('degrada para a curva simples em vez de derrubar o grafo', () => {
    // Rack cercado por quatro vizinhos encostados: nenhuma porta tem saída livre.
    const w = RACK_WIDTH;
    const h = RACK_HEIGHT;
    const boxes = new Map<string, RackBox>([
      ['root', box('root', 480, 60, true)],
      ['inner', box('inner', 480, 400)],
      ['n', box('n', 480, 400 - h)],
      ['s', box('s', 480, 400 + h)],
      ['w', box('w', 480 - w, 400)],
      ['e', box('e', 480 + w, 400)],
    ]);
    const agents = new Map([...boxes.keys()].map((id) => [id, agent(id)] as const));
    const specs = [delegation('blocked', 'root', 'inner')];
    const cables = layoutCables({ specs, boxes, agents, missionState: 'running' });
    expect(cables).toHaveLength(1);
    expect(cables[0]!.d).toMatch(/^M/);
    expect(cables[0]!.packetPath).toBeUndefined();
  });
});


describe('horizontal presentation cabling', () => {
  it('routes a dense horizontal team around upright racks with distinct live packet runs', () => {
    const agents = [agent('core', { category: 'orchestrator' }), ...Array.from({ length: 20 }, (_, i) => agent(`worker-${i}`))];
    const specs = agents.slice(1).map(worker => delegation(`d-${worker.id}`, 'core', worker.id));
    const positions = layoutMissionGraph(agents, specs, 'horizontal');
    const boxes = new Map(positions.map(position => [position.agentId, position]));
    const cables = layoutCables({ specs, boxes, agents: new Map(agents.map(agent => [agent.id, agent])), missionState: 'running', orientation: 'horizontal' });
    expect(cables).toHaveLength(20);
    for (const cable of cables) {
      expect(cable.source.side).toBe('right');
      expect(cable.target.side).toBe('left');
      for (const rack of positions.filter(rack => rack.agentId !== cable.sourceAgentId && rack.agentId !== cable.targetAgentId)) expect(intersectsCard(cable.d, rack)).toBe(false);
      expect(cable.packetPath).toBeDefined();
    }
    expect(new Set(cables.map(cable => cable.packetPath)).size).toBe(20);
  });

  it('attaches outgoing and return cables to the actual right and left rack faces', () => {
    const core = agent('core', { category: 'orchestrator' });
    const worker = agent('worker');
    const boxes = new Map([['core', box('core', 184, 480, true)], ['worker', box('worker', 620, 260)]]);
    const cables = layoutCables({ specs: [delegation('out', 'core', 'worker'), { ...delegation('return', 'worker', 'core'), kind: 'handoff' }], boxes, agents: new Map([['core', core], ['worker', worker]]), missionState: 'running', orientation: 'horizontal' });
    expect(cables[0].source).toMatchObject({ x: 336, side: 'right' });
    expect(cables[0].target).toMatchObject({ x: 516, side: 'left' });
    expect(cables[1].source.side).toBe('left');
    expect(cables[1].target.side).toBe('right');
    expect(cables.every(cable => cable.live)).toBe(true);
  });
});

it('a known-ended worker cannot energize a cable despite stale working state', () => {
  const source = agent('core', { category: 'orchestrator' });
  expect(isCableLive('running', 'delegation', source, agent('worker', { terminalLive: false }))).toBe(false);
  expect(isCableLive('running', 'delegation', source, agent('worker', { terminalLive: true }))).toBe(true);
  expect(isCableLive('running', 'delegation', source, agent('worker'))).toBe(true);
  expect(isCableLive('running', 'handoff', agent('worker', { terminalLive: false }), source)).toBe(false);
});

it.each(['vertical', 'horizontal'] as const)('known-ended workers have no energized cables in %s orientation', (orientation) => {
  const agents = [agent('core', { category: 'orchestrator' }), agent('worker', { terminalLive: false })];
  const specs = [delegation('out', 'core', 'worker'), { ...delegation('back', 'worker', 'core'), kind: 'handoff' as const }];
  const positions = layoutMissionGraph(agents, specs, orientation);
  const cables = layoutCables({ specs, boxes: new Map(positions.map(position => [position.agentId, position])), agents: new Map(agents.map(agent => [agent.id, agent])), missionState: 'running', orientation });
  expect(cables).toHaveLength(2);
  expect(cables.every(cable => !cable.live)).toBe(true);
});
