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

  return { host, onSelectAgent, onOpenAgentPane, onRetry };
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
    const svg = host.querySelector('svg');
    expect(svg).not.toBeNull();

    const renderedConnections = [
      ...svg!.querySelectorAll<SVGElement>('.mission-graph__edge'),
    ];
    expect(renderedConnections).toHaveLength(2);

    const firstCard = host.querySelector('button');
    expect(firstCard).not.toBeNull();
    expect(
      svg!.compareDocumentPosition(firstCard!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('layers a state signal over every visible canonical connection', () => {
    const { host } = renderGraph(null);
    const graph = host.querySelector<HTMLElement>('.mission-graph');
    const svg = host.querySelector('svg');

    expect(graph?.dataset.missionState).toBe('running');
    expect(
      svg?.querySelectorAll('.mission-graph__edge-signal'),
    ).toHaveLength(2);
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
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
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
