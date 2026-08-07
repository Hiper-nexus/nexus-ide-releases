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
    path: '/projetos/atlas',
    missions: [
      { id: 'mission-running', title: 'Corrigir o login', status: 'running' },
      { id: 'mission-blocked', title: 'Publicar a versão', status: 'blocked' },
    ],
  },
];

const recentWorkspaces: WorkspaceRailWorkspace[] = [
  {
    id: 'cometa',
    name: 'Cometa',
    path: '/projetos/cometa',
    missions: [
      { id: 'mission-done', title: 'Revisar a página inicial', status: 'done' },
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
  it('groups active and recent missions by workspace without empty counters', () => {
    const { host } = renderRail();
    const active = host.querySelector('[data-rail-group="active"]');
    const recent = host.querySelector('[data-rail-group="recent"]');

    expect(active?.textContent).toContain('Atlas local');
    expect(active?.textContent).toContain('Corrigir o login');
    expect(active?.textContent).toContain('Publicar a versão');
    expect(recent?.textContent).toContain('Cometa');
    expect(recent?.textContent).toContain('Revisar a página inicial');

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

  it('pairs every mission status with a word and semantic indicator', () => {
    const { host } = renderRail();

    for (const [missionId, label] of [
      ['mission-running', 'Em andamento'],
      ['mission-blocked', 'Precisa de você'],
      ['mission-done', 'Concluída'],
    ] as const) {
      const row = host.querySelector(`[data-mission-id="${missionId}"]`);
      expect(row?.textContent).toContain(label);
      expect(row?.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(row?.className).toContain('workspace-rail__mission--');
    }
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
    expect(handlers.onSelectMission).toHaveBeenCalledWith('mission-running');
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
              status: 'pending',
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
