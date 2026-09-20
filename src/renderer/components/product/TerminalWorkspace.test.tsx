/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../../shared/types';
import { buildGridTree, listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { usePaneScopeStore } from '../../state/pane-scope-store';
import {
  ALL_SCOPES_KEY,
  LOOSE_SCOPE_KEY,
  spaceScopeKey,
} from '../../lib/pane-spaces';
import { TerminalWorkspace } from './TerminalWorkspace';
import { useProductNavigationStore } from '../../state/product-navigation-store';

const terminalRuntime = vi.hoisted(() => ({
  attachHost: vi.fn(),
  blurHost: vi.fn(),
  focusHost: vi.fn(),
  setHostVisibility: vi.fn(),
  reconcileHosts: vi.fn(),
  getPaneSessionId: vi.fn(() => null as string | null),
  getScrollbackExcerpt: vi.fn(() => ''),
  hibernateHost: vi.fn(),
  onPaneSessionChange: vi.fn(() => vi.fn()),
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  submitPromptToPane: vi.fn(() => true),
  wakeHost: vi.fn(),
  waitForSession: vi.fn(async () => null as string | null),
  writeToPane: vi.fn(),
  applyTerminalSettings: vi.fn(),
  revealTerminalHostsAfterWorkspaceShow: vi.fn(),
  terminalRendererPerformanceSnapshot: vi.fn(() => ({
    performanceMode: 'adaptive' as const,
    hosts: 0,
    visibleHosts: 0,
    activeWebglLeases: 0,
    queuedTerminals: 0,
    queuedChars: 0,
    pendingParseChars: 0,
    droppedBacklogs: 0,
  })),
}));

const browserRuntime = vi.hoisted(() => ({
  attachBrowserPane: vi.fn(),
  reconcileBrowserPanes: vi.fn(),
  scheduleBrowserPaneBoundsSync: vi.fn(),
  setBrowserViewportOverride: vi.fn(),
  waitForBrowserPaneCreated: vi.fn(async () => undefined),
}));

vi.mock('../../terminal/terminal-host', () => terminalRuntime);
vi.mock('../../browser/browser-host', () => browserRuntime);
vi.mock('../CanvasView', () => ({
  CanvasView: (props: {
    visiblePaneIds?: ReadonlySet<string>;
    onPaneCreated?: (paneId: string) => void;
  }) => {
    (globalThis as Record<string, unknown>).__nexusCanvasViewProps = props;
    return <div className="canvas-container" />;
  },
}));

function canvasViewProps(): {
  visiblePaneIds?: ReadonlySet<string>;
  onPaneCreated?: (paneId: string) => void;
} {
  return (
    ((globalThis as Record<string, unknown>).__nexusCanvasViewProps as {
      visiblePaneIds?: ReadonlySet<string>;
      onPaneCreated?: (paneId: string) => void;
    }) ?? {}
  );
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

const PANES: PaneModel[] = [
  { id: 'pane-canonical-a', kind: 'shell', title: 'Terminal A' },
  { id: 'pane-canonical-b', kind: 'shell', title: 'Terminal B' },
];
const CANONICAL_IDS = PANES.map((pane) => pane.id).sort();

type MountedRoot = {
  host: HTMLDivElement;
  root: Root;
  mounted: boolean;
};

const mountedRoots: MountedRoot[] = [];
let ptySpawn = vi.fn();

function mount(node: ReactNode): MountedRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const mounted = { host, root, mounted: true };
  mountedRoots.push(mounted);
  act(() => root.render(node));
  return mounted;
}

function unmount(mounted: MountedRoot): void {
  if (!mounted.mounted) return;
  act(() => mounted.root.unmount());
  mounted.mounted = false;
  mounted.host.remove();
}

function installNexusBoundary(): void {
  ptySpawn = vi.fn();
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      pty: { spawn: ptySpawn, write: vi.fn() },
      notes: {
        list: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        onChanged: vi.fn(() => vi.fn()),
      },
      pipes: {
        list: vi.fn(async () => []),
        add: vi.fn(async () => ({ ok: true, id: 'pipe-test' })),
        remove: vi.fn(async () => undefined),
        onChanged: vi.fn(() => vi.fn()),
      },
    },
  });
}

