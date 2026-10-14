/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, OrchPaneSpawnRequest } from '../../shared/orch-types';
import { workspaceLayoutSchema } from '../../shared/ipc';
import type { PaneModel, WorkspaceLayout } from '../../shared/types';
import { buildGridTree, listPanes } from '../lib/split-tree';
import { setActiveWorkspacePath } from '../state/active-workspace';
import { useAccessStore } from '../state/access-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { useOrchBridge } from './orch-bridge';

const terminal = vi.hoisted(() => ({
  cancelPaneRecovery: vi.fn(),
  getPaneSessionId: vi.fn((_paneId: string) => null as string | null),
  isPaneSessionHealthy: vi.fn(() => true),
  isSpawnHeld: vi.fn((_paneId: string) => false),
  markPersistedAuthorityOnSpawn: vi.fn(),
  onPaneSessionChange: vi.fn(
    (_cb: (paneId: string, sessionId: string | null) => void) => vi.fn(),
  ),
  respawnMissionPaneFresh: vi.fn(async () => 'session-new'),
  submitPromptToPaneConfirmed: vi.fn(async () => true),
  waitForHealthyPaneSession: vi.fn(async () => 'session-new' as string | null),
  waitForSession: vi.fn(async () => 'session-new' as string | null),
}));

vi.mock('../terminal/terminal-host', () => terminal);
vi.mock('../browser/browser-host', () => ({
  waitForBrowserPaneCreated: vi.fn(async () => undefined),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function listener() {
  return vi.fn(() => vi.fn());
}

function missionBridge() {
  return {
    list: vi.fn(async () => []),
    onChanged: listener(),
  };
}

function Harness(): null {
  useOrchBridge();
  return null;
}

function mount(): Root {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return root;
}

/**
 * Layout restaurado do boot: um orquestrador morto (grant de sessão anterior),
 * um worker da mesma missão e um orquestrador de OUTRA missão. O spawn novo
 * só pode aposentar o primeiro — worker e missão vizinha intocados.
 */
function seedRestoredLayout(): void {
  useLayoutStore.setState({
    hydrated: true,
    root: {
      kind: 'split',
      id: 'split-restored',
      direction: 'row',
      children: [
        {
          kind: 'leaf',
          id: 'leaf-old-orchestrator',
          pane: {
            id: 'pane-old-orchestrator',
            kind: 'cli-agent',
            title: 'Cliente tesoura de ouro',
            adapterId: 'claude',
            missionId: 'mission-a',
            role: 'orchestrator',
            orchRequestId: 'orchspawn-from-previous-app-run',
          },
        },
        {
          kind: 'split',
          id: 'split-right',
          direction: 'column',
          children: [
            {
              kind: 'leaf',
              id: 'leaf-worker',
              pane: {
                id: 'pane-worker',
                kind: 'cli-agent',
                title: 'Worker',
                adapterId: 'codex',
                missionId: 'mission-a',
                role: 'worker',
              },
            },
            {
              kind: 'leaf',
              id: 'leaf-other-mission',
              pane: {
                id: 'pane-other-mission',
                kind: 'cli-agent',
                title: 'Outra missão',
                adapterId: 'claude',
                missionId: 'mission-b',
                role: 'orchestrator',
              },
            },
          ],
        },
      ],
    },
    focusedPaneId: 'pane-old-orchestrator',
  });
}

function orchestratorSpawnRequest(
  overrides: Partial<OrchPaneSpawnRequest> = {},
): OrchPaneSpawnRequest {
  return {
    requestId: 'orchspawn-fresh',
    paneId: 'pane-fresh',
    adapterId: 'claude',
    missionId: 'mission-a',
    role: 'orchestrator',
    resume: false,
    resumeLatestOnly: false,
    restorePersistedAuthority: false,
    ...overrides,
  };
}

describe('orchestration bridge orchestrator dedup', () => {
  beforeEach(() => {
    useLayoutStore.setState({ hydrated: true });
    useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
    terminal.getPaneSessionId.mockReset().mockReturnValue(null);
    terminal.isSpawnHeld.mockReset().mockReturnValue(false);
    terminal.waitForSession.mockReset().mockResolvedValue('session-new');
  });

  it('retires the dead orchestrator pane of the same mission once Main binds the fresh orchestrator', async () => {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    let missionsHandler: ((missions: Mission[]) => void) | null = null;
    const sendPaneSpawnResult = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: vi.fn(
            (cb: (request: OrchPaneSpawnRequest) => void) => {
              spawnHandler = cb;
              return vi.fn();
            },
          ),
          onPanePresentationRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: vi.fn((cb: (missions: Mission[]) => void) => {
            missionsHandler = cb;
            return vi.fn();
          }),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult,
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
        },
      },
    });
    seedRestoredLayout();
    // Restaurado do boot: o gate segurou o spawn — inerte, morte provada.
    terminal.isSpawnHeld.mockImplementation(
      (paneId: string) => paneId === 'pane-old-orchestrator',
    );
    const root = mount();

    act(() => {
      spawnHandler?.(orchestratorSpawnRequest());
    });
    await vi.waitFor(() => {
      expect(sendPaneSpawnResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, paneId: 'pane-fresh' }),
      );
    });

    // F-1475: o grant sozinho não é sucessor provado — o bind no Main ainda
    // pode falhar. Até lá o Maestro antigo (e o scrollback dele) fica.
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toContain('pane-old-orchestrator');

    // O Main faz o bind e publica a sessão durável do pane novo.
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-fresh' ? 'session-new' : null,
    );
    act(() =>
      missionsHandler?.([
        {
          id: 'mission-a',
          title: 'A',
          description: '',
          status: 'running',
          milestones: [],
          learnings: '',
          orchestratorSessionId: 'session-new',
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    );

    // Um orquestrador por missão: com o sucessor confirmado, o restaurado
    // sai — não pode virar o "segundo pane travado".
    const panes = listPanes(useLayoutStore.getState().root).map(
      (pane) => pane.id,
    );
    expect(panes).toEqual(
      expect.arrayContaining(['pane-fresh', 'pane-worker', 'pane-other-mission']),
    );
    expect(panes).not.toContain('pane-old-orchestrator');
    act(() => root.unmount());
  });

  it('keeps the previous orchestrator pane when the new spawn is a worker', async () => {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    const sendPaneSpawnResult = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: vi.fn(
            (cb: (request: OrchPaneSpawnRequest) => void) => {
              spawnHandler = cb;
              return vi.fn();
            },
          ),
          onPanePresentationRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult,
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
        },
      },
    });
    seedRestoredLayout();
    const root = mount();

    act(() => {
      spawnHandler?.(
        orchestratorSpawnRequest({
          requestId: 'orchspawn-worker',
          paneId: 'pane-worker-fresh',
          role: 'worker',
        }),
      );
    });
    await vi.waitFor(() => {
      expect(sendPaneSpawnResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, paneId: 'pane-worker-fresh' }),
      );
    });

    // Spawn de worker não aposenta orquestrador: só a substituição do próprio
    // orquestrador (mesma missão, papel igual) tem esse efeito.
    const panes = listPanes(useLayoutStore.getState().root).map(
      (pane) => pane.id,
    );
    expect(panes).toContain('pane-old-orchestrator');
    expect(panes).toContain('pane-worker-fresh');
    act(() => root.unmount());
  });
});

