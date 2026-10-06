/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MissionAgentSnapshot,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { layoutMissionGraph, MissionGraph } from './MissionGraph';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [
  {
    id: 'worker-discovery',
    agentName: 'Mapeamento completo de dependências e riscos sem abreviação',
    category: 'scout',
    cli: 'codex',
    state: 'done',
    currentUnitId: 'unit-discovery',
    detail: 'Levantamento integral concluído com todos os caminhos relevantes preservados.',
  },
  {
    id: 'coordinator',
    agentName: 'Coordenação principal da missão canônica',
    category: 'orchestrator',
    cli: 'claude',
    state: 'working',
    currentUnitId: 'unit-coordinate',
    detail: 'Orquestrando a entrega e acompanhando cada dependência ativa.',
  },
  {
    id: 'worker-implementation',
    agentName: 'Implementação do fluxo operacional completo',
    category: 'executor',
    cli: 'codex',
    state: 'waiting',
    currentUnitId: 'unit-implementation',
    detail: 'Aplicando o contrato canônico sem atalhos de compatibilidade.',
  },
  {
    id: 'worker-review',
    agentName: 'Revisão final de comportamento e acessibilidade',
    category: 'reviewer',
    cli: 'agy',
    state: 'queued',
    detail: 'Aguardando a implementação para iniciar a revisão independente.',
  },
] satisfies MissionAgentSnapshot[];

const categoryLabelByCategory = {
  orchestrator: 'Coordenação',
  scout: 'Pesquisa',
  executor: 'Execução',
  reviewer: 'Revisão',
} as const;

const stateLabelByState = {
  queued: 'Na fila',
  working: 'Trabalhando',
  waiting: 'Aguardando',
  done: 'Concluído',
} as const;

const snapshot = {
  id: 'mission-graph',
  title: 'Missão canônica do grafo',
  objective: 'Projetar a topologia operacional sem inventar dados.',
  workspaceLabel: 'Nexus',
  state: 'running',
  progress: { completed: 1, total: 3 },
  agents,
  edges: [
    {
      id: 'edge-discovery-coordinate',
      sourceAgentId: 'worker-discovery',
      targetAgentId: 'coordinator',
      kind: 'handoff',
      label: 'Descobertas entregues',
    },
    {
      id: 'edge-coordinate-implementation',
      sourceAgentId: 'coordinator',
      targetAgentId: 'worker-implementation',
      kind: 'delegation',
      label: 'Execução delegada',
    },
    {
      id: 'edge-missing-endpoint',
      sourceAgentId: 'coordinator',
      targetAgentId: 'agent-not-in-snapshot',
      kind: 'review',
      label: 'Este vínculo não pode ser desenhado',
    },
  ],
  units: [
    {
      id: 'unit-discovery',
      title: 'Inventário completo do sistema existente',
      status: 'done',
      agentId: 'worker-discovery',
      dependsOn: [],
      evidenceIds: ['evidence-discovery'],
    },
    {
      id: 'unit-coordinate',
      title: 'Coordenar a sequência integral de entrega',
      status: 'running',
      agentId: 'coordinator',
      dependsOn: ['unit-discovery'],
      evidenceIds: [],
    },
    {
      id: 'unit-implementation',
      title: 'Implementar o comportamento canônico completo',
      status: 'running',
      agentId: 'worker-implementation',
      dependsOn: ['unit-coordinate'],
      evidenceIds: [],
    },
  ],
  allowedActions: ['direct', 'stop'],
  version: 7,
  updatedAt: 1_786_086_000_000,
} satisfies MissionSnapshot;

const mountedRoots = new Set<Root>();

interface RenderGraphOptions {
  readonly snapshot?: MissionSnapshot;
  readonly onSelectAgent?: (agentId: string) => void;
  readonly onOpenAgentPane?: (paneId: string) => void;
  readonly onRetry?: () => void;
}

