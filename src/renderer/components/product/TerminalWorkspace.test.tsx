/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccessStore } from '../../state/access-store';
import type { PaneModel } from '../../../shared/types';
import { buildGridTree, listPanes } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
import { usePaneScopeStore } from '../../state/pane-scope-store';
import { TAB_ORDER_STORAGE_KEY, useTabOrderStore } from '../../state/tab-order-store';
import {
  ALL_SCOPES_KEY,
  LOOSE_SCOPE_KEY,
  missionScopeKey,
  spaceScopeKey,
} from '../../lib/pane-spaces';
import { TerminalWorkspace } from './TerminalWorkspace';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useConfirmStore } from '../../state/confirm-store';
import { useSessionStateStore } from '../../state/session-state-store';

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
vi.mock('../PaneGrid', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../PaneGrid')>();
  return {
    ...mod,
    PaneGrid: (props: Parameters<typeof mod.PaneGrid>[0]) => {
      (globalThis as Record<string, unknown>).__nexusPaneGridProps = props;
      const RealPaneGrid = mod.PaneGrid;
      return <RealPaneGrid {...props} />;
    },
  };
});

function paneGridProps(): {
  visiblePaneIds?: ReadonlySet<string>;
  onPaneCreated?: (paneId: string) => void;
} {
  return (
    ((globalThis as Record<string, unknown>).__nexusPaneGridProps as {
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
      pipes: {
        list: vi.fn(async () => []),
        add: vi.fn(async () => ({ ok: true, id: 'pipe-test' })),
        remove: vi.fn(async () => undefined),
        onChanged: vi.fn(() => vi.fn()),
      },
    },
  });
}