// ── onda 2: o broadcast espelha o líder do Main, não elege ───────────────────

describe('orchestration bridge leadership mirror', () => {
  beforeEach(() => {
    useLayoutStore.setState({ hydrated: true });
    useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
    // Dois orquestradores da MESMA missão: o que o Main confirma (sessão
    // durável) e um impostor que se promoveu antes da religação.
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-real',
          kind: 'cli-agent',
          title: 'Real',
          adapterId: 'claude',
          missionId: 'mission-a',
          role: 'orchestrator',
        },
        {
          id: 'pane-impostor',
          kind: 'cli-agent',
          title: 'Impostor',
          adapterId: 'codex',
          missionId: 'mission-a',
          role: 'orchestrator',
        },
        {
          id: 'pane-vizinho',
          kind: 'cli-agent',
          title: 'Outra missão',
          adapterId: 'claude',
          missionId: 'mission-b',
          role: 'orchestrator',
        },
      ]),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
    terminal.getPaneSessionId.mockReset().mockReturnValue(null);
  });

  function mountWithMissions() {
    let missionsHandler: ((missions: Mission[]) => void) | null = null;
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPanePresentationRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: vi.fn((cb: (missions: Mission[]) => void) => {
            missionsHandler = cb;
            return vi.fn();
          }),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
        },
      },
    });
    const root = mount();
    return {
      root,
      emit: (missions: Mission[]) => act(() => missionsHandler?.(missions)),
    };
  }

  function missionFixture(): Mission[] {
    return [
      {
        id: 'mission-a',
        title: 'A',
        description: '',
        status: 'running',
        milestones: [],
        learnings: '',
        orchestratorSessionId: 'session-real',
        createdAt: 1,
        updatedAt: 2,
      },
    ];
  }

  it('rebaixa o orquestrador que não bate com a sessão durável do Main', () => {
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-real' ? 'session-real' : `session-${paneId}`,
    );
    const { root, emit } = mountWithMissions();

    emit(missionFixture());

    const roles = new Map(
      listPanes(useLayoutStore.getState().root).map((p) => [p.id, p.role]),
    );
    expect(roles.get('pane-real')).toBe('orchestrator');
    expect(roles.get('pane-impostor')).toBe('worker');
    // A estrela de OUTRA missão não é minha para tirar.
    expect(roles.get('pane-vizinho')).toBe('orchestrator');
    act(() => root.unmount());
  });

  it('replay do mesmo broadcast não escreve de novo no layout', () => {
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-real' ? 'session-real' : `session-${paneId}`,
    );
    const { root, emit } = mountWithMissions();
    emit(missionFixture());
    const tree = useLayoutStore.getState().root;

    emit(missionFixture());

    // Mesma referência: nenhum `set`/`persist` por replay (o persist é
    // debounced por workspace — escrever a cada broadcast virava tempestade).
    expect(useLayoutStore.getState().root).toBe(tree);
    act(() => root.unmount());
  });

  it('missão sem líder confirmado não pinta estrela', () => {
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      `session-${paneId}`,
    );
    const { root, emit } = mountWithMissions();

    emit([
      {
        id: 'mission-a',
        title: 'A',
        description: '',
        // Missão viva, mas o Main ainda NÃO confirmou sessão durável (A):
        // ninguém lidera até ele dizer quem lidera.
        status: 'running',
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    const roles = new Map(
      listPanes(useLayoutStore.getState().root).map((p) => [p.id, p.role]),
    );
    expect(roles.get('pane-real')).toBe('worker');
    expect(roles.get('pane-impostor')).toBe('worker');
    act(() => root.unmount());
  });
});