function renderGraph(
  selectedAgentId: string | null,
  {
    snapshot: graphSnapshot = snapshot,
    onSelectAgent = vi.fn<(agentId: string) => void>(),
    onOpenAgentPane = vi.fn<(paneId: string) => void>(),
    onRetry = vi.fn<() => void>(),
  }: RenderGraphOptions = {},
): {
  host: HTMLElement;
  onSelectAgent: typeof onSelectAgent;
  onOpenAgentPane: typeof onOpenAgentPane;
  onRetry: typeof onRetry;
  rerender: (updated: MissionSnapshot) => void;
} {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.add(root);

  act(() => {
    root.render(
      <MissionGraph
        snapshot={graphSnapshot}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
        onOpenAgentPane={onOpenAgentPane}
        onRetry={onRetry}
      />,
    );
  });

  return { host, onSelectAgent, onOpenAgentPane, onRetry,
    rerender: (updated) => act(() => root.render(<MissionGraph snapshot={updated} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} onOpenAgentPane={onOpenAgentPane} onRetry={onRetry} />)),
  };
}

function positionById(
  layout: readonly { agentId: string; x: number; y: number }[],
  agentId: string,
) {
  const position = layout.find((candidate) => candidate.agentId === agentId);
  if (!position) throw new Error(`Posição ausente para ${agentId}`);
  return position;
}

function agentButton(host: HTMLElement, fullName: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => {
      const accessibleText =
        candidate.getAttribute('aria-label') ?? candidate.textContent ?? '';
      return accessibleText.includes(fullName);
    },
  );
  if (!button) throw new Error(`Cartão semântico ausente para ${fullName}`);
  return button;
}

