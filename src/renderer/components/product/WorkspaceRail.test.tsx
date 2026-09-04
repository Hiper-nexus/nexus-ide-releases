/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceRail,
  type WorkspaceRailProps,
  type WorkspaceRailWorkspace,
} from './WorkspaceRail';
import { useTerminalGridDialogStore } from '../../state/terminal-grid-dialog-store';
import { useQuotaStore } from '../../state/quota-store';
import { useAdapterStore } from '../../state/adapter-store';
import { useLayoutStore } from '../../state/layout-store';
import { createLeaf, createPane } from '../../lib/split-tree';
import type { LayoutNode } from '../../../shared/types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

const activeWorkspaces: WorkspaceRailWorkspace[] = [
  {
    id: 'atlas',
    name: 'Atlas local',
    missions: [
      {
        id: 'mission-running',
        title: 'Corrigir o login',
        status: 'running',
        needsAttention: false,
      },
      {
        id: 'mission-blocked',
        title: 'Publicar a versão',
        status: 'blocked_user',
        needsAttention: true,
      },
    ],
  },
];

const recentWorkspaces: WorkspaceRailWorkspace[] = [
  {
    id: 'cometa',
    name: 'Cometa',
    missions: [
      {
        id: 'mission-done',
        title: 'Revisar a página inicial',
        status: 'completed',
        needsAttention: false,
      },
    ],
  },
];

function renderRail(overrides: Partial<WorkspaceRailProps> = {}) {
  const handlers = {
    onCreateNew: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onSelectMission: vi.fn(),
    onOpenTaskBoard: vi.fn(),
    onOpenMemory: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenTerminals: vi.fn(),
  };
  const props: WorkspaceRailProps = {
    activeWorkspaces,
    recentWorkspaces,
    selection: { kind: 'mission', missionId: 'mission-running' },
    ...handlers,
    ...overrides,
  };
  const host = render(<WorkspaceRail {...props} />);
  return { host, handlers };
}

