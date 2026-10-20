/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDeadPaneState,
  retiredScopeKeys,
  type PaneScopeEntry,
} from '../../lib/pane-spaces';
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

  it('aba com equipe mostra "Mapa da equipe" na barra e abre o mapa da missão', () => {
    const onOpenTeamMap = vi.fn();
    const { host } = render({
      activeScopeKey: 'mission:m',
      teamMap: {
        missionId: 'm',
        title: 'Fechar o Epic 22',
        members: [{ paneId: 'orq', coordinator: true }],
      },
      onOpenTeamMap,
    });

    const button = host.querySelector<HTMLButtonElement>('.workspace-tabs__actions .workspace-tabs__team');
    expect(button?.textContent).toContain('Mapa da equipe');
    act(() => button!.click());

    expect(onOpenTeamMap).toHaveBeenCalledWith('m');
  });

  it('sem equipe na aba, ou na visão geral, a barra não oferece o mapa', () => {
    const teamMap = {
      missionId: 'm',
      title: 'Fechar o Epic 22',
      members: [{ paneId: 'orq', coordinator: true }],
    };

    expect(render().host.querySelector('.workspace-tabs__team')).toBeNull();
    act(() => mounted!.root.unmount());
    expect(
      render({ overview: true, activeScopeKey: null, teamMap, onOpenTeamMap: vi.fn() })
        .host.querySelector('.workspace-tabs__team'),
    ).toBeNull();
  });
});