function seedLayout(viewKind: 'grid' | 'canvas' = 'grid'): void {
  useLayoutStore.setState({
    root: buildGridTree(PANES),
    focusedPaneId: PANES[0]!.id,
    maximizedPaneId: null,
    hydrated: true,
    viewKind,
    canvasNodeLayouts: {},
    canvasViewport: { x: 0, y: 0, zoom: 1 },
  });
}


function attachedPaneIds(): string[] {
  return [
    ...new Set(
      terminalRuntime.attachHost.mock.calls.map(
        ([pane]) => (pane as PaneModel).id,
      ),
    ),
  ].sort();
}

function chipLabels(host: HTMLElement): string[] {
  return [
    ...host.querySelectorAll('.terminal-workspace__filter-label'),
  ].map((label) => label.textContent ?? '');
}

function activeChipLabel(host: HTMLElement): string | undefined {
  return (
    host
      .querySelector('.terminal-workspace__filter-chip--active')
      ?.querySelector('.terminal-workspace__filter-label')?.textContent ??
    undefined
  );
}

function boardReturnButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
    /voltar.*quadro/i.test(
      button.getAttribute('aria-label') ?? button.textContent ?? '',
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installNexusBoundary();
  usePaneScopeStore.getState().clearScopeFocus();
  seedLayout();
});

afterEach(() => {
  for (const mounted of mountedRoots.splice(0).reverse()) unmount(mounted);
  document.body.replaceChildren();
  useOrchStore.setState({
    missions: [],
    missionSummaries: [],
    paneMissions: {},
  });
  Reflect.deleteProperty(window, 'nexus');
  vi.clearAllMocks();
});

