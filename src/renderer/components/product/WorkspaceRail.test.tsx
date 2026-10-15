/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceRail,
  type WorkspaceRailProps,
  type WorkspaceRailWorkspace,
} from './WorkspaceRail';
import { useTerminalGridDialogStore } from '../../state/terminal-grid-dialog-store';
import { useQuotaStore } from '../../state/quota-store';
import { useBugReportDialogStore } from '../../state/bug-report-dialog-store';
import { useAdapterStore } from '../../state/adapter-store';
import { useLayoutStore } from '../../state/layout-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { usePaneFootprintStore } from '../../state/pane-footprint-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { usePaneParkedStore } from '../../state/pane-parked-store';
import type { PaneModel, PaneSessionState } from '../../../shared/types';
import { buildGridTree, createLeaf, createPane } from '../../lib/split-tree';

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
  it('mantém "Reportar bug" à vista no topo do rail e abre o diálogo de problema', () => {
    useBugReportDialogStore.setState({ isOpen: false });
    const { host } = renderRail();
    const report = host.querySelector(
      'header.workspace-rail__identity [aria-label="Reportar um problema"]',
    ) as HTMLButtonElement | null;
    expect(report, 'o botão mora no cabeçalho do rail, que não some em nenhuma tela').not.toBeNull();
    expect(report?.textContent).toContain('Reportar bug');
    act(() => report!.click());
    expect(useBugReportDialogStore.getState().isOpen).toBe(true);
    act(() => useBugReportDialogStore.getState().close());
  });

  it('offers one new request action before a stable navigation and the history', () => {
    const { host, handlers } = renderRail({ onOpenLauncher: vi.fn() });
    const create = host.querySelectorAll('[aria-label="Novo pedido"], [data-testid="rail-new-mission"]');
    expect(create).toHaveLength(1);
    expect(create[0]?.textContent).toContain('Novo pedido');
    const destinations = host.querySelector('[aria-label="Destinos fixos"]')!;
    const history = host.querySelector('.workspace-rail__scroll')!;
    expect(destinations.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(history.contains(create[0]!)).toBe(false);
    act(() => (create[0] as HTMLButtonElement).click());
    expect(handlers.onCreateNew).toHaveBeenCalledOnce();
  });

  it('shows each request title and state without repeating its project or branch', () => {
    const { host } = renderRail();
    const request = host.querySelector('[data-mission-id="mission-running"]')!;
    expect(request.textContent).toContain('Corrigir o login');
    expect(request.textContent).toContain('Trabalhando');
    expect(request.querySelector('.workspace-rail__mission-repo-chip')).toBeNull();
    expect(request.querySelector('.workspace-rail__mission-branch')).toBeNull();
  });

  it('groups the entry actions and packs destinations in a compact grid', () => {
    const { host } = renderRail({ onOpenLauncher: vi.fn(), onOpenWorkspace: vi.fn() });
    const actions = host.querySelector('.workspace-rail__actions')!;
    const destinations = host.querySelector('[aria-label="Destinos fixos"]')!;
    const open = host.querySelector('[aria-label="Abrir projeto existente"]')!;
    expect(actions.contains(open)).toBe(true);
    expect(destinations.contains(open)).toBe(false);
    const wide = (label: string) =>
      host
        .querySelector(`[aria-label="${label}"]`)!
        .closest('li')!
        .classList.contains('workspace-rail__fixed-item--wide');
    expect(wide('Abrir Terminais')).toBe(true);
    // Sem Projeto, Início não deixa buraco na primeira linha da grade.
    expect(wide('Voltar ao Início')).toBe(true);
    expect(wide('Abrir Quadro')).toBe(false);
  });

  it('opens an existing project without entering the creation flow', () => {
    const onOpenWorkspace = vi.fn();
    const { host, handlers } = renderRail({ onOpenWorkspace });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Abrir projeto existente"]')!.click());
    expect(onOpenWorkspace).toHaveBeenCalledOnce();
    expect(handlers.onCreateNew).not.toHaveBeenCalled();
  });

  it('keeps destinations and settings outside the scrollable mission history', () => {
    const { host } = renderRail({ onOpenLauncher: vi.fn(), projectEnabled: true, onOpenProject: vi.fn() });
    const body = host.querySelector('.workspace-rail__scroll');
    expect(body).not.toBeNull();
    expect(body?.contains(host.querySelector('[data-rail-group="active"]'))).toBe(true);
    expect(body?.contains(host.querySelector('[data-rail-group="recent"]'))).toBe(true);
    expect(body?.contains(host.querySelector('[aria-label="Destinos fixos"]'))).toBe(false);
    expect(body?.contains(host.querySelector('.workspace-rail__identity'))).toBe(false);
    expect(body?.contains(host.querySelector('.workspace-rail__footer'))).toBe(false);
  });

  it('removes a mission from either group without selecting or opening it', () => {
    const onRemoveMission = vi.fn();
    const { host, handlers } = renderRail({ onRemoveMission });
    for (const missionId of ['mission-running', 'mission-blocked', 'mission-done']) {
      const remove = host.querySelector<HTMLButtonElement>(
        `[data-action="remove-mission"][data-mission-id="${missionId}"]`,
      );
      expect(remove).not.toBeNull();
      act(() => remove!.click());
      expect(onRemoveMission).toHaveBeenLastCalledWith(missionId, missionId === 'mission-done' ? 'cometa' : 'atlas');
    }
    expect(handlers.onSelectMission).not.toHaveBeenCalled();
    expect(handlers.onSelectWorkspace).not.toHaveBeenCalled();
  });

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

    // 11 estados, página de 10: expande para cobrir a matriz inteira.
    act(() => {
      host
        .querySelector<HTMLButtonElement>('.workspace-rail__missions-more')!
        .click();
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

  it('missão completed aguardando revisão humana mostra a entrega pronta com tom de conclusão', () => {
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
    expect(row?.textContent).toContain('Pronto para revisar');
    expect(row?.textContent).not.toContain('Aguardando você');
    expect(row?.getAttribute('aria-label')).toBe('Landing. Pronto para revisar');
    expect(row?.classList.contains('workspace-rail__mission--done')).toBe(true);
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

  it('Maestro vivo esperando instrução pinta Aguardando com tom pronto', () => {
    const { host } = renderRail({
      activeWorkspaces: [
        {
          id: 'idle',
          name: 'Idle',
          missions: [
            {
              id: 'mission-aguardando',
              title: 'Idle',
              status: 'running',
              needsAttention: false,
              stateReason: {
                code: 'awaiting-instruction',
                label: 'Aguardando sua instrução',
              },
            },
          ],
        },
      ],
      recentWorkspaces: [],
    });
    const row = host.querySelector('[data-mission-id="mission-aguardando"]');
    expect(row?.textContent).toContain('Aguardando');
    expect(row?.textContent).not.toContain('Trabalhando');
    expect(row?.classList.contains('workspace-rail__mission--ready')).toBe(true);
    expect(row?.classList.contains('workspace-rail__mission--blocked')).toBe(
      false,
    );
  });

  it('Novo pedido abre o fluxo simples no projeto atual', () => {
    const { host, handlers } = renderRail();

    const cta = host.querySelector<HTMLButtonElement>(
      '[data-testid="rail-new-mission"]',
    );
    expect(cta?.textContent).toContain('Novo pedido');
    act(() => {
      cta?.click();
    });
    expect(handlers.onCreateNew).toHaveBeenCalledOnce();
  });

  it('routes Novo, workspaces, missions, fixed destinations and settings', () => {
    const { host, handlers } = renderRail();

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="Novo pedido"]')?.click();
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

    const onOpenUsageQuota = vi.fn();
    const { host } = renderRail({ onOpenUsageQuota });
    const cockpit = host.querySelector('.workspace-rail__cockpit');
    expect(cockpit).toBeTruthy();
    expect(cockpit?.textContent).toContain('Claude');
    expect(cockpit?.textContent).toContain('35%');
    // Com poucas contas não há o que expandir: o cabeçalho (um botão de
    // verdade, alcançável por teclado) leva direto ao uso e cotas.
    const header = cockpit!.querySelector('.workspace-rail__cockpit-header') as HTMLButtonElement;
    expect(header.tagName).toBe('BUTTON');
    act(() => header.click());
    expect(onOpenUsageQuota).toHaveBeenCalledTimes(1);

    const conn = host.querySelector('.workspace-rail__cockpit-conn');
    expect(conn?.textContent).toContain('Local');
  });

  it('F-1172: pressão de memória aparece no rodapé do rail e leva a Uso e cotas', () => {
    const GiB = 1024 ** 3;
    usePaneFootprintStore.setState({ machine: null });
    const onOpenUsageQuota = vi.fn();
    const { host } = renderRail({ onOpenUsageQuota });
    const footer = host.querySelector('.workspace-rail__footer')!;
    expect(footer.textContent).not.toContain('Memória sob pressão');

    act(() =>
      usePaneFootprintStore.setState({
        machine: {
          sampledAt: Date.now(),
          memory: {
            totalBytes: 16 * GiB,
            availableBytes: 1 * GiB,
            usedRatio: 15 / 16,
            peakUsedRatio: 15 / 16,
            swapUsedBytes: null,
            minFreeBytes: 2.4 * GiB,
          },
          cpu: { cores: 8, loadAvg1: 1, averageLoad1: 1 },
          nexus: { appBytes: null, panesBytes: null, paneCount: 0 },
          pressure: 'pressure',
          admissionEnabled: true,
          window: { samples: 1, spanMs: 0 },
        },
      }),
    );
    const indicator = footer.querySelector('.workspace-rail__pressure') as HTMLButtonElement;
    expect(indicator.textContent).toContain('Memória sob pressão');
    act(() => indicator.click());
    expect(onOpenUsageQuota).toHaveBeenCalledTimes(1);
    act(() => usePaneFootprintStore.setState({ machine: null }));
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
    expect(cockpit?.textContent).toContain('5h 35% · Sem 41%');
    expect(cockpit?.querySelector('[role="img"][aria-label="Logo Claude"]')).not.toBeNull();
    // A barra e o valor refletem a PIOR janela (41%), não a primeira.
    expect(cockpit?.textContent).toContain('41%');
  });

  it('esconde percentual antigo de uma conta Claude com identidade trocada', () => {
    const now = Date.now();
    act(() => useQuotaStore.getState().receive({
      updatedAt: now,
      entries: [{
        id: 'claude:owner', adapterId: 'claude', accountId: 'owner',
        label: 'Claude · Conta Claude', installed: true, onCooldown: true,
        readHint: 'identity-mismatch', updatedAt: now,
        windows: [{ kind: 'weekly', label: 'Semanal', usedRatio: 0.86,
          source: 'provider-api', confidence: 'high' }],
      }],
      worstUsedRatio: 0.86, highUsageCount: 1, unknownCount: 0,
    }));
    const { host } = renderRail();
    const item = host.querySelector('.workspace-rail__quota-item');
    expect(item?.textContent).toContain('relogin');
    expect(item?.textContent).not.toContain('86%');
    expect(item?.getAttribute('title')).toContain('credencial de outra conta Claude');
    expect(item?.textContent).not.toContain('pausa');
    expect(item?.classList.contains('workspace-rail__quota-item--cool')).toBe(false);
  });

  it('conta em cooldown mostra a telemetria real + selo pausa — nunca 100% falso', () => {
    // Regressão do bug real: conta "retornoja" em cooldown(quota) aparecia com
    // barra 100% vermelha enquanto o serviço reportava Semanal 54%.
    const now = Date.now();
    act(() => {
      useQuotaStore.getState().receive({
        updatedAt: now,
        entries: [
          {
            id: 'codex:ret',
            adapterId: 'codex',
            accountId: 'ret',
            label: 'Codex · retornoja@gmail.com',
            installed: true,
            onCooldown: true,
            cooldownKind: 'quota',
            cooldownUntil: now + 3 * 60 * 60_000,
            updatedAt: now,
            windows: [
              {
                kind: 'hours',
                label: '5 Horas',
                usedRatio: null,
                source: 'unknown',
                confidence: 'low',
              },
              {
                kind: 'weekly',
                label: 'Semanal',
                usedRatio: 0.54,
                source: 'provider-api',
                confidence: 'high',
              },
            ],
          },
        ],
        worstUsedRatio: 0.54,
        highUsageCount: 0,
        unknownCount: 0,
      });
    });

    const { host } = renderRail();
    const cockpit = host.querySelector('.workspace-rail__cockpit');
    const val = cockpit?.querySelector('.workspace-rail__quota-val');
    expect(val?.textContent).toBe('54%');
    expect(cockpit?.textContent).not.toContain('100%');
    expect(cockpit?.querySelector('.workspace-rail__quota-pause')).not.toBeNull();
    const item = cockpit?.querySelector('.workspace-rail__quota-item--cool');
    expect(item).not.toBeNull();
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

  it('ao focar um agente, preserva a missão e abre apenas os terminais dela', () => {
    const previousRoot = useLayoutStore.getState().root;
    const previousDestination = useProductNavigationStore.getState().destination;
    const previousSettingsReturn =
      useProductNavigationStore.getState().settingsReturnDestination;
    const pane = {
      ...createPane('cli-agent', undefined, 'claude'),
      id: 'pane-mission-scoped',
      title: 'agente da missão',
      missionId: 'mission-running',
    };
    act(() => {
      useLayoutStore.setState({ root: createLeaf(pane), focusedPaneId: null });
      useProductNavigationStore.setState({
        destination: { kind: 'launcher' },
        settingsReturnDestination: null,
      });
    });

    try {
      const { host } = renderRail({
        selection: { kind: 'mission', missionId: 'mission-running' },
      });
      const agent = host.querySelector<HTMLButtonElement>(
        '.workspace-rail__agent-btn',
      );
      expect(agent).not.toBeNull();

      act(() => agent!.click());

      expect(useLayoutStore.getState().focusedPaneId).toBe(
        'pane-mission-scoped',
      );
      expect(useProductNavigationStore.getState().destination).toEqual({
        kind: 'mission',
        missionId: 'mission-running',
        surface: 'terminals',
      });
    } finally {
      act(() => {
        useLayoutStore.setState({ root: previousRoot });
        useProductNavigationStore.setState({
          destination: previousDestination,
          settingsReturnDestination: previousSettingsReturn,
        });
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
    const twoPaneRoot = buildGridTree([paneA, paneB]);
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

  it('pagina a lista de missões por pasta (10 por vez)', () => {
    const missions = Array.from({ length: 12 }, (_, index) => ({
      id: `mission-many-${index}`,
      title: `Missão ${index}`,
      status: 'completed' as const,
      needsAttention: false,
    }));
    const { host } = renderRail({
      activeWorkspaces: [{ id: 'atlas', name: 'Atlas local', missions }],
      selection: { kind: 'mission', missionId: 'mission-many-2' },
    });

    expect(
      host.querySelectorAll('[data-mission-id^="mission-many-"]').length,
    ).toBe(10);
    expect(
      host.querySelector('[data-mission-id="mission-many-10"]'),
    ).toBeNull();
    const more = host.querySelector<HTMLButtonElement>(
      '.workspace-rail__missions-more',
    );
    expect(more?.textContent).toContain('Mostrar mais 2');

    act(() => more!.click());
    expect(
      host.querySelectorAll('[data-mission-id^="mission-many-"]').length,
    ).toBe(12);
    const less = host.querySelector<HTMLButtonElement>(
      '.workspace-rail__missions-more',
    );
    expect(less?.textContent).toContain('Mostrar menos');

    act(() => less!.click());
    expect(
      host.querySelectorAll('[data-mission-id^="mission-many-"]').length,
    ).toBe(10);
  });

  it('a missão selecionada além da página abre a lista até ela', () => {
    const missions = Array.from({ length: 12 }, (_, index) => ({
      id: `mission-many-${index}`,
      title: `Missão ${index}`,
      status: 'completed' as const,
      needsAttention: false,
    }));
    const { host } = renderRail({
      activeWorkspaces: [{ id: 'atlas', name: 'Atlas local', missions }],
      selection: { kind: 'mission', missionId: 'mission-many-11' },
    });

    expect(
      host.querySelector('[data-mission-id="mission-many-11"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('.workspace-rail__missions-more'),
    ).toBeNull();
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
  it('mantém a limpeza destrutiva recolhida em vez de fixá-la sobre a lista de projetos', () => {
    const previous = useWorkspaceStore.getState().current;
    act(() => {
      useWorkspaceStore.setState({
        current: { path: '/projetos/atlas', name: 'Atlas local', lastOpenedAt: 1 },
      });
    });

    try {
      const { host } = renderRail();
      // F-528: a limpeza vive numa linha compacta SEMPRE visível — as ações
      // destrutivas não podem sumir atrás de disclosure (o dono as procurou).
      const cleanup = host.querySelector('.workspace-cleanup');
      expect(cleanup).not.toBeNull();
      expect(host.querySelector('[data-action="clean-panes"]')).not.toBeNull();
      expect(host.querySelector('[data-action="clean-missions"]')).not.toBeNull();
    } finally {
      act(() => {
        useWorkspaceStore.setState({ current: previous });
      });
    }
  });

  it('marca o projeto aberto agora com o selo "atual", mesmo com outra missão selecionada', () => {
    const { host } = renderRail({
      currentWorkspaceId: 'atlas',
      selection: { kind: 'mission', missionId: 'mission-done' },
    });

    const current = host.querySelector<HTMLButtonElement>(
      '[data-workspace-id="atlas"]',
    )!;
    expect(current.dataset.current).toBe('true');
    expect(current.className).toContain('workspace-rail__workspace--current');
    expect(
      current.querySelector('.workspace-rail__workspace-current')?.textContent,
    ).toBe('atual');
    expect(current.getAttribute('aria-label')).toBe(
      'Projeto aberto agora: Atlas local',
    );
    expect(current.title).toContain('Projeto aberto agora');
    // O apelido continua limpo: o selo é um irmão, não parte do nome.
    expect(current.querySelector('.workspace-rail__row-label')?.textContent).toBe(
      'Atlas local',
    );
    // A seleção (missão do Cometa) não confunde com "onde estamos".
    expect(current.getAttribute('aria-current')).toBeNull();
    const other = host.querySelector<HTMLButtonElement>(
      '[data-workspace-id="cometa"]',
    )!;
    expect(other.dataset.current).toBeUndefined();
    expect(other.querySelector('.workspace-rail__workspace-current')).toBeNull();
    expect(other.getAttribute('aria-label')).toBe('Abrir workspace Cometa');
  });

  it('pasta do projeto atual sumiu do disco: o selo diz isso no lugar de "atual"', () => {
    const { host } = renderRail({
      currentWorkspaceId: 'atlas',
      currentWorkspaceMissing: true,
    });

    const current = host.querySelector<HTMLButtonElement>(
      '[data-workspace-id="atlas"]',
    )!;
    expect(current.dataset.missing).toBe('true');
    const badge = current.querySelector('.workspace-rail__workspace-current')!;
    expect(badge.textContent).toBe('pasta sumiu');
    expect(badge.className).toContain('workspace-rail__workspace-current--missing');
    expect(current.getAttribute('aria-label')).toContain('não existe mais no disco');
    // Só o projeto aberto pode "sumir"; um recente não herda o estado.
    expect(
      host.querySelector('[data-workspace-id="cometa"]')?.getAttribute('data-missing'),
    ).toBeNull();
  });

  it('mostra o caminho da pasta na linha do projeto, não só o apelido', () => {
    const { host } = renderRail({
      recentWorkspaces: [
        {
          id: '/Users/ana/dev/cometa',
          path: '/Users/ana/dev/cometa',
          name: 'Cometa',
          missions: [],
        },
      ],
    });

    const row = host.querySelector<HTMLButtonElement>(
      '[data-workspace-id="/Users/ana/dev/cometa"]',
    );
    expect(row).not.toBeNull();
    expect(row!.title).toContain('/Users/ana/dev/cometa');
    expect(row!.getAttribute('aria-label')).toContain('/Users/ana/dev/cometa');
    expect(
      host.querySelector('.workspace-rail__workspace-path')?.textContent,
    ).toBe('…/dev/cometa');
  });

  it('conta as pastas de Recentes, que nunca têm missões para contar', () => {
    const { host } = renderRail({
      recentWorkspaces: [
        { id: '/a', path: '/a', name: 'Alfa', missions: [] },
        { id: '/b', path: '/b', name: 'Beta', missions: [] },
        { id: '/c', path: '/c', name: 'Gama', missions: [] },
      ],
    });

    const recent = host.querySelector('[data-rail-group="recent"]');
    expect(
      recent?.querySelector('.workspace-rail__group-pill')?.textContent,
    ).toBe('3');
  });

  it('contador de Em andamento bate com os repositórios listados, não com as missões', () => {
    const { host } = renderRail({
      activeWorkspaces: [
        {
          id: '/hipergo',
          path: '/hipergo',
          name: 'hipergo',
          livePaneCount: 2,
          missions: [],
        },
        {
          id: '/nexus-ide',
          path: '/nexus-ide',
          name: 'nexus-ide',
          missions: [
            {
              id: 'm1',
              title: 'bug visual windows analisando layout da barra lateral',
              status: 'running',
              needsAttention: false,
              updatedAt: Date.now() - 9 * 60_000,
            },
          ],
        },
      ],
      recentWorkspaces: [
        { id: '/saas', path: '/saas', name: 'saasbarbearia', missions: [] },
      ],
    });
    const active = host.querySelector('[data-rail-group="active"]');
    expect(
      active?.querySelector('.workspace-rail__group-pill')?.textContent,
    ).toBe('2');
    // A missão fica agrupada sob o repositório dela, com estado e panes.
    const nexusRow = host.querySelector('[data-workspace-id="/nexus-ide"]');
    expect(nexusRow?.closest('li')?.textContent).toContain('1 missão');
    expect(nexusRow?.closest('li')?.textContent).toContain(
      'bug visual windows analisando layout da barra lateral',
    );
    const hiperRow = host.querySelector('[data-workspace-id="/hipergo"]');
    expect(hiperRow?.closest('li')?.textContent).toContain('2 panes abertos');
    // Nenhum repositório listado em Em andamento reaparece em Recentes.
    const recent = host.querySelector('[data-rail-group="recent"]');
    expect(recent?.textContent).toContain('saasbarbearia');
    expect(recent?.textContent).not.toContain('nexus-ide');
  });

  it('separa as utilidades encolhíveis da linha de Configurações, que fica sempre visível', () => {
    const { host } = renderRail();
    const utilities = host.querySelector('.workspace-rail__utilities');
    const pinned = host.querySelector('.workspace-rail__cockpit-status');

    expect(utilities).not.toBeNull();
    expect(pinned).not.toBeNull();
    expect(utilities!.contains(pinned)).toBe(false);
    expect(
      utilities!.compareDocumentPosition(pinned!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it('desenha a branch do worktree como nó da árvore, e nada para missão sem worktree', () => {
    const { host } = renderRail({
      activeWorkspaces: [
        {
          id: 'atlas',
          name: 'Atlas local',
          missions: [
            { id: 'm-solta', title: 'Sem worktree', status: 'running', needsAttention: false },
            {
              id: 'm-branch',
              title: 'Com worktree',
              status: 'running',
              needsAttention: false,
              worktrees: [{ branch: 'feat/mf-103-operacao-furos', status: 'queued' }],
            },
          ],
        },
      ],
      selection: { kind: 'mission', missionId: 'm-solta' },
    });
    const branch = host.querySelector('[data-rail-branch="feat/mf-103-operacao-furos"]');
    expect(branch).not.toBeNull();
    expect(branch!.textContent).toContain('feat/mf-103-operacao-furos');
    expect(branch!.textContent).toContain('na fila');
    // A missão solta vem antes do nó de branch, direto sob o projeto.
    const list = host.querySelector('.workspace-rail__mission-list')!;
    const order = [...list.children].map((el) =>
      el.getAttribute('data-rail-branch') ?? el.querySelector('[data-mission-id]')?.getAttribute('data-mission-id'),
    );
    expect(order).toEqual(['m-solta', 'feat/mf-103-operacao-furos', 'm-branch']);
    expect(host.querySelectorAll('.workspace-rail__branch')).toHaveLength(1);
  });

  it('recolhe as missões de um projeto e lembra disso; a seleção nunca some', () => {
    localStorage.clear();
    const { host } = renderRail({ selection: null });
    const toggle = host.querySelector<HTMLButtonElement>(
      '[data-action="toggle-workspace"][data-workspace-id="atlas"]',
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-mission-id="mission-running"]')).not.toBeNull();

    act(() => toggle.click());
    expect(host.querySelector('[data-mission-id="mission-running"]')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('2');
    expect(JSON.parse(localStorage.getItem('nexus.activityRail.collapsedWorkspaces') ?? '[]')).toEqual(['atlas']);

    // Projeto recolhido, mas a missão selecionada mora nele: continua à vista.
    const { host: second } = renderRail({ selection: { kind: 'mission', missionId: 'mission-running' } });
    expect(second.querySelector('[data-mission-id="mission-running"]')).not.toBeNull();
    localStorage.clear();
  });
  it('mostra a idade da missão sem segundos, ao lado do estado', () => {
    const { host } = renderRail({
      activeWorkspaces: [
        {
          id: 'atlas',
          name: 'Atlas local',
          missions: [
            { id: 'm-5min', title: 'Cinco minutos', status: 'running', needsAttention: false, updatedAt: Date.now() - 5 * 60_000 },
            { id: 'm-sem-idade', title: 'Sem idade', status: 'running', needsAttention: false },
          ],
        },
      ],
      selection: null,
    });
    expect(host.querySelector('[data-mission-id="m-5min"] .workspace-rail__mission-age')?.textContent).toBe('5m');
    expect(host.querySelector('[data-mission-id="m-sem-idade"] .workspace-rail__mission-age')).toBeNull();
  });
});

/**
 * Quem está trabalhando agora: o operador abria o rail e via "3 agentes"
 * recolhido, cada um com o título cortado — com mais de um agente rodando em
 * paralelo não dava para saber QUEM trabalhava.
 */
describe('WorkspaceRail — agentes trabalhando agora', () => {
  const agentPane = (
    patch: Partial<PaneModel> & { id: string },
  ): PaneModel => ({
    kind: 'cli-agent',
    title: '',
    adapterId: 'claude',
    ...patch,
  });

  const CLAUDE = {
    id: 'claude',
    kind: 'cli-pty' as const,
    label: 'Claude',
    icon: '◆',
    models: { list: ['sonnet'], default: 'sonnet' },
    installed: true,
    installCommand: 'npm i -g claude',
    idleTimeoutMs: 800,
    orchestratorCapable: true,
  };

  /** Monta o layout, aplica os estados reais pela store e devolve o restauro. */
  function seedFleet(
    panes: PaneModel[],
    states: Record<string, PaneSessionState>,
  ): () => void {
    const previousRoot = useLayoutStore.getState().root;
    act(() => {
      useLayoutStore.setState({ root: buildGridTree(panes), focusedPaneId: null });
      useAdapterStore.getState().receive([CLAUDE]);
      for (const [paneId, state] of Object.entries(states)) {
        useSessionStateStore.getState().setPaneState(paneId, state);
      }
    });
    return () => {
      act(() => {
        useLayoutStore.setState({ root: previousRoot });
        useAdapterStore.getState().receive([]);
        for (const paneId of Object.keys(states)) {
          useSessionStateStore.getState().clearPaneState(paneId);
        }
        usePaneParkedStore.setState({ parked: new Map() });
      });
    };
  }

  const MISSION_PANES: PaneModel[] = [
    agentPane({
      id: 'orq',
      role: 'orchestrator',
      agentName: 'Maestro',
      missionId: 'mission-running',
      paneNumber: 1,
      title: 'Claude · Coordenar a entrega',
    }),
    agentPane({
      id: 'fe',
      agentName: 'Frontend',
      adapterId: 'codex',
      model: 'gpt-5.6-luna-medium',
      missionId: 'mission-running',
      paneNumber: 2,
      title: 'GPT · Corrigir histórico omitido ao mudar de aba',
    }),
    agentPane({
      id: 'rev',
      agentName: 'Revisor',
      missionId: 'mission-running',
      paneNumber: 3,
      title: 'Claude · Revisar o diff',
    }),
  ];

  const missionRow = (host: HTMLElement, id: string) =>
    host.querySelector<HTMLElement>(`[data-mission-id="${id}"]`)!.closest('li')!;

  beforeEach(() => {
    localStorage.clear();
  });

  it('a missão com agente trabalhando abre sozinha, sem clique e sem estar selecionada', () => {
    const restore = seedFleet(MISSION_PANES, { orq: 'busy', fe: 'busy', rev: 'idle' });
    try {
      const { host } = renderRail({ selection: null });
      const card = missionRow(host, 'mission-running');

      expect(card.querySelector('.workspace-rail__agents-toggle')!.textContent).toContain(
        '2 trabalhando agora',
      );
      expect(card.querySelector('.workspace-rail__live-tag')?.textContent).toBe('em paralelo');
      const items = [...card.querySelectorAll<HTMLElement>('.workspace-rail__agent-item')];
      expect(items.map((item) => item.dataset.paneId)).toEqual(['orq', 'fe', 'rev']);
      expect(items.map((item) => item.dataset.agentState)).toEqual([
        'working',
        'working',
        'waiting',
      ]);
      // A outra missão não tem agente nenhum: nada de bloco.
      expect(
        missionRow(host, 'mission-blocked').querySelector('.workspace-rail__agents-block'),
      ).toBeNull();
    } finally {
      restore();
    }
  });

  it('missão com todos aguardando segue recolhida e diz que ninguém trabalha', () => {
    const restore = seedFleet(MISSION_PANES, { orq: 'idle', fe: 'idle', rev: 'idle' });
    try {
      const { host } = renderRail({ selection: null });
      const card = missionRow(host, 'mission-running');

      expect(card.querySelector('.workspace-rail__agents-toggle')!.textContent).toContain(
        '3 agentes · aguardando',
      );
      expect(card.querySelector('.workspace-rail__agents-list')).toBeNull();
    } finally {
      restore();
    }
  });

  it('recolher é escolha do operador e os agentes que trabalham não somem com ela', () => {
    const restore = seedFleet(MISSION_PANES, { orq: 'busy', fe: 'idle', rev: 'idle' });
    try {
      const { host } = renderRail({ selection: null });
      const card = missionRow(host, 'mission-running');
      const toggle = card.querySelector<HTMLButtonElement>('.workspace-rail__agents-toggle')!;
      const visibleIds = () =>
        [...card.querySelectorAll<HTMLElement>('.workspace-rail__agent-item')].map(
          (item) => item.dataset.paneId,
        );

      expect(visibleIds()).toEqual(['orq', 'fe', 'rev']);
      act(() => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(visibleIds()).toEqual(['orq']);
      act(() => toggle.click());
      expect(visibleIds()).toEqual(['orq', 'fe', 'rev']);
    } finally {
      restore();
    }
  });

  it('a linha do projeto aberto diz "N trabalhando agora" e o vizinho não inventa contagem', () => {
    const restore = seedFleet(MISSION_PANES, { orq: 'busy', fe: 'busy', rev: 'busy' });
    try {
      const { host } = renderRail({
        selection: null,
        currentWorkspaceId: 'atlas',
        activeWorkspaces: [
          ...activeWorkspaces,
          { id: 'cometa', name: 'Cometa', missions: [] },
        ],
      });
      const current = host.querySelector<HTMLButtonElement>('[data-workspace-id="atlas"]')!;
      const neighbour = host.querySelector<HTMLButtonElement>('[data-workspace-id="cometa"]')!;

      expect(current.querySelector('.workspace-rail__workspace-live')!.textContent).toBe(
        '3 trabalhando agoraem paralelo',
      );
      expect(current.getAttribute('aria-label')).toBe(
        'Projeto aberto agora: Atlas local. 3 trabalhando agora',
      );
      expect(current.title).toContain('3 trabalhando agora');
      expect(neighbour.querySelector('.workspace-rail__workspace-live')).toBeNull();
      expect(neighbour.getAttribute('aria-label')).toBe('Abrir workspace Cometa');
    } finally {
      restore();
    }
  });

  it('a faixa fixa mostra quantos trabalham em Terminais, fora da rolagem', () => {
    const restore = seedFleet(MISSION_PANES, { orq: 'busy', fe: 'idle', rev: 'busy' });
    try {
      const { host } = renderRail({ selection: null });
      const terminals = host.querySelector<HTMLButtonElement>('[aria-label="Abrir Terminais"]')!;
      const chip = terminals.querySelector('.workspace-rail__live-chip')!;

      expect(chip.textContent).toContain('2');
      expect(chip.textContent).toContain('2 trabalhando agora');
      expect(chip.getAttribute('title')).toBe('2 trabalhando agora');
      expect(host.querySelector('.workspace-rail__scroll')!.contains(chip)).toBe(false);
      // O nome acessível não muda; a contagem entra como descrição.
      expect(terminals.getAttribute('aria-describedby')).toBe(chip.id);
      // A contagem de panes continua ao lado.
      expect(terminals.querySelector('.workspace-rail__row-count')!.textContent).toBe('3');
    } finally {
      restore();
    }
  });

  it('sem ninguém trabalhando a faixa fixa e a linha do projeto ficam quietas', () => {
    const restore = seedFleet(MISSION_PANES, { orq: 'idle', fe: 'exited', rev: 'idle' });
    try {
      const { host } = renderRail({ selection: null, currentWorkspaceId: 'atlas' });

      expect(host.querySelector('.workspace-rail__live-chip')).toBeNull();
      expect(host.querySelector('.workspace-rail__workspace-live')).toBeNull();
      expect(
        host.querySelector('[aria-label="Abrir Terminais"]')!.hasAttribute('aria-describedby'),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it('agentes fora de missão aparecem sob o projeto aberto, com o mesmo destaque', () => {
    const restore = seedFleet(
      [
        agentPane({ id: 'solto-a', paneNumber: 4, title: 'Claude · Ajustar o login' }),
        agentPane({ id: 'solto-b', adapterId: 'grok', paneNumber: 5, title: 'Grok' }),
        { id: 'sh', kind: 'shell', title: 'zsh' },
      ],
      { 'solto-a': 'busy', 'solto-b': 'idle' },
    );
    try {
      const { host } = renderRail({
        selection: null,
        currentWorkspaceId: 'atlas',
        activeWorkspaces: [{ id: 'atlas', name: 'Atlas local', missions: [], livePaneCount: 3 }],
      });
      const loose = host.querySelector('.workspace-rail__loose-agents')!;

      expect(loose).not.toBeNull();
      expect(
        loose.querySelector('.workspace-rail__agents-toggle')!.getAttribute('aria-label'),
      ).toBe('Terminais: 2 agentes, 1 trabalhando agora');
      // O título visível do bloco: sem ele "2 agentes" não diz de quem são.
      expect(loose.querySelector('.workspace-rail__agents-scope')!.textContent).toBe('Terminais');
      const items = [...loose.querySelectorAll<HTMLElement>('.workspace-rail__agent-item')];
      expect(items.map((item) => item.dataset.paneId)).toEqual(['solto-a', 'solto-b']);
      expect(items[0]!.querySelector('.workspace-rail__agent-task')!.textContent).toBe(
        'Ajustar o login',
      );
      // O shell nunca é contado como agente.
      expect(host.querySelector('.workspace-rail__workspace-live')!.textContent).toBe(
        '1 trabalhando agora',
      );
    } finally {
      restore();
    }
  });

  it('agentes soltos não ficam presos num projeto recolhido que nem tem missões para reabrir', () => {
    localStorage.setItem('nexus.activityRail.collapsedWorkspaces', JSON.stringify(['atlas']));
    const restore = seedFleet([agentPane({ id: 'solto', paneNumber: 4 })], { solto: 'busy' });
    try {
      const { host } = renderRail({
        selection: null,
        currentWorkspaceId: 'atlas',
        activeWorkspaces: [{ id: 'atlas', name: 'Atlas local', missions: [], livePaneCount: 1 }],
      });

      expect(host.querySelector('.workspace-rail__loose-agents')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('clicar num agente solto foca o pane e abre os Terminais', () => {
    const previousDestination = useProductNavigationStore.getState().destination;
    const restore = seedFleet([agentPane({ id: 'solto', paneNumber: 4 })], { solto: 'busy' });
    try {
      act(() => useProductNavigationStore.setState({ destination: { kind: 'launcher' } }));
      const { host } = renderRail({
        selection: null,
        currentWorkspaceId: 'atlas',
        activeWorkspaces: [{ id: 'atlas', name: 'Atlas local', missions: [], livePaneCount: 1 }],
      });

      act(() => host.querySelector<HTMLButtonElement>('.workspace-rail__agent-btn')!.click());

      expect(useLayoutStore.getState().focusedPaneId).toBe('solto');
      expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'terminal' });
    } finally {
      restore();
      act(() => useProductNavigationStore.setState({ destination: previousDestination }));
    }
  });

  it('estacionado pelo guardian aparece dormindo e não conta como trabalho', () => {
    const restore = seedFleet(MISSION_PANES, { orq: 'busy', fe: 'busy', rev: 'idle' });
    try {
      act(() =>
        usePaneParkedStore
          .getState()
          .markParked('fe', { sessionId: 's', parkedAt: 1, reason: 'idle' }),
      );
      const { host } = renderRail({ selection: null });
      const card = missionRow(host, 'mission-running');
      const parked = card.querySelector<HTMLElement>('[data-pane-id="fe"]')!;

      expect(parked.dataset.agentState).toBe('sleeping');
      expect(parked.querySelector('.workspace-rail__agent-state')!.textContent).toBe('Dormindo');
      expect(card.querySelector('.workspace-rail__agents-toggle')!.textContent).toContain(
        '1 trabalhando agora',
      );
      expect(card.querySelector('.workspace-rail__live-tag')).toBeNull();
    } finally {
      restore();
    }
  });

  it('o estado muda ao vivo sem mexer na ordem das linhas', () => {
    vi.useFakeTimers();
    const restore = seedFleet(MISSION_PANES, { orq: 'busy', fe: 'busy', rev: 'idle' });
    try {
      const { host } = renderRail({ selection: null });
      const card = missionRow(host, 'mission-running');
      const order = () =>
        [...card.querySelectorAll<HTMLElement>('.workspace-rail__agent-item')].map(
          (item) => item.dataset.paneId,
        );
      expect(order()).toEqual(['orq', 'fe', 'rev']);

      // O revisor começa e o Frontend termina: o busy do Frontend segura um
      // instante (displayStates) para o rail não piscar no respiro do stream.
      act(() => {
        useSessionStateStore.getState().setPaneState('rev', 'busy');
        useSessionStateStore.getState().setPaneState('fe', 'idle');
      });
      expect(card.querySelector('.workspace-rail__agents-toggle')!.textContent).toContain(
        '3 trabalhando agora',
      );
      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(card.querySelector('.workspace-rail__agents-toggle')!.textContent).toContain(
        '2 trabalhando agora',
      );
      expect(card.querySelector<HTMLElement>('[data-pane-id="fe"]')!.dataset.agentState).toBe(
        'waiting',
      );
      expect(card.querySelector<HTMLElement>('[data-pane-id="rev"]')!.dataset.agentState).toBe(
        'working',
      );
      expect(order()).toEqual(['orq', 'fe', 'rev']);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });
});