function seedLayout(): void {
  useLayoutStore.setState({
    root: buildGridTree(PANES),
    focusedPaneId: PANES[0]!.id,
    maximizedPaneId: null,
    hydrated: true,
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

/** Títulos das abas, na ordem da barra (a visão geral não é aba). */
function chipLabels(host: HTMLElement): string[] {
  return [
    ...host.querySelectorAll('[role="tab"] .workspace-tab__title'),
  ].map((label) => label.textContent ?? '');
}

function activeChipLabel(host: HTMLElement): string | undefined {
  return (
    host
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.querySelector('.workspace-tab__title')?.textContent ?? undefined
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
  useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
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
  it('renders the canonical grid surface from layout state', () => {
    const { host } = mount(<TerminalWorkspace />);

    expect(host.querySelector('.grid')).not.toBeNull();
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
    expect(host.textContent).toContain('Terminal da missão fechado');
    expect(host.textContent).toContain('Abrir Quadro');
  });

  it('missão dormindo tem rótulo e retomada coerentes', () => {
    seedLayout();
    useOrchStore.setState({
      missions: [{ id: 'sleeping', title: 'Feature', status: 'blocked', intentState: 'blocked_user',
        description: '<!-- nexus:leftover-parked -->', milestones: [], learnings: '', createdAt: 1, updatedAt: 2 }],
      missionSummaries: [{ id: 'sleeping', title: 'Feature', state: 'blocked_user',
        stateReason: { code: 'session-sleeping', label: 'Dormindo' },
        progress: { completed: 0, total: 1 }, needsAttention: false, updatedAt: 2 }],
    });
    const { host } = mount(<TerminalWorkspace missionId="sleeping" />);
    expect(host.querySelector('.product-workspace__context')?.textContent).toBe('Missão · Dormindo');
    expect(host.textContent).toContain('Retomar missão');
    expect(host.textContent).not.toContain('Precisa de você');
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(terminalRuntime.reconcileHosts).toHaveBeenCalled();
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

  it('new wizard mission keeps manual panes in the same isolated space after remount', () => {
    useOrchStore.setState({ missions: [{ id: 'm-1', title: 'Entrega isolada', intentContract: { workspaceBinding: { version: 1, spaceId: 'space-wizard-view' } } } as import('../../../shared/orch-types').Mission] });
    const first = mount(<TerminalWorkspace missionId="m-1" />);
    let paneId = '';
    act(() => {
      paneId = useLayoutStore.getState().addShellPane();
      paneGridProps().onPaneCreated?.(paneId);
    });
    expect(listPanes(useLayoutStore.getState().root).find(p => p.id === paneId)).toMatchObject({ spaceId: 'space-wizard-view', isolateSpace: true });
    unmount(first);
    mount(<TerminalWorkspace missionId="m-1" />);
    // All panes in the isolated space remain visible without volatile pins.
    const visible = paneGridProps().visiblePaneIds;
    expect(visible === undefined || visible.has(paneId)).toBe(true);
  });

  it('mostra só o pane da missão antes do operador criar algo', () => {
    mount(<TerminalWorkspace missionId="m-1" />);

    expect(attachedIds()).toEqual(['pane-w1']);
  });

  it('terminal criado na vista da missão é fixado no filtro', () => {
    mount(<TerminalWorkspace missionId="m-1" />);

    // Só o pane da missão na árvore: não há o que filtrar, então a vista usa a
    // árvore canônica (undefined) em vez de um Set redundante — ver o contrato
    // "filtro é no-op quando cobre tudo".
    expect(paneGridProps().visiblePaneIds).toBeUndefined();
    expect(typeof paneGridProps().onPaneCreated).toBe('function');

    // A barra do mosaico cria o shell e avisa: o id entra no filtro da vista.
    act(() => paneGridProps().onPaneCreated?.('pane-op'));
    expect([...(paneGridProps().visiblePaneIds ?? [])]).toEqual(
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

    expect(chipLabels(host)).toEqual(['Checkout da loja', 'Blog da release']);
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

    expect(chipLabels(host)).toEqual(['Missão X', 'Terminais']);
    expect(attachedPaneIds()).toEqual(['pane-mission']);

    act(() => {
      usePaneScopeStore.getState().focusScope(LOOSE_SCOPE_KEY);
    });

    expect(activeChipLabel(host)).toBe('Terminais');
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

  it('trocar de campo leva o foco junto — o ditado não cai no agente escondido (23/09)', () => {
    seedMissionPlusSpace();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-novo'));
    const { host } = mount(<TerminalWorkspace />);
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-novo-1');

    const missionCard = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent?.includes('Missão A'),
    );
    expect(missionCard).toBeTruthy();
    act(() => missionCard!.click());

    expect(activeChipLabel(host)).toBe('Missão A');
    // Antes: o foco ficava em pane-novo-1 (escondido) e o ditado ia para lá.
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-missao-a');
  });

  it('focar um pane de OUTRO campo (login, ⌘K, voz) leva o campo sem desviar o foco', () => {
    seedMissionPlusSpace();
    useLayoutStore.setState({ focusedPaneId: 'pane-missao-a' });
    usePaneScopeStore.getState().focusScope(missionScopeKey('mission-a'));
    const { host } = mount(<TerminalWorkspace />);
    expect(activeChipLabel(host)).toBe('Missão A');

    // O terminal de login (ou o ⌘K) foca o 2º pane do outro campo.
    act(() => useLayoutStore.getState().focus('pane-novo-2'));

    expect(activeChipLabel(host)).toBe('Meus terminais 2');
    // Antes: o efeito do campo via o foco "fora da tela" (ainda o campo
    // antigo) e o mandava para outro pane — o OAuth/ditado ia parar errado.
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-novo-2');
  });

  it('F-231: focar o pane solto carimbado na aba da missão não o puxa para Terminais', () => {
    seedMissionPlusSpace();
    // "+ Pane → Nesta aba (solto)" dentro da aba da missão: o carimbo
    // persistido (`homeScopeKey`) faz o foco seguir para a aba da missão.
    const solto = useLayoutStore.getState().addShellPane();
    useLayoutStore.getState().assignPaneHomeScopeKey(
      solto,
      missionScopeKey('mission-a'),
    );
    usePaneScopeStore.getState().focusScope(missionScopeKey('mission-a'));
    const { host } = mount(<TerminalWorkspace />);
    expect(activeChipLabel(host)).toBe('Missão A');

    act(() => useLayoutStore.getState().focus(solto));

    // Sem o carimbo o pane solto pertenceria a "Terminais" e o campo pulava
    // para lá. Com a casa persistida o campo segue o pane para a missão.
    expect(activeChipLabel(host)).toBe('Missão A');
    expect(useLayoutStore.getState().focusedPaneId).toBe(solto);
  });

  it('cada escopo vira uma aba, com a contagem de painéis', () => {
    seedMissionPlusSpace();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-novo'));

    const { host } = mount(<TerminalWorkspace />);

    expect(chipLabels(host)).toEqual(['Missão A', 'Meus terminais 2']);
    expect(
      [...host.querySelectorAll('.workspace-tab__count')].map(
        (count) => count.textContent,
      ),
    ).toEqual(['1', '2']);
    expect(activeChipLabel(host)).toBe('Meus terminais 2');
  });

  it('WEB-13: Alt+Shift+← reordena as abas, guarda a ordem e mantém o foco na aba movida', () => {
    seedMissionPlusSpace();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-novo'));
    try {
      const { host } = mount(<TerminalWorkspace />);
      const spaceTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
      spaceTab.focus();
      act(() => {
        spaceTab.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true }),
        );
      });

      expect(chipLabels(host)).toEqual(['Meus terminais 2', 'Missão A']);
      expect(document.activeElement?.getAttribute('data-scope-key')).toBe(spaceScopeKey('space-novo'));
      expect(useTabOrderStore.getState().order.slice(0, 2)).toEqual([
        spaceScopeKey('space-novo'),
        missionScopeKey('mission-a'),
      ]);
      expect(JSON.parse(window.localStorage.getItem(TAB_ORDER_STORAGE_KEY) ?? '[]')).toEqual(
        useTabOrderStore.getState().order,
      );
      // A aba ativa não muda por mover: só a posição.
      expect(activeChipLabel(host)).toBe('Meus terminais 2');
    } finally {
      useTabOrderStore.getState().setOrder([]);
    }
  });

  it('exibe o botão Nova missão na barra de abas e aciona openNewMission', () => {
    seedMissionPlusSpace();
    const { host } = mount(<TerminalWorkspace />);

    const newMissionBtn = host.querySelector<HTMLButtonElement>(
      '.workspace-tabs__mission',
    );
    expect(newMissionBtn).not.toBeNull();
    act(() => {
      newMissionBtn?.click();
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
  });

  it('a aba da missão carrega o estado dela — no glifo e na palavra', () => {
    seedMissionPlusSpace();
    const { host } = mount(<TerminalWorkspace />);

    const missionTab = host.querySelector('.workspace-tab[data-scope-kind="mission"]');
    expect(missionTab?.getAttribute('data-tone')).toBe('live');
    // Estado nunca viaja só em cor: o nome acessível diz a palavra.
    expect(
      missionTab?.querySelector('[role="tab"]')?.getAttribute('aria-label'),
    ).toMatch(/Missão A, .+, 1 painel/);
  });

  it('o código do motivo do resumo chega à aba — Maestro ocioso diz Aguardando (F-198)', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-maestro',
          kind: 'cli-agent',
          title: 'Maestro',
          adapterId: 'codex',
          missionId: 'mission-x',
          role: 'orchestrator',
        },
      ]),
      focusedPaneId: 'pane-maestro',
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [
        {
          id: 'mission-x',
          title: 'Missão X',
          state: 'running',
          stateReason: {
            code: 'awaiting-instruction',
            label: 'Aguardando sua instrução',
          },
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 1,
        },
      ],
    });

    const { host } = mount(<TerminalWorkspace />);

    const missionTab = host.querySelector(
      '.workspace-tab[data-scope-kind="mission"]',
    );
    expect(missionTab?.getAttribute('data-tone')).toBe('idle');
    const tab = missionTab?.querySelector('[role="tab"]');
    expect(tab?.getAttribute('aria-label')).toContain('Aguardando');
    expect(tab?.getAttribute('aria-label')).not.toContain('Trabalhando');
    expect(tab?.getAttribute('title')).toContain('Aguardando');
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

  it('a visão geral continua existindo para quem quer o mosaico inteiro', () => {
    seedMissionPlusSpace();
    usePaneScopeStore.getState().focusScope(ALL_SCOPES_KEY);

    const { host } = mount(<TerminalWorkspace />);

    expect(
      host
        .querySelector('.workspace-tabs__overview')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();

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

    expect(activeChipLabel(host)).toBe('Terminais');
    expect(attachedPaneIds()).toContain('pane-de-login');
  });

  it('clicar numa aba NÃO é desfeito pelo foco antigo', () => {
    seedTwoScopes();
    const { host } = mount(<TerminalWorkspace />);

    act(() => {
      usePaneScopeStore.getState().focusScope(LOOSE_SCOPE_KEY);
    });

    // O foco continua no pane da missão, mas o operador escolheu esta aba.
    expect(activeChipLabel(host)).toBe('Terminais');
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
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [],
    });

    mount(<TerminalWorkspace />);

    expect(paneGridProps().visiblePaneIds).toBeUndefined();
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

    const visible = paneGridProps().visiblePaneIds;
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
      '.workspace-tab[data-scope-kind="space"]',
    );
    const label = chip?.querySelector<HTMLElement>(
      '.workspace-tab__title',
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
      '.workspace-tab__rename',
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
      '.workspace-tab__rename',
    );
    expect(input).not.toBeNull();

    act(() => {
      setInputValue(input!, 'Nome que não pega');
      input!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(
      host.querySelector('.workspace-tab__rename'),
    ).toBeNull();
    expect(spaceChipLabel(host).textContent).toBe('Meus terminais 2');
  });

  it('chip de missão não entra em edição', () => {
    seedSpaceScope();
    const { host } = mount(<TerminalWorkspace />);

    const missionLabel = host
      .querySelector(
        '.workspace-tab[data-scope-kind="mission"]',
      )
      ?.querySelector<HTMLElement>('.workspace-tab__title');
    expect(missionLabel).not.toBeNull();

    act(() => {
      missionLabel!.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });

    expect(
      host.querySelector('.workspace-tab__rename'),
    ).toBeNull();
  });
});

// ── Abas de feature (23/09): a aba agrupa panes, missão e divisão de tela ──

describe('TerminalWorkspace — abas de feature', () => {
  const running = {
    progress: { completed: 0, total: 1 },
    needsAttention: false,
    updatedAt: 1,
  };

  beforeEach(() => {
    // O picker rola a opção ativa para a vista; jsdom não implementa.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    useConfirmStore.setState({ pending: null, queue: [] });
  });

  function seedTwoSpaces(): void {
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'pane-a1', kind: 'shell', title: 'a1', spaceId: 'space-a', spaceTitle: 'Checkout' },
        { id: 'pane-a2', kind: 'shell', title: 'a2', spaceId: 'space-a', spaceTitle: 'Checkout' },
        { id: 'pane-b1', kind: 'shell', title: 'b1', spaceId: 'space-b', spaceTitle: 'Blog' },
      ]),
      focusedPaneId: 'pane-a1',
      maximizedPaneId: null,
    });
    useOrchStore.setState({ paneMissions: {}, missions: [], missionSummaries: [] });
  }

  it('missão começada por um pane do operador fica na aba dele, junto dos soltos', () => {
    // Campo 23/09: a missão "Fechar o Epic 22" nascia numa aba e o pane que a
    // começou (e o shell ao lado) em "Painéis soltos".
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'pane-shell', kind: 'shell', title: 'shell' },
        {
          id: 'pane-host',
          kind: 'cli-agent',
          title: 'Claude',
          adapterId: 'claude',
          role: 'orchestrator',
          missionId: 'mission-epic',
          missionHost: true,
        },
        {
          id: 'pane-worker',
          kind: 'cli-agent',
          title: 'Codex',
          adapterId: 'codex',
          missionId: 'mission-epic',
        },
      ]),
      focusedPaneId: 'pane-host',
      maximizedPaneId: null,
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [
        { id: 'mission-epic', title: 'Fechar o Epic 22', state: 'running', ...running },
      ],
    });

    const { host } = mount(<TerminalWorkspace />);

    expect(chipLabels(host)).toEqual(['Terminais']);
    expect(attachedPaneIds()).toEqual(['pane-host', 'pane-shell', 'pane-worker']);
    const tab = host.querySelector('.workspace-tab');
    expect(tab?.getAttribute('data-tone')).toBe('live');
    expect(tab?.querySelector('[role="tab"]')?.getAttribute('title')).toMatch(
      /Missão: Fechar o Epic 22/,
    );
  });

  it('a aba que hospeda a missão mostra "Mapa da equipe" e um clique abre o mapa', () => {
    // Campo 14/10: o mapa da equipe só existia dentro do Quadro — quem vive
    // nas abas nem sabia dele.
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'pane-shell', kind: 'shell', title: 'shell' },
        {
          id: 'pane-host',
          kind: 'cli-agent',
          title: 'Claude',
          adapterId: 'claude',
          role: 'orchestrator',
          missionId: 'mission-epic',
          missionHost: true,
        },
        {
          id: 'pane-worker',
          kind: 'cli-agent',
          title: 'Codex',
          adapterId: 'codex',
          missionId: 'mission-epic',
        },
      ]),
      focusedPaneId: 'pane-host',
      maximizedPaneId: null,
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [
        { id: 'mission-epic', title: 'Fechar o Epic 22', state: 'running', ...running },
      ],
    });
    useSessionStateStore.setState({
      paneStates: new Map([['pane-host', 'idle'], ['pane-worker', 'busy']]),
      displayStates: new Map([['pane-host', 'idle'], ['pane-worker', 'busy']]),
    });
    useProductNavigationStore.getState().openTerminal();

    const { host } = mount(<TerminalWorkspace />);
    const button = host.querySelector<HTMLButtonElement>('.workspace-tabs__team');

    expect(button?.getAttribute('aria-label')).toBe(
      'Abrir o mapa da equipe de “Fechar o Epic 22”: coordenador e 1 agente, 1 trabalhando',
    );
    act(() => button!.click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-epic',
      surface: 'board',
    });
    useSessionStateStore.setState({ paneStates: new Map(), displayStates: new Map() });
  });

  it('aba só de terminais não ganha o mapa da equipe', () => {
    seedTwoSpaces();

    const { host } = mount(<TerminalWorkspace />);

    expect(host.querySelector('.workspace-tabs__team')).toBeNull();
  });

  it('o "+" da barra abre uma aba NOVA com o pane escolhido e leva o operador até ela', () => {
    useLayoutStore.setState({
      root: buildGridTree([{ id: 'pane-shell', kind: 'shell', title: 'shell' }]),
      focusedPaneId: 'pane-shell',
      maximizedPaneId: null,
    });
    useOrchStore.setState({ paneMissions: {}, missions: [], missionSummaries: [] });
    const { host } = mount(<TerminalWorkspace />);
    expect(chipLabels(host)).toEqual(['Terminais']);

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="tab-picker-trigger"]');
    if (!trigger) throw new Error('sem o "+" da barra de abas');
    act(() => trigger.click());
    const entry = host.querySelector<HTMLButtonElement>(
      '[data-testid="pane-picker-entry-type:terminal"]',
    );
    if (!entry) throw new Error('sem a entrada Terminal no picker');
    act(() => entry.click());

    expect(chipLabels(host)).toEqual(['Terminais', 'Meus terminais']);
    expect(activeChipLabel(host)).toBe('Meus terminais');
    const created = listPanes(useLayoutStore.getState().root).find(
      (pane) => pane.id !== 'pane-shell',
    );
    expect(created).toMatchObject({ spaceTitle: 'Meus terminais' });
    expect(useLayoutStore.getState().focusedPaneId).toBe(created?.id);
  });

  it('ver ao lado: duas abas na tela, cada metade com os painéis dela', () => {
    seedTwoSpaces();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-a'));
    const { host } = mount(<TerminalWorkspace />);
    expect(host.querySelectorAll('.terminal-workspace__half')).toHaveLength(0);

    act(() =>
      usePaneScopeStore
        .getState()
        .showBeside(spaceScopeKey('space-b'), spaceScopeKey('space-a')),
    );

    const halves = [...host.querySelectorAll('.terminal-workspace__half')];
    expect(
      halves.map(
        (half) => half.querySelector('.terminal-workspace__half-title')?.textContent,
      ),
    ).toEqual(['Checkout', 'Blog']);
    expect(halves[0]?.querySelectorAll('.pane__terminal')).toHaveLength(2);
    expect(halves[1]?.querySelectorAll('.pane__terminal')).toHaveLength(1);
    expect(
      host
        .querySelector('.workspace-tab[data-side]')
        ?.querySelector('.workspace-tab__title')?.textContent,
    ).toBe('Blog');

    act(() =>
      host.querySelector<HTMLButtonElement>('.terminal-workspace__half-close')!.click(),
    );
    expect(host.querySelectorAll('.terminal-workspace__half')).toHaveLength(0);
  });

  it('focar um pane da aba ao lado não troca de aba — ele já está na tela', () => {
    seedTwoSpaces();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-a'));
    const { host } = mount(<TerminalWorkspace />);
    act(() =>
      usePaneScopeStore
        .getState()
        .showBeside(spaceScopeKey('space-b'), spaceScopeKey('space-a')),
    );

    act(() => useLayoutStore.getState().focus('pane-b1'));

    expect(activeChipLabel(host)).toBe('Checkout');
    expect(host.querySelectorAll('.terminal-workspace__half')).toHaveLength(2);
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-b1');
  });

  it('fechar a aba pede confirmação e encerra só os painéis dela', async () => {
    seedTwoSpaces();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-a'));
    const { host } = mount(<TerminalWorkspace />);

    const blogClose = host
      .querySelector('.workspace-tab[data-scope-kind="space"]:not([data-active])')
      ?.querySelector<HTMLButtonElement>('.workspace-tab__close');
    expect(blogClose?.getAttribute('aria-label')).toBe('Fechar a aba Blog');
    act(() => blogClose!.click());
    expect(useConfirmStore.getState().pending?.title).toBe('Fechar a aba “Blog”?');
    await act(async () => {
      useConfirmStore.getState().decide(true);
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual([
      'pane-a1',
      'pane-a2',
    ]);
  });

  it('aba com missão viva não oferece o × — a missão se encerra pelo Quadro', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'pane-m', kind: 'cli-agent', title: 'w', adapterId: 'codex', missionId: 'mission-x' },
        { id: 'pane-s', kind: 'shell', title: 's' },
      ]),
      focusedPaneId: 'pane-s',
      maximizedPaneId: null,
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [{ id: 'mission-x', title: 'Missão X', state: 'running', ...running }],
    });

    const { host } = mount(<TerminalWorkspace />);

    expect(
      host
        .querySelector('.workspace-tab[data-scope-kind="mission"]')
        ?.querySelector('.workspace-tab__close'),
    ).toBeNull();
    expect(
      host
        .querySelector('.workspace-tab[data-scope-kind="loose"]')
        ?.querySelector('.workspace-tab__close'),
    ).not.toBeNull();
  });

  it('dar nome à aba Terminais cria um espaço com os panes dela', () => {
    useLayoutStore.setState({
      root: buildGridTree([{ id: 'pane-shell', kind: 'shell', title: 'shell' }]),
      focusedPaneId: 'pane-shell',
      maximizedPaneId: null,
    });
    useOrchStore.setState({ paneMissions: {}, missions: [], missionSummaries: [] });
    const { host } = mount(<TerminalWorkspace />);

    act(() => {
      host
        .querySelector('.workspace-tab__title')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>('.workspace-tab__rename');
    if (!input) throw new Error('sem edição inline');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'Epic 22');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(chipLabels(host)).toEqual(['Epic 22']);
    expect(listPanes(useLayoutStore.getState().root)[0]).toMatchObject({
      spaceTitle: 'Epic 22',
    });
  });

  it('«Criar missão desta aba» na aba dormindo coroa o pane VIVO, não o Maestro morto (F-373)', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: true, mission: { id: 'm-new' } }));
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    (window as unknown as { nexus: Record<string, unknown> }).nexus.orch = {
      createPaneMission,
      promoteMissionOrchestrator,
    };
    useLayoutStore.setState({
      root: buildGridTree([
        // O transcript morto do Maestro da missão dormindo ainda ocupa a aba.
        {
          id: 'pane-morto', kind: 'cli-agent', title: 'Claude morto', adapterId: 'claude',
          spaceId: 'space-a', spaceTitle: 'Checkout', missionId: 'm-sleep',
          missionHost: true, role: 'orchestrator',
        },
        { id: 'pane-vivo', kind: 'cli-agent', title: 'Codex vivo', adapterId: 'codex', spaceId: 'space-a', spaceTitle: 'Checkout' },
      ]),
      focusedPaneId: 'pane-morto',
      maximizedPaneId: null,
    });
    useSessionStateStore.setState({
      paneStates: new Map([
        ['pane-morto', 'exited'],
        ['pane-vivo', 'idle'],
      ]) as never,
    });
    useOrchStore.setState({
      paneMissions: { 'pane-morto': 'm-sleep' },
      missions: [
        {
          id: 'm-sleep', title: 'Missão · Checkout', status: 'blocked',
          intentState: 'blocked_user',
          description: 'Trabalho anterior. <!-- nexus:leftover-parked -->',
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2,
        } as import('../../../shared/orch-types').Mission,
      ],
      missionSummaries: [
        {
          id: 'm-sleep', title: 'Missão · Checkout', state: 'blocked_user',
          stateReason: { code: 'session-sleeping', label: 'Dormindo' },
          progress: { completed: 0, total: 1 }, needsAttention: false, updatedAt: 2,
        } as never,
      ],
    });

    const { host } = mount(<TerminalWorkspace />);
    const tab = host.querySelector('.workspace-tab[data-scope-kind="space"]')!;
    act(() => {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const item = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((entry) => entry.textContent?.includes('Criar missão desta aba'))!;
    await act(async () => {
      item.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(createPaneMission).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-vivo' }),
    );
    expect(promoteMissionOrchestrator).not.toHaveBeenCalled();
    useSessionStateStore.setState({ paneStates: new Map() });
  });

  it('⌘/Ctrl+Alt+→ passa para a próxima aba', () => {
    seedTwoSpaces();
    usePaneScopeStore.getState().focusScope(spaceScopeKey('space-a'));
    const { host } = mount(<TerminalWorkspace />);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(activeChipLabel(host)).toBe('Blog');
  });
});