describe('WorkspaceRail', () => {
  it('groups missions with valid non-heading labels and hides empty groups', () => {
    const { host } = renderRail();
    const active = host.querySelector('[data-rail-group="active"]');
    const recent = host.querySelector('[data-rail-group="recent"]');

    expect(active?.textContent).toContain('Atlas local');
    expect(active?.textContent).toContain('Corrigir o login');
    expect(active?.textContent).toContain('Publicar a versão');
    expect(recent?.textContent).toContain('Cometa');
    expect(recent?.textContent).toContain('Revisar a página inicial');
    expect(
      host.querySelector<HTMLButtonElement>('[data-workspace-id="atlas"]')
        ?.title,
    ).toBe('Atlas local');

    for (const [group, label] of [
      [active, 'Em andamento'],
      [recent, 'Recentes'],
    ] as const) {
      const labelId = group?.getAttribute('aria-labelledby');
      const labelNode = labelId ? document.getElementById(labelId) : null;

      expect(labelId).toBeTruthy();
      expect(labelNode?.textContent).toBe(label);
      expect(labelNode?.tagName).toBe('SPAN');
      expect(group?.contains(labelNode)).toBe(true);
    }
    expect(host.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();

    const emptyHost = render(
      <WorkspaceRail
        activeWorkspaces={[]}
        recentWorkspaces={[]}
        selection={null}
        onCreateNew={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onSelectMission={vi.fn()}
        onOpenTaskBoard={vi.fn()}
        onOpenMemory={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenTerminals={vi.fn()}
      />,
    );
    expect(emptyHost.querySelector('[data-rail-group="active"]')).toBeNull();
    expect(emptyHost.querySelector('[data-rail-group="recent"]')).toBeNull();
    expect(emptyHost.textContent).not.toContain('0');
  });

  it('maps every canonical mission state and prioritizes running warnings', () => {
    const statusCases = [
      {
        id: 'draft',
        state: 'draft',
        needsAttention: false,
        label: 'Preparando',
        tone: 'pending',
      },
      {
        id: 'review-ready',
        state: 'review_ready',
        needsAttention: false,
        label: 'Pronta para iniciar',
        tone: 'ready',
      },
      {
        id: 'starting',
        state: 'starting',
        needsAttention: false,
        label: 'Iniciando',
        tone: 'pending',
      },
      {
        id: 'running',
        state: 'running',
        needsAttention: false,
        label: 'Trabalhando',
        tone: 'running',
      },
      {
        id: 'running-warning',
        state: 'running',
        needsAttention: true,
        label: 'Trabalhando · aviso',
        tone: 'blocked',
      },
      {
        id: 'blocked-user',
        state: 'blocked_user',
        needsAttention: true,
        label: 'Precisa de você',
        tone: 'blocked',
      },
      {
        id: 'blocked-technical',
        state: 'blocked_technical',
        needsAttention: true,
        label: 'Precisa de reparo',
        tone: 'blocked',
      },
      {
        id: 'recovering',
        state: 'recovering',
        needsAttention: true,
        label: 'Recuperando',
        tone: 'running',
      },
      {
        id: 'stopping',
        state: 'stopping',
        needsAttention: false,
        label: 'Parando',
        tone: 'pending',
      },
      {
        id: 'failed',
        state: 'failed',
        needsAttention: true,
        label: 'Falhou',
        tone: 'failed',
      },
      {
        id: 'completed',
        state: 'completed',
        needsAttention: false,
        label: 'Pronto',
        tone: 'done',
      },
    ] as const;
    const { host } = renderRail({
      activeWorkspaces: [
        {
          id: 'states',
          name: 'Estados',
          missions: statusCases.map(({ id, state, needsAttention }) => ({
            id: `mission-${id}`,
            title: `Missão ${id}`,
            status: state,
            needsAttention,
          })),
        },
      ],
      recentWorkspaces: [],
    });

    for (const { id, state, label, tone } of statusCases) {
      const row = host.querySelector(`[data-mission-id="mission-${id}"]`);

      expect(row?.textContent).toContain(label);
      expect(row?.getAttribute('aria-label')).toBe(`Missão ${id}. ${label}`);
      expect(row?.getAttribute('data-mission-state')).toBe(state);
      expect(row?.classList.contains(`workspace-rail__mission--${tone}`)).toBe(
        true,
      );
      expect(
        row?.querySelector(
          '.workspace-rail__mission-indicator[aria-hidden="true"]',
        ),
      ).not.toBeNull();
    }
  });

  it('missão completed aguardando revisão humana não diz Pronto no rail', () => {
    const { host } = renderRail({
      activeWorkspaces: [
        {
          id: 'review',
          name: 'Review',
          missions: [
            {
              id: 'mission-awaiting',
              title: 'Landing',
              status: 'completed',
              needsAttention: false,
              awaitsOperatorReview: true,
            },
          ],
        },
      ],
      recentWorkspaces: [],
    });
    const row = host.querySelector('[data-mission-id="mission-awaiting"]');
    expect(row?.textContent).toContain('Aguardando você');
    expect(row?.textContent).not.toContain('Pronto');
    expect(row?.getAttribute('aria-label')).toBe('Landing. Aguardando você');
  });

  it('leftover isolado e Encerrar pintam Dormindo/Parou, nunca Precisa de você', () => {
    const { host } = renderRail({
      activeWorkspaces: [
        {
          id: 'leftovers',
          name: 'Leftovers',
          missions: [
            {
              id: 'mission-parked',
              title: 'Waitlist',
              status: 'blocked_user',
              needsAttention: false,
              stateReason: { code: 'session-sleeping', label: 'Dormindo' },
            },
            {
              id: 'mission-encerrar',
              title: 'Encerrada',
              status: 'blocked_user',
              needsAttention: false,
              stateReason: { code: 'runtime-closed', label: 'Parou' },
            },
            {
              id: 'mission-ask',
              title: 'Pergunta',
              status: 'blocked_user',
              needsAttention: true,
              stateReason: {
                code: 'open-question',
                label: 'Aguardando sua resposta',
              },
            },
          ],
        },
      ],
      recentWorkspaces: [],
    });

    expect(
      host.querySelector('[data-mission-id="mission-parked"]')?.textContent,
    ).toContain('Dormindo');
    expect(
      host.querySelector('[data-mission-id="mission-parked"]')?.textContent,
    ).not.toContain('Parou');
    expect(
      host.querySelector('[data-mission-id="mission-encerrar"]')?.textContent,
    ).toContain('Parou');
    expect(
      host.querySelector('[data-mission-id="mission-ask"]')?.textContent,
    ).toContain('Precisa de você');
    expect(
      host.querySelector('[data-mission-id="mission-parked"]')?.textContent,
    ).not.toMatch(/Precisa de você/);
    expect(
      host.querySelector('[data-mission-id="mission-encerrar"]')?.textContent,
    ).not.toMatch(/Precisa de você/);
  });

  it('CTA hero Nova missão abre o mesmo fluxo simples no workspace', () => {
    const { host, handlers } = renderRail();

    const cta = host.querySelector<HTMLButtonElement>(
      '[data-testid="rail-new-mission"]',
    );
    expect(cta?.textContent).toContain('Nova missão');
    expect(cta?.textContent).toContain('o Nexus monta a equipe');
    act(() => {
      cta?.click();
    });
    expect(handlers.onCreateNew).toHaveBeenCalledOnce();
  });

  it('routes Novo, workspaces, missions, fixed destinations and settings', () => {
    const { host, handlers } = renderRail();

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="Criar nova missão"]')?.click();
      host.querySelector<HTMLButtonElement>('[data-workspace-id="atlas"]')?.click();
      host.querySelector<HTMLButtonElement>('[data-mission-id="mission-running"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="Abrir Terminais"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="Abrir Quadro"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="Abrir Memória"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="Abrir Configurações"]')?.click();
    });

    expect(handlers.onCreateNew).toHaveBeenCalledOnce();
    expect(handlers.onSelectWorkspace).toHaveBeenCalledWith('atlas');
    expect(handlers.onSelectMission).toHaveBeenCalledWith(
      'mission-running',
      'atlas',
    );
    expect(handlers.onOpenTerminals).toHaveBeenCalledOnce();
    expect(handlers.onOpenTaskBoard).toHaveBeenCalledOnce();
    expect(handlers.onOpenMemory).toHaveBeenCalledOnce();
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce();
  });

  it('oferece Terminais como destino fixo, sem adivinhar o workspace (F-005)', () => {
    const { host, handlers } = renderRail({
      selection: { kind: 'terminals' },
    });
    const button = host.querySelector<HTMLButtonElement>(
      '[aria-label="Abrir Terminais"]',
    );
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('Terminais');
    expect(button?.getAttribute('aria-current')).toBe('page');
    act(() => button?.click());
    expect(handlers.onOpenTerminals).toHaveBeenCalledOnce();
  });

  it('exposes selected state, full names and keyboard-focusable native controls', () => {
    const longTitle = 'Entregar uma experiência completa para o workspace local';
    const { host } = renderRail({
      activeWorkspaces: [
        {
          ...activeWorkspaces[0]!,
          missions: [
            {
              id: 'mission-long',
              title: longTitle,
              status: 'draft',
              needsAttention: false,
            },
          ],
        },
      ],
      selection: { kind: 'mission', missionId: 'mission-long' },
    });

    const mission = host.querySelector<HTMLButtonElement>(
      '[data-mission-id="mission-long"]',
    );
    const controls = [...host.querySelectorAll<HTMLButtonElement>('button')];

    expect(mission?.getAttribute('aria-current')).toBe('page');
    expect(mission?.getAttribute('aria-label')).toContain(
      'Entregar uma experiência',
    );
    expect(mission?.title).toContain(longTitle);
    expect(controls.every((control) => control.tabIndex === 0)).toBe(true);

    mission?.focus();
    expect(document.activeElement).toBe(mission);
  });

  it('objetivo com URL no rail é hostname, não o dump (F-012)', () => {
    const dump =
      'https://admin.wordnet.com.vc/admin/conteudo aqui dentro deste painel. nao ta legal a ui';
    const { host } = renderRail({
      activeWorkspaces: [
        {
          ...activeWorkspaces[0]!,
          missions: [
            {
              id: 'mission-url',
              title: dump,
              status: 'running',
              needsAttention: false,
            },
          ],
        },
      ],
    });
    const mission = host.querySelector<HTMLButtonElement>(
      '[data-mission-id="mission-url"]',
    );
    expect(mission?.textContent).toContain('admin.wordnet.com.vc');
    expect(mission?.textContent).not.toMatch(/https:\/\//u);
    expect(mission?.title).toContain(dump);
  });

  it('keeps forbidden telemetry and implementation jargon out of the rail', () => {
    const { host } = renderRail({ selection: { kind: 'settings' } });
    const settings = host.querySelector<HTMLButtonElement>(
      '[aria-label="Abrir Configurações"]',
    );

    expect(settings?.getAttribute('aria-current')).toBe('page');
    expect(host.textContent).not.toMatch(
      /XP|nível|level|custo|provider|modelo|pane|worker|orquestrador/i,
    );
  });

  it('abre o diálogo de grade de terminais ao clicar no botão + da linha Terminais', () => {
    useTerminalGridDialogStore.getState().close();
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(false);

    const { host } = renderRail();
    const plusBtn = host.querySelector<HTMLButtonElement>(
      '.workspace-rail__row-grid-action',
    );
    expect(plusBtn).toBeTruthy();

    act(() => {
      plusBtn?.click();
    });

    expect(useTerminalGridDialogStore.getState().isOpen).toBe(true);
    expect(useTerminalGridDialogStore.getState().options.initialCount).toBe(2);
    useTerminalGridDialogStore.getState().close();
  });

  it('renderiza o cockpit Orca com status Local e cotas no rodapé', () => {
    act(() => {
      useQuotaStore.getState().receive({
        updatedAt: Date.now(),
        entries: [
          {
            id: 'claude',
            adapterId: 'claude',
            label: 'Claude',
            installed: true,
            onCooldown: false,
            updatedAt: Date.now(),
            windows: [
              {
                kind: 'hours',
                label: '5 Horas',
                usedRatio: 0.35,
                source: 'provider-api',
                confidence: 'high',
              },
            ],
          },
        ],
        worstUsedRatio: 0.35,
        highUsageCount: 0,
        unknownCount: 0,
      });
    });

    const { host } = renderRail();
    const cockpit = host.querySelector('.workspace-rail__cockpit');
    expect(cockpit).toBeTruthy();
    expect(cockpit?.textContent).toContain('Claude');
    expect(cockpit?.textContent).toContain('35%');

    const conn = host.querySelector('.workspace-rail__cockpit-conn');
    expect(conn?.textContent).toContain('Local');
  });

  it('mostra as duas janelas de quota estilo Orca e a barra da pior janela', () => {
    const now = Date.now();
    act(() => {
      useQuotaStore.getState().receive({
        updatedAt: now,
        entries: [
          {
            id: 'claude',
            adapterId: 'claude',
            label: 'Claude',
            installed: true,
            onCooldown: false,
            updatedAt: now,
            windows: [
              {
                kind: 'hours',
                label: '5 Horas',
                usedRatio: 0.35,
                source: 'provider-api',
                confidence: 'high',
              },
              {
                kind: 'weekly',
                label: 'Semanal',
                usedRatio: 0.41,
                source: 'provider-api',
                confidence: 'high',
              },
            ],
          },
        ],
        worstUsedRatio: 0.41,
        highUsageCount: 0,
        unknownCount: 0,
      });
    });

    const { host } = renderRail();
    const cockpit = host.querySelector('.workspace-rail__cockpit');
    expect(cockpit?.textContent).toContain('5 Horas 35% · Semanal 41%');
    // A barra e o valor refletem a PIOR janela (41%), não a primeira.
    expect(cockpit?.textContent).toContain('41%');
  });

  it('missão selecionada abre com agentes visíveis e logo da LLM (estilo Orca)', () => {
    const previousRoot = useLayoutStore.getState().root;
    const pane = {
      ...createPane('cli-agent', undefined, 'claude'),
      id: 'pane-orca',
      title: 'running checkout regression',
      missionId: 'mission-running',
    };
    act(() => {
      useLayoutStore.setState({ root: createLeaf(pane) });
      useAdapterStore.getState().receive([
        {
          id: 'claude',
          kind: 'cli-pty',
          label: 'Claude',
          icon: '◆',
          models: { list: ['sonnet'], default: 'sonnet' },
          installed: true,
          installCommand: 'npm i -g claude',
          idleTimeoutMs: 800,
          orchestratorCapable: true,
        },
      ]);
    });

    try {
      const { host } = renderRail({
        selection: { kind: 'mission', missionId: 'mission-running' },
      });
      // Sem clicar no toggle: a lista de agentes já está aberta.
      const agents = host.querySelector('.workspace-rail__agents-list');
      expect(agents).not.toBeNull();
      expect(agents?.textContent).toContain('running checkout regression');
      const logo = host.querySelector(
        '.workspace-rail__agent-btn [role="img"]',
      );
      expect(logo?.getAttribute('aria-label')).toBe('Logo Claude');
    } finally {
      act(() => {
        useLayoutStore.setState({ root: previousRoot });
        useAdapterStore.getState().receive([]);
      });
    }
  });

  it('navegar para outra missão expande os agentes dela (sync pós-mount)', () => {
    const previousRoot = useLayoutStore.getState().root;
    const paneA = {
      ...createPane('cli-agent', undefined, 'claude'),
      id: 'pane-a',
      title: 'agente A',
      missionId: 'mission-running',
    };
    const paneB = {
      ...createPane('cli-agent', undefined, 'claude'),
      id: 'pane-b',
      title: 'agente B',
      missionId: 'mission-blocked',
    };
    const twoPaneRoot: LayoutNode = {
      kind: 'split',
      id: 'split-1',
      direction: 'row',
      children: [createLeaf(paneA), createLeaf(paneB)],
    };
    act(() => {
      useLayoutStore.setState({ root: twoPaneRoot });
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderWith = (missionId: string) => {
      act(() => {
        root.render(
          <WorkspaceRail
            activeWorkspaces={activeWorkspaces}
            recentWorkspaces={[]}
            selection={{ kind: 'mission', missionId }}
            onCreateNew={vi.fn()}
            onSelectWorkspace={vi.fn()}
            onSelectMission={vi.fn()}
            onOpenTaskBoard={vi.fn()}
            onOpenMemory={vi.fn()}
            onOpenSettings={vi.fn()}
            onOpenTerminals={vi.fn()}
          />,
        );
      });
    };

    const agentLists = () =>
      [...host.querySelectorAll('.workspace-rail__agents-list')].map(
        (el) => el.textContent ?? '',
      );

    try {
      renderWith('mission-running');
      expect(agentLists().some((t) => t.includes('agente A'))).toBe(true);
      expect(agentLists().some((t) => t.includes('agente B'))).toBe(false);
      // Navegou para B depois do mount: os agentes dela expandem sozinhos.
      renderWith('mission-blocked');
      expect(agentLists().some((t) => t.includes('agente B'))).toBe(true);
    } finally {
      act(() => {
        root.unmount();
        useLayoutStore.setState({ root: previousRoot });
      });
    }
  });

  it('sem metadados do adapter, mantém o selo de texto da CLI', () => {
    const previousRoot = useLayoutStore.getState().root;
    const pane = {
      ...createPane('cli-agent', undefined, 'minha-cli'),
      id: 'pane-unknown',
      title: 'tarefa obscura',
      missionId: 'mission-running',
    };
    act(() => {
      useLayoutStore.setState({ root: createLeaf(pane) });
      useAdapterStore.getState().receive([]);
    });

    try {
      const { host } = renderRail({
        selection: { kind: 'mission', missionId: 'mission-running' },
      });
      expect(
        host.querySelector('.workspace-rail__agent-adapter')?.textContent,
      ).toBe('minha-cli');
    } finally {
      act(() => {
        useLayoutStore.setState({ root: previousRoot });
      });
    }
  });
});