// ── F-1475: a confirmação do líder aposenta os Maestros mortos ───────────────

describe('F-1475 — Maestros mortos saem quando o Main confirma o sucessor', () => {
  let sessionChange: ((paneId: string, sessionId: string | null) => void) | null =
    null;

  beforeEach(() => {
    useLayoutStore.setState({ hydrated: true });
    useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
    useSessionStateStore.setState({ paneStates: new Map() });
    sessionChange = null;
    terminal.onPaneSessionChange.mockImplementation(
      (cb: (paneId: string, sessionId: string | null) => void) => {
        sessionChange = cb;
        return vi.fn();
      },
    );
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
    useOrchStore.setState({ boundWorkspacePath: null, missions: [] });
    useSessionStateStore.setState({ paneStates: new Map() });
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
    terminal.getPaneSessionId.mockReset().mockReturnValue(null);
    terminal.isSpawnHeld.mockReset().mockReturnValue(false);
    terminal.onPaneSessionChange.mockReset().mockImplementation(() => vi.fn());
  });

  function mountWithMissions() {
    let missionsHandler: ((missions: Mission[]) => void) | null = null;
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPanePresentationRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: vi.fn((cb: (missions: Mission[]) => void) => {
            missionsHandler = cb;
            return vi.fn();
          }),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
        },
      },
    });
    const root = mount();
    return {
      root,
      emit: (missions: Mission[]) => act(() => missionsHandler?.(missions)),
    };
  }

  function missionA(
    orchestratorSessionId?: string,
    workspaceBinding?: { spaceId?: string; adoptedPaneId?: string },
  ): Mission {
    return {
      id: 'mission-a',
      title: 'A',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      ...(orchestratorSessionId ? { orchestratorSessionId } : {}),
      ...(workspaceBinding
        ? { intentContract: { workspaceBinding: { version: 1, ...workspaceBinding } } }
        : {}),
      createdAt: 1,
      updatedAt: 2,
    } as Mission;
  }

  function paneIds(): string[] {
    return listPanes(useLayoutStore.getState().root).map((pane) => pane.id);
  }

  function panesById(): Map<string, PaneModel> {
    return new Map(
      listPanes(useLayoutStore.getState().root).map((pane) => [pane.id, pane]),
    );
  }

  function maestrosOf(missionId: string): string[] {
    return listPanes(useLayoutStore.getState().root)
      .filter(
        (pane) =>
          pane.missionId === missionId &&
          (pane.role === 'orchestrator' || pane.seatedOrchestrator === true),
      )
      .map((pane) => pane.id);
  }

  /**
   * O mount zera o estado do projeto (resetProjectState); em produção o
   * broadcast só entra no store com o workspace vinculado.
   */
  function bindWorkspace(): void {
    setActiveWorkspacePath('/tmp/nexus-workspace');
    useOrchStore.setState({ boundWorkspacePath: '/tmp/nexus-workspace' });
  }

  it('broadcast idêntico não repete o loop de reflexão de panes', () => {
    useLayoutStore.setState({ root: buildGridTree([
      { id: 'pane-identical', kind: 'cli-agent', title: 'Maestro', missionId: 'mission-a', role: 'orchestrator' },
    ]) });
    terminal.getPaneSessionId.mockReturnValue('session-identical');
    const bridge = mountWithMissions();
    bindWorkspace();
    const mission = missionA('session-identical');
    bridge.emit([mission]);
    terminal.getPaneSessionId.mockClear();
    bridge.emit([structuredClone(mission)]);
    expect(terminal.getPaneSessionId).not.toHaveBeenCalled();
    act(() => bridge.root.unmount());
  });

  /** Morte física provada: o exit do PTY chegou a este renderer. */
  function markExited(...paneIds: string[]): void {
    for (const paneId of paneIds) {
      useSessionStateStore.getState().setPaneState(paneId, 'exited');
    }
  }

  const maestro = (
    id: string,
    overrides: Partial<PaneModel> = {},
  ): PaneModel => ({
    id,
    kind: 'cli-agent',
    title: 'Claude · Coordenar e revisar',
    adapterId: 'claude',
    missionId: 'mission-a',
    role: 'orchestrator',
    ...overrides,
  });

  const worker = (id: string): PaneModel => ({
    id,
    kind: 'cli-agent',
    title: 'Worker',
    adapterId: 'codex',
    missionId: 'mission-a',
    role: 'worker',
  });

  it('o broadcast que confirma o líder fecha os Maestros mortos, até o já rebaixado', () => {
    useLayoutStore.getState().setPanes([
      maestro('pane-real'),
      maestro('pane-dead'),
      // Rebaixado pelo espelho num broadcast anterior: escapava do filtro.
      maestro('pane-demoted', { role: 'worker', seatedOrchestrator: true }),
      // Vivo: o espelho só rebaixa, ninguém mata processo vivo daqui.
      maestro('pane-live-impostor'),
      worker('pane-worker'),
      // Pane do operador que hospedou a missão: volta para a mão dele, não fecha.
      maestro('pane-host', { missionHost: true, seatedOrchestrator: true }),
      maestro('pane-vizinho', { missionId: 'mission-b' }),
    ]);
    markExited('pane-dead', 'pane-demoted', 'pane-worker', 'pane-host', 'pane-vizinho');
    terminal.getPaneSessionId.mockImplementation((paneId: string) => {
      if (paneId === 'pane-real') return 'session-real';
      if (paneId === 'pane-live-impostor') return 'session-impostor';
      return null;
    });
    const { root, emit } = mountWithMissions();

    emit([missionA('session-real')]);

    expect(paneIds()).not.toContain('pane-dead');
    expect(paneIds()).not.toContain('pane-demoted');
    expect(paneIds()).toEqual(
      expect.arrayContaining(['pane-real', 'pane-live-impostor', 'pane-worker', 'pane-host', 'pane-vizinho']),
    );
    const byId = panesById();
    expect(byId.get('pane-real')?.role).toBe('orchestrator');
    // Layout antigo sem o campo: o líder confirmado ganha o assento durável.
    expect(byId.get('pane-real')?.seatedOrchestrator).toBe(true);
    expect(byId.get('pane-live-impostor')?.role).toBe('worker');
    expect(byId.get('pane-vizinho')?.role).toBe('orchestrator');
    // O anfitrião devolvido ao operador perde missão E assento.
    expect(byId.get('pane-host')?.missionId).toBeUndefined();
    expect(byId.get('pane-host')?.seatedOrchestrator).toBeUndefined();
    act(() => root.unmount());
  });

  it('missão do Wizard (aba isolada): o Maestro morto carimbado como casa da missão sai e o worker fica nela', () => {
    // Produção: toda missão do Wizard/Expresso tem workspaceBinding.spaceId e
    // bindMissionSpaces carimba missionHost em TODOS os panes dela.
    useOrchStore.setState({ missions: [missionA(undefined, { spaceId: 'space-a' })] });
    useLayoutStore.getState().setPanes([
      maestro('pane-real'),
      maestro('pane-dead'),
      maestro('pane-live-impostor'),
      worker('pane-worker'),
      maestro('pane-vizinho', { missionId: 'mission-b' }),
    ]);
    const stamped = panesById();
    expect(stamped.get('pane-dead')).toMatchObject({ missionHost: true, spaceId: 'space-a', isolateSpace: true });
    expect(stamped.get('pane-worker')).toMatchObject({ missionHost: true, spaceId: 'space-a' });
    markExited('pane-dead', 'pane-worker');
    terminal.getPaneSessionId.mockImplementation((paneId: string) => {
      if (paneId === 'pane-real') return 'session-real';
      if (paneId === 'pane-live-impostor') return 'session-impostor';
      return null;
    });
    const { root, emit } = mountWithMissions();
    bindWorkspace();

    emit([missionA('session-real', { spaceId: 'space-a' })]);

    // O carimbo da casa não é a mão do operador: o Maestro morto sai.
    expect(paneIds()).not.toContain('pane-dead');
    const byId = panesById();
    // E o espelho não "devolve ao operador" quem é da missão: o worker morto
    // continua na missão e na aba isolada dela.
    expect(byId.get('pane-worker')).toMatchObject({ missionId: 'mission-a', role: 'worker', spaceId: 'space-a' });
    expect(byId.get('pane-live-impostor')).toMatchObject({ missionId: 'mission-a', role: 'worker' });
    expect(byId.get('pane-real')).toMatchObject({ missionId: 'mission-a', role: 'orchestrator' });
    expect(paneIds()).toContain('pane-vizinho');
    act(() => root.unmount());
  });

  it('aba isolada com pane adotado pelo Main (adoptedPaneId): o anfitrião volta ao operador, não fecha', () => {
    useOrchStore.setState({
      missions: [missionA(undefined, { spaceId: 'space-a', adoptedPaneId: 'pane-host' })],
    });
    useLayoutStore.getState().setPanes([
      maestro('pane-real'),
      maestro('pane-host', { missionHost: true }),
      maestro('pane-live-impostor'),
    ]);
    markExited('pane-host');
    terminal.getPaneSessionId.mockImplementation((paneId: string) => {
      if (paneId === 'pane-real') return 'session-real';
      if (paneId === 'pane-live-impostor') return 'session-impostor';
      return null;
    });
    const { root, emit } = mountWithMissions();
    bindWorkspace();

    emit([missionA('session-real', { spaceId: 'space-a', adoptedPaneId: 'pane-host' })]);

    const host = panesById().get('pane-host');
    expect(host).toBeDefined();
    expect(host?.missionId).toBeUndefined();
    expect(host?.seatedOrchestrator).toBeUndefined();
    act(() => root.unmount());
  });

  it('só morte provada sai: boot, respawn em curso e pane sem host ficam', () => {
    useLayoutStore.getState().setPanes([
      maestro('pane-real'),
      maestro('pane-exited'),
      maestro('pane-held'),
      // Cold start: o PTY ainda não anexou.
      maestro('pane-booting'),
      // respawnMissionPaneFresh zera a sessão antes do PTY novo nascer.
      maestro('pane-respawning'),
      // Host ainda não criado (aba oculta): nada prova morte.
      maestro('pane-unknown'),
    ]);
    markExited('pane-exited');
    useSessionStateStore.getState().setPaneState('pane-booting', 'spawning');
    useSessionStateStore.getState().setPaneState('pane-respawning', 'idle');
    terminal.isSpawnHeld.mockImplementation((paneId: string) => paneId === 'pane-held');
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-real' ? 'session-real' : null,
    );
    const { root, emit } = mountWithMissions();

    emit([missionA('session-real')]);

    expect(paneIds().sort()).toEqual(
      ['pane-booting', 'pane-real', 'pane-respawning', 'pane-unknown'],
    );
    act(() => root.unmount());
  });

  it('sem líder confirmado pelo Main, nenhum Maestro morto é fechado', () => {
    useLayoutStore.getState().setPanes([
      maestro('pane-dead-1'),
      maestro('pane-dead-2', { role: 'worker', seatedOrchestrator: true }),
    ]);
    markExited('pane-dead-1', 'pane-dead-2');
    const { root, emit } = mountWithMissions();

    // A sessão durável existe, mas nenhum pane a carrega ainda (boot): não há
    // sucessor provado, então ninguém sai.
    emit([missionA('session-not-attached')]);
    expect(paneIds().sort()).toEqual(['pane-dead-1', 'pane-dead-2']);

    // Missão sem líder algum: o espelho rebaixa, mas não fecha.
    emit([missionA()]);
    expect(paneIds().sort()).toEqual(['pane-dead-1', 'pane-dead-2']);
    act(() => root.unmount());
  });

  it('o Maestro rebaixado sem líder guarda o assento e sai quando o sucessor é confirmado', () => {
    // Layout de build anterior: coroa só no `role`, sem assento gravado.
    useLayoutStore.getState().setPanes([
      maestro('pane-old'),
      maestro('pane-successor', { seatedOrchestrator: true }),
      worker('pane-worker'),
    ]);
    markExited('pane-old', 'pane-worker');
    const { root, emit } = mountWithMissions();

    // O Main ainda não confirmou ninguém: o espelho rebaixa todo mundo a worker.
    emit([missionA()]);
    const demoted = panesById();
    expect(demoted.get('pane-old')?.role).toBe('worker');
    expect(demoted.get('pane-old')?.seatedOrchestrator).toBe(true);
    // Worker de verdade não vira Maestro por ser rebaixado de novo.
    expect(demoted.get('pane-worker')?.seatedOrchestrator).toBeUndefined();

    // O sucessor anexa e o Main confirma: o rebaixado morto não escapa mais.
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-successor' ? 'session-successor' : null,
    );
    emit([missionA('session-successor')]);

    expect(maestrosOf('mission-a')).toEqual(['pane-successor']);
    expect(paneIds().sort()).toEqual(['pane-successor', 'pane-worker']);
    act(() => root.unmount());
  });

  it('restore com duplicatas: as cópias esperam a prova com o scrollback e depois só o autorizado fica', () => {
    const persisted: WorkspaceLayout = {
      root: buildGridTree([
        maestro('pane-authorized', { seatedOrchestrator: true }),
        maestro('pane-dup-1', { terminalScrollback: 'tela antiga 1', terminalScrollbackCols: 80 }),
        maestro('pane-dup-2', {
          role: 'worker',
          seatedOrchestrator: true,
          terminalScrollback: 'tela antiga 2',
          terminalScrollbackCols: 80,
        }),
        worker('pane-worker'),
        maestro('pane-vizinho', { missionId: 'mission-b' }),
      ]),
      focusedPaneId: 'pane-authorized',
    };
    // O ciclo real: gravado em JSON e relido pelo schema. Sem o campo no
    // schema o assento evaporaria no restart e o rebaixado escaparia de novo.
    const restored = workspaceLayoutSchema.parse(
      JSON.parse(JSON.stringify(persisted)) as unknown,
    );
    act(() => useLayoutStore.getState().hydrate(restored));
    // O gate segura todo agente restaurado; o Main negou as duas cópias.
    terminal.isSpawnHeld.mockImplementation(
      (paneId: string) =>
        paneId === 'pane-dup-1' || paneId === 'pane-dup-2' || paneId === 'pane-vizinho',
    );
    const { root, emit } = mountWithMissions();
    // O espelho do attach lê as missões do store: o workspace está vinculado.
    bindWorkspace();

    // Boot: o Main já tem a sessão durável, o PTY autorizado ainda não anexou.
    emit([missionA('session-authorized')]);
    const held = panesById();
    expect(held.get('pane-dup-1')?.terminalScrollback).toBe('tela antiga 1');
    expect(held.get('pane-dup-2')?.seatedOrchestrator).toBe(true);
    expect(held.get('pane-dup-2')?.terminalScrollback).toBe('tela antiga 2');

    // O autorizado anexa: o sucessor está provado e as cópias saem.
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-authorized' ? 'session-authorized' : null,
    );
    act(() => sessionChange?.('pane-authorized', 'session-authorized'));

    expect(maestrosOf('mission-a')).toEqual(['pane-authorized']);
    expect(paneIds().sort()).toEqual(['pane-authorized', 'pane-vizinho', 'pane-worker']);
    act(() => root.unmount());
  });
});