describe('TerminalWorkspace — agentes trabalhando agora', () => {
  const AGENTS: PaneModel[] = [
    {
      id: 'ag-a1',
      kind: 'cli-agent',
      title: 'Claude · Tarefa A',
      adapterId: 'claude',
      spaceId: 'space-a',
      spaceTitle: 'Checkout',
    },
    {
      id: 'ag-a2',
      kind: 'cli-agent',
      title: 'GPT · Tarefa B',
      adapterId: 'codex',
      spaceId: 'space-a',
      spaceTitle: 'Checkout',
    },
    {
      id: 'ag-b1',
      kind: 'cli-agent',
      title: 'Grok · Tarefa C',
      adapterId: 'grok',
      spaceId: 'space-b',
      spaceTitle: 'Blog',
    },
    { id: 'sh-b', kind: 'shell', title: 'zsh', spaceId: 'space-b', spaceTitle: 'Blog' },
  ];

  function seedAgents(states: Record<string, 'busy' | 'idle' | 'exited'>): () => void {
    useLayoutStore.setState({
      root: buildGridTree(AGENTS),
      focusedPaneId: 'ag-a1',
      maximizedPaneId: null,
    });
    act(() => {
      for (const [paneId, state] of Object.entries(states)) {
        useSessionStateStore.getState().setPaneState(paneId, state);
      }
    });
    return () => {
      act(() => {
        for (const paneId of Object.keys(states)) {
          useSessionStateStore.getState().clearPaneState(paneId);
        }
      });
    };
  }

  const tabBy = (host: HTMLElement, title: string) =>
    [...host.querySelectorAll<HTMLElement>('.workspace-tab')].find(
      (tab) => tab.querySelector('.workspace-tab__title')?.textContent === title,
    )!;

  it('cada aba conta os agentes dela que trabalham e a palavra vai no nome acessível', () => {
    const restore = seedAgents({ 'ag-a1': 'busy', 'ag-a2': 'busy', 'ag-b1': 'idle' });
    try {
      usePaneScopeStore.getState().focusScope(spaceScopeKey('space-a'));
      const { host } = mount(<TerminalWorkspace />);
      const checkout = tabBy(host, 'Checkout');
      const blog = tabBy(host, 'Blog');

      expect(checkout.querySelector('.workspace-tab__working')?.textContent).toBe('2');
      expect(checkout.querySelector('[role="tab"]')!.getAttribute('aria-label')).toContain(
        '2 trabalhando agora',
      );
      expect(blog.querySelector('.workspace-tab__working')).toBeNull();
    } finally {
      restore();
    }
  });

  it('o shell não conta como agente e o agente que terminou sai da contagem', () => {
    const restore = seedAgents({ 'ag-a1': 'idle', 'ag-a2': 'exited', 'ag-b1': 'busy' });
    try {
      usePaneScopeStore.getState().focusScope(spaceScopeKey('space-a'));
      const { host } = mount(<TerminalWorkspace />);

      expect(tabBy(host, 'Checkout').querySelector('.workspace-tab__working')).toBeNull();
      expect(tabBy(host, 'Blog').querySelector('.workspace-tab__working')?.textContent).toBe('1');
    } finally {
      restore();
    }
  });

  it('o selo da aba acompanha o estado ao vivo', () => {
    const restore = seedAgents({ 'ag-a1': 'idle', 'ag-a2': 'idle', 'ag-b1': 'idle' });
    try {
      usePaneScopeStore.getState().focusScope(spaceScopeKey('space-a'));
      const { host } = mount(<TerminalWorkspace />);
      expect(host.querySelector('.workspace-tab__working')).toBeNull();

      act(() => useSessionStateStore.getState().setPaneState('ag-b1', 'busy'));
      expect(tabBy(host, 'Blog').querySelector('.workspace-tab__working')?.textContent).toBe('1');
    } finally {
      restore();
    }
  });

  it('o cabeçalho dos Terminais da missão diz quantos trabalham nela, em paralelo a partir de dois', () => {
    const missionPanes: PaneModel[] = [
      { id: 'mp-1', kind: 'cli-agent', title: 'Claude · A', adapterId: 'claude', missionId: 'mission-x' },
      { id: 'mp-2', kind: 'cli-agent', title: 'GPT · B', adapterId: 'codex', missionId: 'mission-x' },
      { id: 'mp-3', kind: 'cli-agent', title: 'Grok · C', adapterId: 'grok', missionId: 'mission-y' },
    ];
    useLayoutStore.setState({
      root: buildGridTree(missionPanes),
      focusedPaneId: 'mp-1',
      maximizedPaneId: null,
    });
    useOrchStore.setState({
      paneMissions: { 'mp-1': 'mission-x', 'mp-2': 'mission-x', 'mp-3': 'mission-y' },
    });
    act(() => {
      useSessionStateStore.getState().setPaneState('mp-1', 'busy');
      useSessionStateStore.getState().setPaneState('mp-3', 'busy');
    });
    try {
      const { host } = mount(<TerminalWorkspace missionId="mission-x" onBackToBoard={vi.fn()} />);
      const live = () => host.querySelector('.terminal-workspace__live')?.textContent;

      // Só conta o que a missão desenha: o agente da outra missão não entra.
      expect(live()).toBe('1 trabalhando agora');

      act(() => useSessionStateStore.getState().setPaneState('mp-2', 'busy'));
      expect(live()).toBe('2 trabalhando agora · em paralelo');

      act(() => {
        useSessionStateStore.getState().setPaneState('mp-1', 'exited');
        useSessionStateStore.getState().setPaneState('mp-2', 'exited');
      });
      expect(live()).toBeUndefined();
    } finally {
      act(() => {
        for (const paneId of ['mp-1', 'mp-2', 'mp-3']) {
          useSessionStateStore.getState().clearPaneState(paneId);
        }
      });
    }
  });
});

