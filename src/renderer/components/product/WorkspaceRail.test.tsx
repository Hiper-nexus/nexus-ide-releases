/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceRail,
  type WorkspaceRailProps,
  type WorkspaceRailWorkspace,
} from './WorkspaceRail';

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

  it('routes Novo, workspaces, missions, fixed destinations and settings', () => {
    const { host, handlers } = renderRail();

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="Criar nova missão"]')?.click();
      host.querySelector<HTMLButtonElement>('[data-workspace-id="atlas"]')?.click();
      host.querySelector<HTMLButtonElement>('[data-mission-id="mission-running"]')?.click();
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
    expect(handlers.onOpenTaskBoard).toHaveBeenCalledOnce();
    expect(handlers.onOpenMemory).toHaveBeenCalledOnce();
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce();
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
    expect(mission?.getAttribute('aria-label')).toContain(longTitle);
    expect(mission?.title).toContain(longTitle);
    expect(controls.every((control) => control.tabIndex === 0)).toBe(true);

    mission?.focus();
    expect(document.activeElement).toBe(mission);
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
});
