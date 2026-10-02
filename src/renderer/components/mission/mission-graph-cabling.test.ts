import { describe, expect, it } from 'vitest';
import type { MissionAgentSnapshot } from '../../../shared/mission-engine-contract';
import {
  CORE_HEIGHT,
  CORE_WIDTH,
  PACKET_GLYPHS,
  RACK_HEIGHT,
  RACK_WIDTH,
  cableWorkerEnd,
  isCableLive,
  layoutCables,
  packetGlyph,
  rackSize,
  type CableSpec,
  type RackBox,
} from './mission-graph-cabling';

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

describe('cabos da sala de racks', () => {
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