describe('TerminalWorkspace contracts', () => {
  it('selects the canonical grid or canvas surface from layout state', () => {
    const { host } = mount(<TerminalWorkspace />);

    expect(host.querySelector('.grid')).not.toBeNull();
    expect(host.querySelector('.canvas-container')).toBeNull();

    act(() => useLayoutStore.setState({ viewKind: 'canvas' }));

    expect(host.querySelector('.canvas-container')).not.toBeNull();
    expect(host.querySelector('.grid')).toBeNull();
  });

  it('mounts every pane host while hidden and does not dispose them when the mission view filters the mosaic', () => {
    const mounted = mount(<TerminalWorkspace hidden />);
    const workspace = mounted.host.querySelector<HTMLElement>(
      '.terminal-workspace',
    );

    expect(workspace?.hidden).toBe(true);
    expect(workspace?.getAttribute('aria-hidden')).toBe('true');
    expect(mounted.host.querySelector('.grid')).not.toBeNull();
    expect(mounted.host.querySelector('.grid--mission-empty')).toBeNull();

    const attachedWhileHidden = terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
    for (const paneId of CANONICAL_IDS) {
      expect(
        attachedWhileHidden.filter((id) => id === paneId),
      ).toHaveLength(1);
    }
    expect(terminalRuntime.reconcileHosts).toHaveBeenCalledTimes(1);
    expect([...terminalRuntime.reconcileHosts.mock.calls[0]![0]].sort()).toEqual(
      CANONICAL_IDS,
    );

    act(() =>
      mounted.root.render(
        <TerminalWorkspace
          missionId="mission-release"
          onBackToBoard={vi.fn()}
        />,
      ),
    );

    expect(
      mounted.host.querySelector<HTMLElement>('.terminal-workspace'),
    ).toBe(workspace);
    expect(mounted.host.querySelector('.grid--mission-empty')).not.toBeNull();
    expect(workspace?.hidden).toBe(false);
    expect(workspace?.hasAttribute('aria-hidden')).toBe(false);

    expect(terminalRuntime.reconcileHosts).toHaveBeenCalledTimes(1);
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  it('F-603: voltar dos Ajustes revela os hosts — não espera um pane novo', () => {
    const mounted = mount(<TerminalWorkspace hidden />);
    expect(
      terminalRuntime.revealTerminalHostsAfterWorkspaceShow,
    ).not.toHaveBeenCalled();

    act(() => mounted.root.render(<TerminalWorkspace />));
    expect(
      terminalRuntime.revealTerminalHostsAfterWorkspaceShow,
    ).toHaveBeenCalledTimes(1);

    act(() => mounted.root.render(<TerminalWorkspace hidden />));
    expect(
      terminalRuntime.revealTerminalHostsAfterWorkspaceShow,
    ).toHaveBeenCalledTimes(1);
  });

  it('explica quando o filtro não tem panes em vez de entregar uma tela preta', () => {
    const { host } = mount(
      <TerminalWorkspace missionId="mission-without-panes" />,
    );

    expect(host.querySelector('.grid--mission-empty')).not.toBeNull();
    expect(host.textContent).toContain('Nenhum terminal visível');
  });

  it('Terminais da missão mostra só os panes dela, não o mosaico das 15', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-maestro',
          kind: 'cli-agent',
          title: 'Maestro',
          adapterId: 'codex',
          missionId: 'mission-release',
        },
        {
          id: 'pane-other',
          kind: 'cli-agent',
          title: 'Outra',
          adapterId: 'codex',
          missionId: 'mission-other',
        },
      ]),
      focusedPaneId: 'pane-maestro',
    });
    useOrchStore.setState({
      paneMissions: {
        'pane-maestro': 'mission-release',
        'pane-other': 'mission-other',
      },
    });

    const { host } = mount(
      <TerminalWorkspace
        missionId="mission-release"
        onBackToBoard={vi.fn()}
      />,
    );

    expect(host.querySelector('.grid--mission-empty')).toBeNull();
    const attached = terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
    expect(attached).toEqual(['pane-maestro']);
    expect(terminalRuntime.reconcileHosts).toHaveBeenCalledTimes(1);
    expect(
      [...terminalRuntime.reconcileHosts.mock.calls[0]![0]].sort(),
    ).toEqual(['pane-maestro', 'pane-other'].sort());
  });

  it('missão done sem aprovação humana mostra Pronto para revisar', () => {
    useOrchStore.setState({
      missions: [
        {
          id: 'mission-release',
          title: 'Landing',
          description: '',
          status: 'done',
          milestones: [],
          learnings: '',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      missionSummaries: [
        {
          id: 'mission-release',
          title: 'Landing',
          state: 'completed',
          progress: { completed: 1, total: 1 },
          needsAttention: false,
          updatedAt: 2,
        },
      ],
    });
    const { host } = mount(
      <TerminalWorkspace
        missionId="mission-release"
        onBackToBoard={vi.fn()}
      />,
    );
    const context = host.querySelector(
      '.product-workspace__context',
    )?.textContent;
    expect(context).toBe('Missão · Pronto para revisar');
  });

  it('exposes exactly one return-to-board action only in mission context', () => {
    const onBackToBoard = vi.fn();
    const mission = mount(
      <TerminalWorkspace
        missionId="mission-release"
        onBackToBoard={onBackToBoard}
      />,
    );

    const actions = boardReturnButtons(mission.host);
    expect(actions).toHaveLength(1);
    act(() => actions[0]!.click());
    expect(onBackToBoard).toHaveBeenCalledOnce();

    unmount(mission);
    const standalone = mount(<TerminalWorkspace />);
    expect(boardReturnButtons(standalone.host)).toHaveLength(0);
  });
});

