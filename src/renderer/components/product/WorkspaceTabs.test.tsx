/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneScopeEntry } from '../../lib/pane-spaces';
import {
  WorkspaceTabs,
  workspaceTabIsClosable,
  workspaceTabTone,
  type WorkspaceTabsProps,
} from './WorkspaceTabs';

vi.mock('../PanePicker', () => ({
  PanePicker: ({ onPaneCreated }: { onPaneCreated?: (paneId: string) => void }) => (
    <button type="button" data-testid="tab-picker-trigger" onClick={() => onPaneCreated?.('pane-novo')}>
      +
    </button>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const space = (patch: Partial<PaneScopeEntry> & { key: string; title: string }): PaneScopeEntry => ({
  kind: 'space',
  paneCount: 1,
  missions: [],
  orchestrator: null,
  ...patch,
});

const SCOPES: PaneScopeEntry[] = [
  space({ key: 'space:a', id: 'a', title: 'Checkout', paneCount: 2 }),
  space({
    key: 'mission:m',
    kind: 'mission',
    id: 'm',
    title: 'Fechar o Epic 22',
    state: 'running',
    missions: [{ id: 'm', title: 'Fechar o Epic 22', state: 'running' }],
    orchestrator: { paneId: 'orq', title: 'Claude' },
  }),
  space({ key: '__loose__', kind: 'loose', title: 'Terminais' }),
];

let mounted: { root: Root; host: HTMLElement } | null = null;

function render(patch: Partial<WorkspaceTabsProps> = {}) {
  const props: WorkspaceTabsProps = {
    scopes: SCOPES,
    activeScopeKey: 'space:a',
    sideScopeKey: null,
    overview: false,
    editing: null,
    onFocusScope: vi.fn(),
    onToggleOverview: vi.fn(),
    onToggleBeside: vi.fn(),
    onCloseBeside: vi.fn(),
    onStartRename: vi.fn(),
    onRenameDraft: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onCloseTab: vi.fn(),
    onTabPaneCreated: vi.fn(),
    onNewMission: vi.fn(),
    ...patch,
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<WorkspaceTabs {...props} />));
  mounted = { root, host };
  return { host, props };
}

afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  mounted = null;
  document.body.innerHTML = '';
});

describe('WorkspaceTabs', () => {
  it('uma aba por escopo, com a ativa marcada e a contagem visível', () => {
    const { host } = render();
    const tabs = [...host.querySelectorAll('[role="tab"]')];

    expect(tabs.map((tab) => tab.querySelector('.workspace-tab__title')?.textContent)).toEqual([
      'Checkout',
      'Fechar o Epic 22',
      'Terminais',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    // Roving tabindex: só a ativa entra no Tab do teclado.
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(tabs[0]?.getAttribute('aria-label')).toBe('Checkout, 2 painéis');
  });

  it('←/→ na barra ativa a aba vizinha', () => {
    const { host, props } = render();
    const first = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
    first.focus();

    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    expect(props.onFocusScope).toHaveBeenCalledWith('mission:m');
  });

  it('F2 renomeia a aba de espaço; aba de missão não tem nome editável', () => {
    const { host, props } = render({ activeScopeKey: 'mission:m' });
    const [spaceTab, missionTab] = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    missionTab!.focus();
    act(() => {
      missionTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    });
    expect(props.onStartRename).not.toHaveBeenCalled();

    spaceTab!.focus();
    act(() => {
      spaceTab!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    });
    expect(props.onStartRename).toHaveBeenCalledWith(SCOPES[0]);
  });

  it('clique direito oferece ver ao lado, renomear e fechar', () => {
    const { host, props } = render();
    const loose = host.querySelector('.workspace-tab[data-scope-kind="loose"]')!;

    act(() => {
      loose.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    });
    const items = [...document.querySelectorAll('[role="menuitem"] strong')].map(
      (item) => item.textContent,
    );
    expect(items).toEqual(['Ver ao lado', 'Renomear', 'Fechar a aba']);

    act(() => {
      (document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0])!.click();
    });
    expect(props.onToggleBeside).toHaveBeenCalledWith('__loose__');
  });

  it('aba sem missão oferece "Criar missão desta aba"; aba com missão não', () => {
    const onStartTabMission = vi.fn();
    const { host } = render({ onStartTabMission });
    const spaceTab = host.querySelector('.workspace-tab[data-scope-kind="space"]')!;

    act(() => {
      spaceTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const labels = () =>
      [...document.querySelectorAll('[role="menuitem"] strong')].map((item) => item.textContent);
    expect(labels()).toContain('Criar missão desta aba');
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('Criar missão desta aba'))!
        .click();
    });
    expect(onStartTabMission).toHaveBeenCalledWith(SCOPES[0]);

    const missionTab = host.querySelector('.workspace-tab[data-scope-kind="mission"]')!;
    act(() => {
      missionTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(labels()).not.toContain('Criar missão desta aba');
  });

  it('aba cuja missão encerrou volta a oferecer "Criar missão desta aba"', () => {
    const scopes = [
      space({
        key: 'space:a',
        id: 'a',
        title: 'Checkout',
        missions: [{ id: 'm-old', title: 'Missão · Checkout', state: 'completed' }],
      }),
    ];
    const { host } = render({ scopes, onStartTabMission: vi.fn() });
    act(() => {
      host.querySelector('.workspace-tab[data-scope-kind="space"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(
      [...document.querySelectorAll('[role="menuitem"] strong')].map((item) => item.textContent),
    ).toContain('Criar missão desta aba');
  });

  it.each(['blocked_user', 'blocked_technical', 'recovering', 'starting'])(
    'missão da aba em %s ainda é a viva: não oferece criar outra',
    (state) => {
      const scopes = [
        space({
          key: 'space:a',
          id: 'a',
          title: 'Checkout',
          missions: [{ id: 'm-viva', title: 'Missão · Checkout', state }],
        }),
      ];
      const { host } = render({ scopes, onStartTabMission: vi.fn() });
      act(() => {
        host.querySelector('.workspace-tab[data-scope-kind="space"]')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      expect(
        [...document.querySelectorAll('[role="menuitem"] strong')].map((item) => item.textContent),
      ).not.toContain('Criar missão desta aba');
    },
  );

  it('Shift+F10 abre as ações da aba e Escape devolve o foco', () => {
    const { host } = render();
    const tab = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
    tab.focus();

    act(() => {
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(tab);
  });

  it('a aba da missão viva não oferece fechar — o menu aponta o Quadro', () => {
    const { host } = render();
    const missionTab = host.querySelector('.workspace-tab[data-scope-kind="mission"]')!;

    expect(missionTab.querySelector('.workspace-tab__close')).toBeNull();
    act(() => {
      missionTab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(
      [...document.querySelectorAll('[role="menuitem"] strong')].map((item) => item.textContent),
    ).toEqual(['Ver ao lado', 'Missão em andamento']);
  });

  it('o "+" cria o pane da aba nova e "Nova missão" abre o assistente', () => {
    const { host, props } = render();

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="tab-picker-trigger"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('.workspace-tabs__mission')!.click());

    expect(props.onTabPaneCreated).toHaveBeenCalledWith('pane-novo');
    expect(props.onNewMission).toHaveBeenCalledOnce();
  });

  it('visão geral: nenhuma aba selecionada e o botão pressionado', () => {
    const { host } = render({ overview: true, activeScopeKey: null });

    expect(host.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
    expect(host.querySelector('.workspace-tabs__overview')?.getAttribute('aria-pressed')).toBe('true');
    // Sem aba ativa não há o que dividir.
    expect(host.querySelector('[aria-label="Ver outra aba ao lado"]')).toBeNull();
  });
});

describe('workspaceTabIsClosable / workspaceTabTone', () => {
  it('aba só de terminais fecha; com missão viva ou desconhecida, não', () => {
    expect(workspaceTabIsClosable(SCOPES[0]!)).toBe(true);
    expect(workspaceTabIsClosable(SCOPES[1]!)).toBe(false);
    expect(
      workspaceTabIsClosable(
        space({ key: '__loose__', kind: 'loose', title: 'Terminais', missions: [{ id: 'x', title: 'X' }] }),
      ),
    ).toBe(false);
    expect(
      workspaceTabIsClosable(
        space({ key: 'mission:d', kind: 'mission', title: 'Feita', state: 'completed' }),
      ),
    ).toBe(true);
  });

  it('um estado, um tom — o mesmo mapa das superfícies de missão', () => {
    expect(workspaceTabTone('running')).toBe('live');
    expect(workspaceTabTone('blocked_user')).toBe('attention');
    expect(workspaceTabTone('blocked_technical')).toBe('repair');
    expect(workspaceTabTone('completed')).toBe('done');
    expect(workspaceTabTone(undefined)).toBeNull();
  });
});