describe('TerminalWorkspace — o estado dos agentes não re-renderiza o grid', () => {
  it('busy↔idle atualiza o selo da aba sem recriar as props do PaneGrid', () => {
    // O grid carrega os xterms; um re-render do TerminalWorkspace a cada turno
    // de agente refaria o mosaico (e entregaria callbacks novos) o tempo todo.
    // O estado vivo é assinado só pelos componentes folha de TerminalLiveSignals.
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'solo-a', kind: 'cli-agent', title: 'Claude · A', adapterId: 'claude', spaceId: 'sp', spaceTitle: 'Checkout' },
        { id: 'solo-b', kind: 'cli-agent', title: 'GPT · B', adapterId: 'codex', spaceId: 'sp', spaceTitle: 'Checkout' },
      ]),
      focusedPaneId: 'solo-a',
      maximizedPaneId: null,
    });
    usePaneScopeStore.getState().focusScope(spaceScopeKey('sp'));
    try {
      const { host } = mount(<TerminalWorkspace />);
      const before = paneGridProps();
      expect(before.onPaneCreated).toBeTypeOf('function');

      act(() => useSessionStateStore.getState().setPaneState('solo-a', 'busy'));
      expect(host.querySelector('.workspace-tab__working')?.textContent).toBe('1');
      act(() => useSessionStateStore.getState().setPaneState('solo-b', 'busy'));
      expect(host.querySelector('.workspace-tab__working')?.textContent).toBe('2');
      act(() => useSessionStateStore.getState().setPaneState('solo-a', 'exited'));
      act(() => useSessionStateStore.getState().setPaneState('solo-b', 'exited'));
      expect(host.querySelector('.workspace-tab__working')).toBeNull();

      // Mesma referência = o PaneGrid nem foi chamado de novo.
      expect(paneGridProps()).toBe(before);
    } finally {
      act(() => {
        useSessionStateStore.getState().clearPaneState('solo-a');
        useSessionStateStore.getState().clearPaneState('solo-b');
      });
    }
  });
});