describe('TerminalWorkspace em missão — "+ Pane" do operador', () => {
  const worker: PaneModel = {
    id: 'pane-w1',
    kind: 'cli-agent',
    title: 'Worker',
    adapterId: 'grok',
    missionId: 'm-1',
  };

  beforeEach(() => {
    // O picker rola a opção ativa para a vista; jsdom não implementa.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    useLayoutStore.setState({
      root: buildGridTree([worker]),
      focusedPaneId: worker.id,
      maximizedPaneId: null,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  function attachedIds(): string[] {
    return terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
  }

  it('mostra só o pane da missão antes do operador criar algo', () => {
    mount(<TerminalWorkspace missionId="m-1" />);

    expect(attachedIds()).toEqual(['pane-w1']);
  });

  it('canvas: terminal criado na vista da missão é fixado no filtro', () => {
    useLayoutStore.setState({ viewKind: 'canvas' });
    mount(<TerminalWorkspace missionId="m-1" />);

    // Só o pane da missão na árvore: não há o que filtrar, então a vista usa a
    // árvore canônica (undefined) em vez de um Set redundante — ver o contrato
    // "filtro é no-op quando cobre tudo".
    expect(canvasViewProps().visiblePaneIds).toBeUndefined();
    expect(typeof canvasViewProps().onPaneCreated).toBe('function');

    // A barra do canvas cria o shell e avisa: o id entra no filtro da vista.
    act(() => canvasViewProps().onPaneCreated?.('pane-op'));
    expect([...(canvasViewProps().visiblePaneIds ?? [])]).toEqual(
      expect.arrayContaining(['pane-w1', 'pane-op']),
    );
  });

  it('o Terminal criado pelo picker monta na vista da missão (com PTY)', () => {
    const { host } = mount(<TerminalWorkspace missionId="m-1" />);
    expect(attachedIds()).toEqual(['pane-w1']);

    const trigger = host.querySelector<HTMLButtonElement>(
      '[data-testid="pane-picker-trigger"]',
    );
    if (!trigger) throw new Error('no "+ Pane" trigger rendered');
    act(() => trigger.click());
    const entry = host.querySelector<HTMLButtonElement>(
      '[data-testid="pane-picker-entry-type:terminal"]',
    );
    if (!entry) throw new Error('no Terminal entry rendered');
    act(() => entry.click());

    // Regressão: o filtro da missão escondia o shell criado (sem PaneLeaf,
    // sem PTY — "não abre, não faz nada"). Fixado, ele monta ao lado.
    // (attachHost pode refogar no remount do reshaping — a prova estável é
    // o slot montado no DOM, não a contagem de chamadas.)
    expect(host.querySelectorAll('.pane__terminal')).toHaveLength(2);
    expect(attachedIds()).toContain('pane-w1');
    const shellAttached = terminalRuntime.attachHost.mock.calls.some(
      ([pane]) => (pane as PaneModel).kind === 'shell',
    );
    expect(shellAttached).toBe(true);
  });
});

// ── F-527: vista global separa missões por chips de foco ─────────────────────

describe('TerminalWorkspace — filtro de missões na vista global (F-527)', () => {
  it('com 2+ missões vivas, abre focada na primeira e mostra chips', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-a1',
          kind: 'cli-agent',
          title: 'Worker A1',
          adapterId: 'codex',
          missionId: 'mission-a',
        },
        {
          id: 'pane-b1',
          kind: 'cli-agent',
          title: 'Worker B1',
          adapterId: 'agy',
          missionId: 'mission-b',
        },
      ]),
      focusedPaneId: 'pane-a1',
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [
        {
          id: 'mission-a',
          title: 'Checkout da loja',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 1,
        },
        {
          id: 'mission-b',
          title: 'Blog da release',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 2,
        },
      ],
    });

    const { host } = mount(<TerminalWorkspace />);

    expect(chipLabels(host)).toEqual([
      'Checkout da loja',
      'Blog da release',
      'Todos',
    ]);
    // Foco default: a primeira missão — só os panes dela montam.
    expect(activeChipLabel(host)).toBe('Checkout da loja');
    expect(attachedPaneIds()).toEqual(['pane-a1']);
  });
});

// ── F-546: panes soltos (sem missão) nunca somem da grade na vista global ────

describe('TerminalWorkspace — visibilidade de panes soltos (F-546)', () => {
  function seedMissionPlusLoose(): void {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-mission',
          kind: 'cli-agent',
          title: 'Worker da missão',
          adapterId: 'codex',
          missionId: 'mission-x',
        },
        { id: 'pane-loose', kind: 'shell', title: 'Shell avulso' },
      ]),
      focusedPaneId: 'pane-mission',
    });
    useOrchStore.setState({
      paneMissions: { 'pane-mission': 'mission-x' },
      missions: [],
      missionSummaries: [
        {
          id: 'mission-x',
          title: 'Missão X',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 1,
        },
      ],
    });
  }

  // F-560 mudou o contrato: o pane solto não é mais EMPILHADO no mosaico da
  // missão — ele ganha uma ABA própria. O que F-546 protege continua de pé (o
  // pane nunca some nem fica sem montar): a aba está na tela, com a contagem, e
  // clicar nela monta o pane.
  it('vista global: pane sem missionId ganha aba própria e monta ao ser escolhido', () => {
    seedMissionPlusLoose();

    const { host } = mount(<TerminalWorkspace />);

    expect(chipLabels(host)).toEqual(['Missão X', 'Painéis soltos', 'Todos']);
    expect(attachedPaneIds()).toEqual(['pane-mission']);

    act(() => {
      usePaneScopeStore.getState().focusScope(LOOSE_SCOPE_KEY);
    });

    expect(activeChipLabel(host)).toBe('Painéis soltos');
    expect(attachedPaneIds()).toEqual(['pane-loose', 'pane-mission']);
  });

  it('dentro de uma missão: o pane solto não é adicionado só por esta regra', () => {
    seedMissionPlusLoose();

    mount(
      <TerminalWorkspace missionId="mission-x" onBackToBoard={vi.fn()} />,
    );

    expect(attachedPaneIds()).toEqual(['pane-mission']);
  });
});

