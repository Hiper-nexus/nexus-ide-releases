/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, OrchPaneSpawnRequest } from '../../shared/orch-types';
import { buildGridTree, listPanes } from '../lib/split-tree';
import { setActiveWorkspacePath } from '../state/active-workspace';
import { useAccessStore } from '../state/access-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchBridge } from './orch-bridge';

const terminal = vi.hoisted(() => ({
  cancelPaneRecovery: vi.fn(),
  getPaneSessionId: vi.fn((_paneId: string) => null as string | null),
  isPaneSessionHealthy: vi.fn(() => true),
  markPersistedAuthorityOnSpawn: vi.fn(),
  onPaneSessionChange: vi.fn(() => vi.fn()),
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
    terminal.waitForSession.mockReset().mockResolvedValue('session-new');
  });

  it('retires the dead orchestrator pane of the same mission on a fresh orchestrator spawn', async () => {
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
      spawnHandler?.(orchestratorSpawnRequest());
    });
    await vi.waitFor(() => {
      expect(sendPaneSpawnResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, paneId: 'pane-fresh' }),
      );
    });

    // Um orquestrador por missão: o pane restaurado da sessão anterior é
    // cadáver (main já provou o exit físico antes de emitir o grant novo) e
    // precisa sair do layout na hora — não pode virar o "segundo pane travado".
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