describe('WorkspaceTabs — estado com motivo (F-198/F-373)', () => {
  it('aba com Maestro ocioso: tom idle e a palavra Aguardando (F-198)', () => {
    const scopes = [
      space({
        key: 'mission:m',
        kind: 'mission',
        id: 'm',
        title: 'Fechar o Epic 22',
        state: 'running',
        stateReasonCode: 'awaiting-instruction',
        missions: [
          {
            id: 'm',
            title: 'Fechar o Epic 22',
            state: 'running',
            stateReasonCode: 'awaiting-instruction',
          },
        ],
        orchestrator: { paneId: 'orq', title: 'Claude' },
      }),
    ];
    const { host } = render({ scopes });
    const tab = host.querySelector<HTMLButtonElement>('[role="tab"]')!;

    expect(
      tab.closest('.workspace-tab')?.getAttribute('data-tone'),
    ).toBe('idle');
    expect(tab.getAttribute('aria-label')).toContain('Aguardando');
    expect(tab.getAttribute('aria-label')).not.toContain('Trabalhando');
    expect(tab.getAttribute('title')).toContain('Missão · Aguardando');
  });

  it('aba hospedeira mostra o motivo da missão hospedada, não o rótulo cru', () => {
    const scopes = [
      space({
        key: 'space:a',
        id: 'a',
        title: 'Checkout',
        missions: [
          {
            id: 'm-viva',
            title: 'Missão · Checkout',
            state: 'running',
            stateReasonCode: 'awaiting-instruction',
          },
        ],
      }),
    ];
    const { host } = render({ scopes });
    const tab = host.querySelector<HTMLButtonElement>('[role="tab"]')!;

    expect(tab.getAttribute('title')).toContain(
      'Missão: Missão · Checkout · Aguardando',
    );
  });

  it.each(['session-sleeping', 'runtime-closed'])(
    'missão da aba %s não segura a aba: oferece criar outra e permite fechar (F-373)',
    (stateReasonCode) => {
      const scopes = [
        space({
          key: 'space:a',
          id: 'a',
          title: 'Checkout',
          missions: [
            {
              id: 'm-morta',
              title: 'Missão · Checkout',
              state: 'blocked_user',
              stateReasonCode,
            },
          ],
        }),
      ];
      const { host } = render({ scopes, onStartTabMission: vi.fn() });
      const tab = host.querySelector('.workspace-tab[data-scope-kind="space"]')!;

      expect(tab.querySelector('.workspace-tab__close')).not.toBeNull();
      act(() => {
        tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      const labels = [...document.querySelectorAll('[role="menuitem"] strong')].map(
        (item) => item.textContent,
      );
      expect(labels).toContain('Criar missão desta aba');
      expect(labels).toContain('Fechar a aba');
      expect(labels).not.toContain('Missão em andamento');
    },
  );

  it('aba de missão dormindo (a própria) também fecha pelo ×', () => {
    const scope = space({
      key: 'mission:m',
      kind: 'mission',
      id: 'm',
      title: 'Missão parada',
      state: 'blocked_user',
      stateReasonCode: 'session-sleeping',
    });
    expect(workspaceTabIsClosable(scope)).toBe(true);
    const alive = space({
      key: 'mission:m2',
      kind: 'mission',
      id: 'm2',
      title: 'Missão viva',
      state: 'blocked_user',
      stateReasonCode: 'open-question',
    });
    expect(workspaceTabIsClosable(alive)).toBe(false);
  });

  it('session-dead ainda segura a aba — o runtime pode voltar', () => {
    const scopes = [
      space({
        key: 'space:a',
        id: 'a',
        title: 'Checkout',
        missions: [
          {
            id: 'm-morta',
            title: 'Missão · Checkout',
            state: 'blocked_technical',
            stateReasonCode: 'session-dead',
          },
        ],
      }),
    ];
    const { host } = render({ scopes, onStartTabMission: vi.fn() });
    const tab = host.querySelector('.workspace-tab[data-scope-kind="space"]')!;

    expect(tab.querySelector('.workspace-tab__close')).toBeNull();
    act(() => {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const labels = [...document.querySelectorAll('[role="menuitem"] strong')].map(
      (item) => item.textContent,
    );
    expect(labels).not.toContain('Criar missão desta aba');
    expect(labels).toContain('Missão em andamento');
  });
});

describe('WorkspaceTabs — reordenar (WEB-13)', () => {
  function fakeDataTransfer() {
    const data = new Map<string, string>();
    return {
      data,
      dropEffect: 'none',
      effectAllowed: 'all',
      get types() {
        return [...data.keys()];
      },
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
    };
  }

  function drag(target: Element, type: string, transfer: ReturnType<typeof fakeDataTransfer>, clientX = 0) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it('sem onMoveTab a barra não arrasta nem oferece mover', () => {
    const { host } = render();
    const tab = host.querySelector('.workspace-tab')!;
    expect(tab.getAttribute('draggable')).toBe('false');
    act(() => {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const labels = [...document.querySelectorAll('[role="menuitem"] strong')].map((item) => item.textContent);
    expect(labels).not.toContain('Mover para a direita');
  });

  it('Alt+Shift+→ move a aba focada e anuncia a nova posição', () => {
    const onMoveTab = vi.fn();
    const { host } = render({ onMoveTab });
    const first = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
    expect(first.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+ArrowLeft Alt+Shift+ArrowRight');
    expect(first.getAttribute('title')).toContain('Arraste para mudar a ordem');
    first.focus();

    act(() => {
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(onMoveTab).toHaveBeenCalledWith('space:a', 1);
    expect(host.querySelector('.workspace-tabs__live')?.textContent).toBe(
      'Aba Checkout movida para a posição 2 de 3.',
    );

    // Na ponta esquerda, ← não faz nada.
    act(() => {
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(onMoveTab).toHaveBeenCalledTimes(1);
  });

  it('o menu da aba oferece mover só para os lados que existem', () => {
    const onMoveTab = vi.fn();
    const { host } = render({ onMoveTab });
    const labelsFor = (kind: string) => {
      act(() => {
        host
          .querySelector(`.workspace-tab[data-scope-kind="${kind}"]`)!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      return [...document.querySelectorAll('[role="menuitem"] strong')].map((item) => item.textContent);
    };

    expect(labelsFor('space')).toEqual(['Mover para a direita', 'Renomear', 'Fechar a aba']);
    expect(labelsFor('loose')).toEqual(['Ver ao lado', 'Mover para a esquerda', 'Renomear', 'Fechar a aba']);
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('Mover para a esquerda'))!
        .click();
    });
    expect(onMoveTab).toHaveBeenCalledWith('__loose__', 1);
  });

  it('arrastar e soltar depois de outra aba move para a posição dela', () => {
    const onMoveTab = vi.fn();
    const { host } = render({ onMoveTab });
    const [first, , last] = [...host.querySelectorAll('.workspace-tab')];
    const transfer = fakeDataTransfer();

    drag(first!, 'dragstart', transfer);
    expect(transfer.getData('application/x-nexus-workspace-tab')).toBe('space:a');
    expect(first!.hasAttribute('data-dragging')).toBe(true);

    const over = drag(last!, 'dragover', transfer, 10);
    expect(over.defaultPrevented).toBe(true);
    expect(last!.getAttribute('data-drop')).toBe('after');

    drag(last!, 'drop', transfer, 10);
    expect(onMoveTab).toHaveBeenCalledWith('space:a', 2);
    expect(first!.hasAttribute('data-dragging')).toBe(false);
    expect(last!.hasAttribute('data-drop')).toBe(false);
  });

  it('arraste que não é de aba (arquivo) passa direto pela barra', () => {
    const onMoveTab = vi.fn();
    const { host } = render({ onMoveTab });
    const transfer = fakeDataTransfer();
    transfer.setData('Files', '');
    const over = drag(host.querySelector('.workspace-tab')!, 'dragover', transfer, 10);
    expect(over.defaultPrevented).toBe(false);
    drag(host.querySelector('.workspace-tab')!, 'drop', transfer, 10);
    expect(onMoveTab).not.toHaveBeenCalled();
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

  it('aba aposentada (sem sessão viva) fecha mesmo com missão em estado não terminal', () => {
    const alive = space({ key: 'mission:r', kind: 'mission', title: 'R', state: 'blocked_user' });
    expect(workspaceTabIsClosable(alive)).toBe(false);
    expect(workspaceTabIsClosable({ ...alive, retired: true })).toBe(true);
    expect(
      workspaceTabIsClosable(
        space({ key: '__loose__', kind: 'loose', title: 'T', retired: true, missions: [{ id: 'x', title: 'X' }] }),
      ),
    ).toBe(true);
  });

  it('retiredScopeKeys: só abas com todos os panes mortos', () => {
    const mk = (id: string) => ({ id }) as never;
    const scopeOf = (p: { id: string }) => (p.id.startsWith('a') ? 'A' : 'B');
    const keys = retiredScopeKeys([mk('a1'), mk('a2'), mk('b1')], scopeOf as never, new Set(['a1', 'b1']));
    expect([...keys]).toEqual(['B']);
    expect(isDeadPaneState('exited')).toBe(true);
    expect(isDeadPaneState('hibernated')).toBe(true);
    expect(isDeadPaneState(undefined)).toBe(false);
    expect(isDeadPaneState('busy')).toBe(false);
  });

  it('um estado, um tom — o mesmo mapa das superfícies de missão', () => {
    expect(workspaceTabTone('running')).toBe('live');
    expect(workspaceTabTone('blocked_user')).toBe('attention');
    expect(workspaceTabTone('blocked_technical')).toBe('repair');
    expect(workspaceTabTone('completed')).toBe('done');
    expect(workspaceTabTone(undefined)).toBeNull();
  });

  it('o código do motivo vence o estado: espera é idle, interrompida tem tom próprio', () => {
    expect(workspaceTabTone('running', 'awaiting-instruction')).toBe('idle');
    expect(workspaceTabTone('blocked_user', 'session-sleeping')).toBe(
      'interrupted',
    );
    expect(workspaceTabTone('blocked_user', 'runtime-closed')).toBe('idle');
    expect(workspaceTabTone('blocked_technical', 'session-dead')).toBe(
      'interrupted',
    );
    // Motivo que não é parada não muda o tom.
    expect(workspaceTabTone('blocked_user', 'open-question')).toBe('attention');
  });
});

describe('WorkspaceTabs — agentes trabalhando agora', () => {
  const scopes = [
    space({ key: 'space:a', id: 'a', title: 'Checkout', paneCount: 5, workingCount: 2 }),
    space({ key: 'space:b', id: 'b', title: 'Blog', paneCount: 3 }),
  ];

  it('a aba com agentes trabalhando mostra ponto vivo e número sem precisar abri-la', () => {
    const { host } = render({ scopes, activeScopeKey: 'space:b' });
    const [checkout, blog] = [...host.querySelectorAll<HTMLElement>('.workspace-tab')];

    const badge = checkout!.querySelector('.workspace-tab__working')!;
    expect(badge.textContent).toBe('2');
    expect(badge.querySelector('.workspace-tab__working-dot')).not.toBeNull();
    expect(checkout!.getAttribute('data-working')).toBe('2');
    // A contagem de painéis segue ao lado; a aba quieta não ganha selo.
    expect(checkout!.querySelector('.workspace-tab__count')!.textContent).toBe('5');
    expect(blog!.querySelector('.workspace-tab__working')).toBeNull();
    expect(blog!.hasAttribute('data-working')).toBe(false);
  });

  it('a palavra vai no nome acessível e no tooltip — o selo é só ponto e número', () => {
    const { host } = render({ scopes });
    const [checkout, blog] = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    expect(checkout!.getAttribute('aria-label')).toBe('Checkout, 5 painéis, 2 trabalhando agora');
    expect(checkout!.getAttribute('title')).toContain('2 trabalhando agora');
    expect(checkout!.querySelector('.workspace-tab__working')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
    // Sem ninguém trabalhando o nome acessível é o de sempre.
    expect(blog!.getAttribute('aria-label')).toBe('Blog, 3 painéis');
    expect(blog!.getAttribute('title')).not.toContain('trabalhando');
  });

  it('pressionar o × desativa o arraste da aba no macOS para não engolir o clique de fechar', () => {
    const onMoveTab = vi.fn();
    const onCloseTab = vi.fn();
    const { host } = render({ scopes, onMoveTab, onCloseTab });
    const tab = host.querySelector<HTMLElement>('.workspace-tab')!;
    const closeBtn = tab.querySelector<HTMLButtonElement>('.workspace-tab__close')!;

    expect(tab.getAttribute('draggable')).toBe('true');
    expect(closeBtn.getAttribute('draggable')).toBe('false');

    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(tab.getAttribute('draggable')).toBe('false');

    const dragStart = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
    act(() => {
      closeBtn.dispatchEvent(dragStart);
    });
    expect(dragStart.defaultPrevented).toBe(true);
    expect(tab.hasAttribute('data-dragging')).toBe(false);

    act(() => {
      closeBtn.click();
    });
    expect(onCloseTab).toHaveBeenCalledWith(scopes[0]);
  });
});