// ── F-560: "Novo pedido" não pode despejar painéis na missão já aberta ───────

describe('TerminalWorkspace — espaços separados da missão aberta (F-560)', () => {
  function seedMissionPlusSpace(): void {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-missao-a',
          kind: 'cli-agent',
          title: 'Worker da missão A',
          adapterId: 'codex',
          missionId: 'mission-a',
        },
        {
          id: 'pane-novo-1',
          kind: 'cli-agent',
          title: 'Codex',
          adapterId: 'codex',
          spaceId: 'space-novo',
          spaceTitle: 'Meus terminais 2',
        },
        {
          id: 'pane-novo-2',
          kind: 'cli-agent',
          title: 'DeepSeek',
          adapterId: 'deepseek',
          spaceId: 'space-novo',
          spaceTitle: 'Meus terminais 2',
        },
      ]),
      focusedPaneId: 'pane-novo-1',
    });
    useOrchStore.setState({
      paneMissions: { 'pane-missao-a': 'mission-a' },
      missions: [],
      missionSummaries: [
        {
          id: 'mission-a',
          title: 'Missão A',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 1,
        },
      ],
    });
  }

  it('o espaço aberto pelo "Novo pedido" monta SÓ os painéis dele', () => {
    seedMissionPlusSpace();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-novo'));

    mount(<TerminalWorkspace />);

    expect(attachedPaneIds()).toEqual(['pane-novo-1', 'pane-novo-2']);
  });

  it('cada escopo vira uma aba, com a contagem de painéis', () => {
    seedMissionPlusSpace();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-novo'));

    const { host } = mount(<TerminalWorkspace />);

    expect(chipLabels(host)).toEqual(['Missão A', 'Meus terminais 2', 'Todos']);
    expect(
      [...host.querySelectorAll('.terminal-workspace__filter-count')].map(
        (count) => count.textContent,
      ),
    ).toEqual(['1', '2']);
    expect(activeChipLabel(host)).toBe('Meus terminais 2');
  });

  it('exibe botão de + Nova missão no filterbar e aciona openNewMission', () => {
    seedMissionPlusSpace();
    const { host } = mount(<TerminalWorkspace />);

    const newMissionBtn = host.querySelector<HTMLButtonElement>(
      '.terminal-workspace__new-mission-btn',
    );
    expect(newMissionBtn).not.toBeNull();
    act(() => {
      newMissionBtn?.click();
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
  });

  it('exibe dot de status na aba de missão', () => {
    seedMissionPlusSpace();
    const { host } = mount(<TerminalWorkspace />);

    const chipDot = host.querySelector(
      '.terminal-workspace__chip-dot--running',
    );
    expect(chipDot).not.toBeNull();
  });

  it('sem nenhuma missão viva o filtro NÃO desliga — cada espaço segue no seu mosaico', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-espaco-1',
          kind: 'cli-agent',
          title: 'Codex',
          adapterId: 'codex',
          spaceId: 'space-um',
          spaceTitle: 'Meus terminais',
        },
        { id: 'pane-solto', kind: 'shell', title: 'Shell avulso' },
      ]),
      focusedPaneId: 'pane-espaco-1',
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [],
    });
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-um'));

    mount(<TerminalWorkspace />);

    expect(attachedPaneIds()).toEqual(['pane-espaco-1']);
  });

  it('"Todos" continua existindo para quem quer o mosaico inteiro', () => {
    seedMissionPlusSpace();
    usePaneScopeStore.getState().focusScope(ALL_SCOPES_KEY);

    mount(<TerminalWorkspace />);

    expect(attachedPaneIds()).toEqual([
      'pane-missao-a',
      'pane-novo-1',
      'pane-novo-2',
    ]);
  });

  it('escopo que evaporou cai num escopo REAL, nunca no mosaico inteiro', () => {
    seedMissionPlusSpace();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-que-sumiu'));

    mount(<TerminalWorkspace />);

    // O foco do layout está no espaço novo, então a aba acompanha ele (a
    // invariante "pane focado está na tela"). O que importa aqui é que NÃO
    // volta a desenhar a árvore inteira: o pane da missão fica de fora.
    expect(attachedPaneIds()).toEqual(['pane-novo-1', 'pane-novo-2']);
  });

  it('sem foco em pane nenhum, escopo evaporado cai no primeiro com pane', () => {
    seedMissionPlusSpace();
    useLayoutStore.setState({ focusedPaneId: null });
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-que-sumiu'));

    mount(<TerminalWorkspace />);

    expect(attachedPaneIds()).toEqual(['pane-missao-a']);
  });

  it('dentro da missão, o painel de outro espaço não entra no mosaico', () => {
    seedMissionPlusSpace();

    mount(<TerminalWorkspace missionId="mission-a" onBackToBoard={vi.fn()} />);

    expect(attachedPaneIds()).toEqual(['pane-missao-a']);
  });
});