afterEach(() => {
  for (const root of mountedRoots) act(() => root.unmount());
  mountedRoots.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('layoutMissionGraph', () => {
  it('places the coordinator at the upper center and workers in stable input order', () => {
    const firstLayout = layoutMissionGraph(agents);
    const secondLayout = layoutMissionGraph(agents.map((agent) => ({ ...agent })));

    expect(secondLayout).toEqual(firstLayout);
    expect(firstLayout.map(({ agentId }) => agentId)).toEqual([
      'coordinator',
      'worker-discovery',
      'worker-implementation',
      'worker-review',
    ]);

    const coordinator = positionById(firstLayout, 'coordinator');
    const workers = agents
      .filter(({ category }) => category !== 'orchestrator')
      .map(({ id }) => positionById(firstLayout, id));

    expect(workers.every(({ y }) => y > coordinator.y)).toBe(true);
    expect(workers.map(({ y }) => y)).toEqual([
      workers[0].y,
      workers[0].y,
      workers[0].y,
    ]);
    expect(workers[0].x).toBeLessThan(workers[1].x);
    expect(workers[1].x).toBeLessThan(workers[2].x);
    expect(coordinator.x).toBe((workers[0].x + workers[2].x) / 2);
  });

  it('lays out horizontal delegation/dependency layers left to right with upright rack dimensions', () => {
    const horizontal = layoutMissionGraph(agents, [
      { id: 'delegate', kind: 'delegation', sourceAgentId: 'coordinator', targetAgentId: 'worker-discovery' },
      { id: 'dependency', kind: 'dependency', sourceAgentId: 'worker-discovery', targetAgentId: 'worker-implementation' },
      { id: 'feedback', kind: 'handoff', sourceAgentId: 'worker-implementation', targetAgentId: 'coordinator' },
    ], 'horizontal');
    const coordinator = positionById(horizontal, 'coordinator');
    const scout = positionById(horizontal, 'worker-discovery');
    const executor = positionById(horizontal, 'worker-implementation');
    expect(coordinator.x).toBeLessThan(scout.x);
    expect(scout.x).toBeLessThan(executor.x);
    expect(horizontal.find(position => position.agentId === 'worker-implementation')).toMatchObject({ width: 208, height: 150 });
    expect(layoutMissionGraph(agents)).toEqual(layoutMissionGraph(agents, undefined, 'vertical'));
  });

  it('uses the first stable agent as visual root when no coordinator exists without mutating input', () => {
    const malformedAgents: MissionAgentSnapshot[] = [
      { ...agents[2] },
      { ...agents[0] },
      { ...agents[3] },
    ];
    const originalAgents = structuredClone(malformedAgents);

    const layout = layoutMissionGraph(malformedAgents);

    expect(malformedAgents).toEqual(originalAgents);
    expect(layout.map(({ agentId }) => agentId)).toEqual(
      originalAgents.map(({ id }) => id),
    );

    const fallbackRoot = positionById(layout, malformedAgents[0].id);
    const remaining = malformedAgents
      .slice(1)
      .map(({ id }) => positionById(layout, id));

    expect(remaining.every(({ y }) => y > fallbackRoot.y)).toBe(true);
    expect(remaining[0].y).toBe(remaining[1].y);
    expect(remaining[0].x).toBeLessThan(remaining[1].x);
    expect(fallbackRoot.x).toBe((remaining[0].x + remaining[1].x) / 2);
  });
});

describe('MissionGraph', () => {
  it('offers visible orientation, fit, zoom and full-screen controls without affecting agents', () => {
    const { host, onSelectAgent, onOpenAgentPane } = renderGraph(null);
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === label)!;
    expect(button('Tela inteira')).toBeDefined();
    expect(button('Ajustar à tela')).toBeDefined();
    act(() => button('Horizontal').click());
    expect(host.querySelector('.mission-graph')?.getAttribute('data-orientation')).toBe('horizontal');
    expect(button('Horizontal').getAttribute('aria-pressed')).toBe('true');
    expect(button('Vertical').getAttribute('aria-pressed')).toBe('false');
    act(() => button('Aumentar zoom').click());
    expect(host.querySelector('.mission-graph__zoom')?.textContent).toBe('110%');
    act(() => button('Ajustar à tela').click());
    expect(host.querySelector('.mission-graph')?.getAttribute('data-fit')).toBe('true');
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(onOpenAgentPane).not.toHaveBeenCalled();
  });

  it('measures the viewport when an initially empty mission gains agents and fits above the readable floor', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const { host, rerender } = renderGraph(null, { snapshot: { ...snapshot, agents: [], edges: [] } });
    rerender(snapshot);
    const fit = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Ajustar à tela')!;
    act(() => fit.click());
    expect(host.querySelector('.mission-graph__zoom')?.textContent).toBe('63%');
    expect(host.querySelector<HTMLElement>('.mission-graph__surface')?.style.transform).toContain('scale(0.633');
  });

  it('fits the whole dense graph even when presentation scale is below the manual reading limit', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const denseAgents = Array.from({ length: 21 }, (_, i) => ({ ...agents[1], id: `fit-${i}`, category: i === 0 ? 'orchestrator' as const : 'executor' as const }));
    const { host } = renderGraph(null, { snapshot: { ...snapshot, agents: denseAgents, edges: [] } });
    const fit = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Ajustar à tela')!;
    act(() => fit.click());
    const scaled = host.querySelector<HTMLElement>('.mission-graph__scaled')!;
    expect(parseFloat(scaled.style.width)).toBeLessThanOrEqual(468);
    expect(parseFloat(scaled.style.height)).toBeLessThanOrEqual(268);
    expect(host.querySelectorAll('.mission-agent-card')).toHaveLength(21);
    expect(host.querySelector('.mission-graph__fit-note')?.textContent).toContain('Amplie o zoom');
  });

  it('full-screen retains orientation and receives live snapshot updates without extra agent actions', async () => {
    const { host, rerender, onSelectAgent, onOpenAgentPane } = renderGraph('worker-implementation');
    const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
    act(() => button(host, 'Horizontal').click());
    await act(async () => button(host, 'Tela inteira').click());
    rerender({ ...snapshot, state: 'failed', agents: snapshot.agents.map(agent => ({ ...agent, state: 'failed' })) });
    const expanded = document.querySelector('.mission-graph--presentation')!;
    expect(expanded.getAttribute('data-mission-state')).toBe('failed');
    expect(expanded.getAttribute('data-orientation')).toBe('horizontal');
    expect(expanded.querySelector('.mission-graph__packets')).toBeNull();
    expect(expanded.querySelector('[data-agent-id="worker-implementation"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(onSelectAgent).not.toHaveBeenCalled();
    expect(onOpenAgentPane).not.toHaveBeenCalled();
    await act(async () => button(expanded, 'Sair da tela inteira').click());
    expect(host.querySelector('.mission-graph')?.getAttribute('data-orientation')).toBe('horizontal');
  });

  it('fallback fills the app, Escape exits and returns keyboard focus', async () => {
    const { host } = renderGraph(null);
    const enter = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Tela inteira')!;
    enter.focus();
    await act(async () => enter.click());
    const expanded = document.querySelector('.mission-graph--presentation');
    expect(expanded).not.toBeNull();
    expect(expanded?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Sair da tela inteira');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('.mission-graph--presentation')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Tela inteira');
  });

  it('native full-screen exit follows fullscreenchange and restores focus', async () => {
    const { host } = renderGraph(null);
    const section = host.querySelector<HTMLElement>('.mission-graph')!;
    let fullscreen: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    Object.defineProperty(section, 'requestFullscreen', { configurable: true, value: async () => { fullscreen = section; document.dispatchEvent(new Event('fullscreenchange')); } });
    const enter = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Tela inteira')!;
    enter.focus();
    await act(async () => enter.click());
    expect(section.classList.contains('mission-graph--presentation')).toBe(true);
    act(() => { fullscreen = null; document.dispatchEvent(new Event('fullscreenchange')); });
    expect(section.classList.contains('mission-graph--presentation')).toBe(false);
    expect(document.activeElement).toBe(enter);
    delete (document as unknown as { fullscreenElement?: Element }).fullscreenElement;
  });

  it.each([0, 8, 20])('keeps dense packet motion exclusive with 20 helpers and %i handoffs', (handoffs) => {
    const denseAgents = Array.from({ length: 21 }, (_, index) => ({
      ...agents[1], id: `dense-${index}`, agentName: `Agente ${index}`,
      category: index === 0 ? 'orchestrator' as const : 'executor' as const,
    }));
    const edges: MissionSnapshot['edges'] = handoffs ? [
      ...denseAgents.slice(1).map((a) => ({ id: `d-${a.id}`, kind: 'delegation' as const,
        sourceAgentId: denseAgents[0].id, targetAgentId: a.id })),
      ...denseAgents.slice(1, handoffs + 1).map((a) => ({ id: `h-${a.id}`, kind: 'handoff' as const,
        sourceAgentId: a.id, targetAgentId: denseAgents[0].id })),
    ] : [];
    const { host } = renderGraph(null, {
      snapshot: { ...snapshot, agents: denseAgents, edges },
    });
    const groups = [...host.querySelectorAll('.mission-graph__cable-group')];
    expect(groups).toHaveLength(20 + handoffs);
    for (const group of groups) {
      const cable = group.querySelector('.mission-graph__edge')!.getAttribute('d');
      const motions = [...group.querySelectorAll('animateMotion')];
      expect(motions).toHaveLength(2);
      for (const motion of motions) {
        const path = motion.getAttribute('path')!;
        expect(path).not.toBe(cable);
        const [x1, y1, x2, y2] = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        expect(x1 === x2 || y1 === y2).toBe(true);
        expect(Math.abs(x2 - x1) + Math.abs(y2 - y1)).toBeGreaterThanOrEqual(56);
      }
    }
  });
  it('renders a canonical edge kind and label as a visible, accessible PT-BR relationship between named agents', () => {
    const { host } = renderGraph(null);
    const sourceName = agents[0].agentName;
    const targetName = agents[1].agentName;
    const relationship = [
      ...host.querySelectorAll<HTMLElement>('[aria-label]'),
    ].find((candidate) => {
      const accessibleName = candidate.getAttribute('aria-label') ?? '';
      return (
        !candidate.closest('[aria-hidden="true"], [hidden]') &&
        accessibleName.includes('Entrega') &&
        accessibleName.includes('Descobertas entregues') &&
        accessibleName.includes(sourceName) &&
        accessibleName.includes(targetName) &&
        accessibleName.indexOf(sourceName) < accessibleName.indexOf(targetName)
      );
    });

    expect(relationship).toBeDefined();
    expect(relationship!.textContent).toContain('Entrega');
    expect(relationship!.textContent).toContain('Descobertas entregues');
    expect(relationship!.textContent).toContain(sourceName);
    expect(relationship!.textContent).toContain(targetName);
    expect(relationship!.textContent!.indexOf(sourceName)).toBeLessThan(
      relationship!.textContent!.indexOf(targetName),
    );
  });

  it('shows a non-color legend cue in PT-BR for all four canonical edge kinds', () => {
    const graphWithEveryEdgeKind = {
      ...snapshot,
      edges: [
        {
          id: 'edge-delegation',
          sourceAgentId: 'coordinator',
          targetAgentId: 'worker-implementation',
          kind: 'delegation',
          label: 'Execução delegada',
        },
        {
          id: 'edge-handoff',
          sourceAgentId: 'worker-discovery',
          targetAgentId: 'coordinator',
          kind: 'handoff',
          label: 'Descobertas entregues',
        },
        {
          id: 'edge-dependency',
          sourceAgentId: 'worker-implementation',
          targetAgentId: 'worker-discovery',
          kind: 'dependency',
          label: 'Dependência técnica',
        },
        {
          id: 'edge-review',
          sourceAgentId: 'worker-review',
          targetAgentId: 'worker-implementation',
          kind: 'review',
          label: 'Revisão independente',
        },
      ],
    } satisfies MissionSnapshot;
    const { host } = renderGraph(null, { snapshot: graphWithEveryEdgeKind });
    const legend = [
      ...host.querySelectorAll<HTMLElement>('[aria-label]'),
    ].find((candidate) => {
      const accessibleName = (
        candidate.getAttribute('aria-label') ?? ''
      ).toLocaleLowerCase('pt-BR');
      return (
        !candidate.closest('[aria-hidden="true"], [hidden]') &&
        accessibleName.includes('legenda') &&
        accessibleName.includes('relaç')
      );
    });

    expect(legend).toBeDefined();
    for (const kindLabel of [
      'Delegação',
      'Entrega',
      'Dependência',
      'Revisão',
    ]) {
      expect(legend!.textContent).toContain(kindLabel);
    }
  });

  it('renders only edges with both endpoints present in an SVG layer beneath the cards', () => {
    const { host } = renderGraph(null);
    const svg = host.querySelector('.mission-graph__edges');
    expect(svg).not.toBeNull();

    const renderedConnections = [
      ...svg!.querySelectorAll<SVGElement>('.mission-graph__edge'),
    ];
    expect(renderedConnections).toHaveLength(2);

    const firstCard = host.querySelector('.mission-agent-card');
    expect(firstCard).not.toBeNull();
    expect(
      svg!.compareDocumentPosition(firstCard!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('layers a state signal over every visible canonical connection', () => {
    const { host } = renderGraph(null);
    const graph = host.querySelector<HTMLElement>('.mission-graph');
    const svg = host.querySelector('.mission-graph__edges');

    expect(graph?.dataset.missionState).toBe('running');
    expect(
      svg?.querySelectorAll('.mission-graph__edge-signal'),
    ).toHaveLength(2);
  });

  it('energia no cabo: pacotes só no cabo vivo (missão rodando e ponta de trabalho trabalhando)', () => {
    const live = {
      ...snapshot,
      agents: snapshot.agents.map((item) =>
        item.id === 'worker-implementation' ? { ...item, state: 'working' as const } : item,
      ),
    } satisfies MissionSnapshot;
    const { host } = renderGraph(null, { snapshot: live });
    const group = (edgeId: string) =>
      host
        .querySelector<SVGElement>(`.mission-graph__edge[data-edge-id="${edgeId}"]`)!
        .closest<SVGGElement>('.mission-graph__cable-group')!;

    const delegated = group('edge-coordinate-implementation');
    const delivered = group('edge-discovery-coordinate');
    expect(delegated.dataset.edgeLive).toBe('true');
    expect(delegated.dataset.workerState).toBe('working');
    expect(delegated.querySelectorAll('animateMotion')).toHaveLength(2);
    // Entrega de quem já concluiu: cabo quieto, tingido pelo estado.
    expect(delivered.dataset.edgeLive).toBe('false');
    expect(delivered.dataset.workerState).toBe('done');
    expect(delivered.querySelector('.mission-graph__packets')).toBeNull();
    // Os pacotes são decoração: fora da árvore de acessibilidade.
    expect(
      host.querySelector('.mission-graph__packets')?.getAttribute('aria-hidden'),
    ).toBe('true');
    // Um conector em cada ponta de cada cabo, por cima dos racks.
    expect(
      host.querySelectorAll('.mission-graph__jacks .mission-graph__jack'),
    ).toHaveLength(4);
    expect(
      host.querySelectorAll('.mission-graph__jack[data-edge-live="true"]'),
    ).toHaveLength(2);

    const { host: completed } = renderGraph(null, {
      snapshot: { ...live, state: 'completed' } satisfies MissionSnapshot,
    });
    expect(completed.querySelector('.mission-graph__packets')).toBeNull();
    expect(
      completed.querySelectorAll('.mission-graph__cable-group[data-edge-live="true"]'),
    ).toHaveLength(0);
  });

  it('cada rack mostra a ferramenta (logo, CLI e modelo) e o visor apagado quando não há unidade', () => {
    const racks = {
      ...snapshot,
      agents: [
        ...snapshot.agents,
        {
          id: 'worker-idle',
          agentName: 'Worker ocioso',
          category: 'executor',
          cli: 'qwen',
          model: 'qwen3.8-max',
          state: 'queued',
        },
      ],
    } satisfies MissionSnapshot;
    const { host } = renderGraph(null, { snapshot: racks });
    const idle = agentButton(host, 'Worker ocioso');
    expect(
      idle.querySelector('.mission-agent-card__tool-label')?.textContent,
    ).toBe('qwen · qwen3.8-max');
    expect(idle.querySelector('.mission-agent-card__tool .provider-logo')).not.toBeNull();
    expect(idle.getAttribute('aria-label')).toContain('Ferramenta: qwen · qwen3.8-max');
    const placeholder = idle.querySelector('.mission-agent-card__idle');
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    expect(idle.querySelector('.mission-agent-card__detail')).toBeNull();
    // Só o núcleo tem o painel de portas.
    expect(host.querySelectorAll('.mission-agent-card__patch')).toHaveLength(1);
    expect(
      host.querySelector('.mission-agent-card[data-category="orchestrator"] .mission-agent-card__patch'),
    ).not.toBeNull();
  });

  it('draws topology guides when no canonical relationship has been persisted', () => {
    const graphWithoutEdges = {
      ...snapshot,
      edges: [],
    } satisfies MissionSnapshot;
    const { host } = renderGraph(null, { snapshot: graphWithoutEdges });

    expect(
      host.querySelectorAll('.mission-graph__edge--topology'),
    ).toHaveLength(graphWithoutEdges.agents.length - 1);
    expect(host.querySelector('.mission-graph__relationships')).toBeNull();
  });

  it('uses the built-in pixel icon language for every agent category', () => {
    const { host } = renderGraph(null);

    for (const agent of snapshot.agents) {
      const card = agentButton(host, agent.agentName);
      const icon = card.querySelector(
        `[data-agent-category-icon="${agent.category}"] svg`,
      );
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('renders semantic agent-card buttons with complete canonical details', () => {
    const { host } = renderGraph(null);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.mission-agent-card')];
    expect(buttons).toHaveLength(snapshot.agents.length);
    expect(buttons.every((button) => button.type === 'button')).toBe(true);

    for (const agent of snapshot.agents) {
      const button = agentButton(host, agent.agentName);
      const accessibleText =
        button.getAttribute('aria-label') ?? button.textContent ?? '';

      expect(accessibleText).toContain(agent.agentName);
      expect(button.textContent).toContain(
        categoryLabelByCategory[agent.category],
      );
      expect(button.textContent).toContain(stateLabelByState[agent.state]);
      if (agent.detail) expect(button.textContent).toContain(agent.detail);

      const currentUnit = snapshot.units.find(
        ({ id }) => id === agent.currentUnitId,
      );
      if (currentUnit) {
        expect(button.textContent).toContain(currentUnit.id);
        expect(button.textContent).toContain(currentUnit.title);
      }
    }
  });

  it('exposes selection programmatically and reports the clicked stable agent id', () => {
    const { host, onSelectAgent } = renderGraph('worker-implementation');
    const selected = agentButton(
      host,
      'Implementação do fluxo operacional completo',
    );
    const coordinator = agentButton(
      host,
      'Coordenação principal da missão canônica',
    );

    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(coordinator.getAttribute('aria-pressed')).toBe('false');

    act(() => selected.click());
    expect(onSelectAgent).toHaveBeenCalledTimes(1);
    expect(onSelectAgent).toHaveBeenCalledWith('worker-implementation');
  });

  it('seleciona o agente sem tentar abrir um terminal cuja sessão acabou', () => {
    const ended = {
      ...snapshot,
      agents: snapshot.agents.map((agent) => agent.id === 'coordinator'
        ? { ...agent, paneId: 'pane-antigo', terminalLive: false }
        : agent),
    };
    const { host, onSelectAgent, onOpenAgentPane } = renderGraph(null, { snapshot: ended });
    act(() => agentButton(host, 'Coordenação principal da missão canônica').click());
    expect(onSelectAgent).toHaveBeenCalledWith('coordinator');
    expect(onOpenAgentPane).not.toHaveBeenCalled();
  });

  it('abre o terminal do agente que já tem pane (F-005)', () => {
    const seated = {
      ...snapshot,
      agents: snapshot.agents.map((agent) =>
        agent.id === 'coordinator'
          ? { ...agent, paneId: 'pane-maestro' }
          : agent,
      ),
    } satisfies MissionSnapshot;
    const { host, onSelectAgent, onOpenAgentPane } = renderGraph(
      'coordinator',
      { snapshot: seated },
    );
    act(() =>
      agentButton(host, 'Coordenação principal da missão canônica').click(),
    );
    expect(onSelectAgent).toHaveBeenCalledWith('coordinator');
    expect(onOpenAgentPane).toHaveBeenCalledWith('pane-maestro');
  });

  it('teaches recovery and invokes onRetry from Atualizar when no agents are available', () => {
    const emptySnapshot = {
      ...snapshot,
      agents: [],
      edges: [],
    } satisfies MissionSnapshot;
    const onRetry = vi.fn<() => void>();
    const { host } = renderGraph(null, { snapshot: emptySnapshot, onRetry });

    expect(host.textContent).toContain('Nenhum agente na missão ainda');
    expect(host.textContent).toContain(
      'Os agentes aparecem aqui quando o orquestrador abre panes para esta missão.',
    );

    const retryButton = [
      ...host.querySelectorAll<HTMLButtonElement>('button'),
    ].find((candidate) => {
      const accessibleName = (
        candidate.getAttribute('aria-label') ??
        candidate.textContent ??
        ''
      ).trim();
      return accessibleName === 'Atualizar';
    });
    expect(retryButton).toBeDefined();
    expect(retryButton!.type).toBe('button');

    act(() => retryButton!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('presentation review regressions', () => {
  it('lets an outside dialog receive Escape while the graph is presented', async () => {
    const { host } = renderGraph(null);
    const enter = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Tela inteira')!;
    await act(async () => enter.click());
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    dialog.append(input); document.body.append(dialog);
    const escape = vi.fn(); dialog.addEventListener('keydown', escape);
    try {
      input.focus();
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => input.dispatchEvent(event));
      expect(escape).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
      expect(document.querySelector('.mission-graph--presentation')).not.toBeNull();
    } finally { dialog.remove(); }
  });
  it('leaves presentation when the current mission loses its agents', async () => {
    const { host, rerender } = renderGraph(null);
    const enter = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Tela inteira')!;
    await act(async () => enter.click());
    rerender({ ...snapshot, agents: [], edges: [] });
    await act(async () => {});
    rerender(snapshot);
    expect(document.querySelector('.mission-graph--presentation')).toBeNull();
    expect(host.querySelector('.mission-graph')).not.toBeNull();
  });
});