// ── F-560: o painel focado está SEMPRE na tela ───────────────────────────────

describe('TerminalWorkspace — foco puxa a aba (F-560)', () => {
  function seedTwoScopes(): void {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-da-missao',
          kind: 'cli-agent',
          title: 'Worker',
          adapterId: 'codex',
          missionId: 'mission-a',
        },
        { id: 'pane-de-login', kind: 'shell', title: 'Login' },
      ]),
      focusedPaneId: 'pane-da-missao',
    });
    useOrchStore.setState({
      paneMissions: { 'pane-da-missao': 'mission-a' },
      missions: [],
      missionSummaries: [
        {
          id: 'mission-a',
          title: 'Missão A',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 1,
        },
      ],
    });
  }

  it('o pane de login recém-focado traz a aba dele junto — nunca OAuth invisível', () => {
    seedTwoScopes();
    const { host } = mount(<TerminalWorkspace />);
    expect(activeChipLabel(host)).toBe('Missão A');

    // É isto que cli-login-terminal / instalação de CLI / voz fazem: criam o
    // pane e dão foco nele, sem saber que aba está aberta.
    act(() => {
      useLayoutStore.getState().focus('pane-de-login');
    });

    expect(activeChipLabel(host)).toBe('Painéis soltos');
    expect(attachedPaneIds()).toContain('pane-de-login');
  });

  it('clicar numa aba NÃO é desfeito pelo foco antigo', () => {
    seedTwoScopes();
    const { host } = mount(<TerminalWorkspace />);

    act(() => {
      usePaneScopeStore.getState().focusScope(LOOSE_SCOPE_KEY);
    });

    // O foco continua no pane da missão, mas o operador escolheu esta aba.
    expect(activeChipLabel(host)).toBe('Painéis soltos');
  });

  it('dentro de uma missão o foco não troca a aba — a vista é daquela missão', () => {
    seedTwoScopes();
    mount(<TerminalWorkspace missionId="mission-a" onBackToBoard={vi.fn()} />);

    act(() => {
      useLayoutStore.getState().focus('pane-de-login');
    });

    expect(attachedPaneIds()).toEqual(['pane-da-missao']);
  });
});

// ── F-560: escopo único não filtra — identidade da árvore é o contrato ───────

describe('TerminalWorkspace — filtro é no-op quando cobre tudo (F-560)', () => {
  it('escopo único devolve undefined, não um Set com todos os panes', () => {
    // Por que isto importa: com um Set, PaneGrid reconstrói a árvore via
    // buildGridTree, que cunha ids novos a cada recomputação. Como este
    // componente assina missionSummaries/paneMissions, isso remonta o mosaico a
    // cada atualização de missão e MATA a sessão de PTY por baixo. O gate de
    // release pegou exatamente isso no app empacotado.
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'pane-a', kind: 'shell', title: 'A' },
        { id: 'pane-b', kind: 'shell', title: 'B' },
      ]),
      focusedPaneId: 'pane-a',
      viewKind: 'canvas',
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [],
    });

    mount(<TerminalWorkspace />);

    expect(canvasViewProps().visiblePaneIds).toBeUndefined();
  });

  it('com dois escopos o filtro volta a existir — aí ele tem o que filtrar', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-missao',
          kind: 'cli-agent',
          title: 'Worker',
          adapterId: 'codex',
          missionId: 'mission-a',
        },
        { id: 'pane-solto', kind: 'shell', title: 'Solto' },
      ]),
      focusedPaneId: 'pane-missao',
      viewKind: 'canvas',
    });
    useOrchStore.setState({
      paneMissions: { 'pane-missao': 'mission-a' },
      missions: [],
      missionSummaries: [
        {
          id: 'mission-a',
          title: 'Missão A',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 1,
        },
      ],
    });

    mount(<TerminalWorkspace />);

    const visible = canvasViewProps().visiblePaneIds;
    expect(visible).toBeDefined();
    expect([...visible!]).toEqual(['pane-missao']);
  });
});

// ── Renomear a aba do espaço (duplo clique no chip) ────────────────────────

describe('TerminalWorkspace — renomear espaço pelo chip', () => {
  function seedSpaceScope(): void {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-missao-a',
          kind: 'cli-agent',
          title: 'Worker da missão A',
          adapterId: 'codex',
          missionId: 'mission-a',
        },
        {
          id: 'pane-espaco-1',
          kind: 'cli-agent',
          title: 'Codex',
          adapterId: 'codex',
          spaceId: 'space-novo',
          spaceTitle: 'Meus terminais 2',
        },
        {
          id: 'pane-espaco-2',
          kind: 'cli-agent',
          title: 'DeepSeek',
          adapterId: 'deepseek',
          spaceId: 'space-novo',
          spaceTitle: 'Meus terminais 2',
        },
      ]),
      focusedPaneId: 'pane-espaco-1',
    });
    useOrchStore.setState({
      paneMissions: { 'pane-missao-a': 'mission-a' },
      missions: [],
      missionSummaries: [
        {
          id: 'mission-a',
          title: 'Missão A',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 1,
        },
      ],
    });
  }

  function spaceChipLabel(host: HTMLElement): HTMLElement {
    const chip = host.querySelector(
      '.terminal-workspace__filter-chip[data-scope-kind="space"]',
    );
    const label = chip?.querySelector<HTMLElement>(
      '.terminal-workspace__filter-label',
    );
    expect(label).not.toBeNull();
    return label!;
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('duplo clique abre edição inline e Enter renomeia a aba inteira', () => {
    seedSpaceScope();
    const { host } = mount(<TerminalWorkspace />);

    act(() => {
      spaceChipLabel(host).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });

    const input = host.querySelector<HTMLInputElement>(
      '.terminal-workspace__chip-rename',
    );
    expect(input).not.toBeNull();
    expect(input!.value).toBe('Meus terminais 2');

    act(() => {
      setInputValue(input!, 'Build da API');
      input!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(spaceChipLabel(host).textContent).toBe('Build da API');
    const storeTitles = listPanes(useLayoutStore.getState().root)
      .filter((pane) => pane.spaceId === 'space-novo')
      .map((pane) => pane.spaceTitle);
    expect(storeTitles).toEqual(['Build da API', 'Build da API']);
  });

  it('Escape cancela a edição sem tocar no nome', () => {
    seedSpaceScope();
    const { host } = mount(<TerminalWorkspace />);

    act(() => {
      spaceChipLabel(host).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });
    const input = host.querySelector<HTMLInputElement>(
      '.terminal-workspace__chip-rename',
    );
    expect(input).not.toBeNull();

    act(() => {
      setInputValue(input!, 'Nome que não pega');
      input!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(
      host.querySelector('.terminal-workspace__chip-rename'),
    ).toBeNull();
    expect(spaceChipLabel(host).textContent).toBe('Meus terminais 2');
  });

  it('chip de missão não entra em edição', () => {
    seedSpaceScope();
    const { host } = mount(<TerminalWorkspace />);

    const missionLabel = host
      .querySelector(
        '.terminal-workspace__filter-chip[data-scope-kind="mission"]',
      )
      ?.querySelector<HTMLElement>('.terminal-workspace__filter-label');
    expect(missionLabel).not.toBeNull();

    act(() => {
      missionLabel!.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });

    expect(
      host.querySelector('.terminal-workspace__chip-rename'),
    ).toBeNull();
  });
});
