/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserPaneOpenRequest,
  MissionPanePresentationRequest,
  MissionPaneRecoveryRequest,
  OrchPaneSpawnRequest,
  PaneCloseRequest,
} from '../../shared/orch-types';
import { listPanes } from '../lib/split-tree';
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
  markPaneClosingDeliberately: vi.fn(),
  markPersistedAuthorityOnSpawn: vi.fn(),
  onPaneSessionChange: vi.fn(() => vi.fn()),
  paneResumedExactly: vi.fn(() => false),
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

function mount(): { root: Root; host: HTMLDivElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return { root, host };
}

function installPresentationHarness(): (
  request: MissionPanePresentationRequest,
) => void {
  let handler: ((request: MissionPanePresentationRequest) => void) | null = null;
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      mission: missionBridge(),
      orch: {
        onPaneSpawnRequest: listener(),
        onPanePresentationRequest: vi.fn(
          (next: (request: MissionPanePresentationRequest) => void) => {
            handler = next;
            return vi.fn();
          },
        ),
        onPaneRecoveryRequest: listener(),
        onBrowserOpenRequest: listener(),
        onPaneCloseRequest: listener(),
        onPaneParkRequest: listener(),
        onMissionsChanged: listener(),
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
  return (request) => {
    if (!handler) throw new Error('presentation handler is not mounted');
    handler(request);
  };
}

function presentationRequest(id: string): MissionPanePresentationRequest {
  return {
    missionId: `mission-${id}`,
    paneId: `pane-${id}`,
    sessionId: `session-${id}`,
    role: 'orchestrator',
    pane: {
      adapterId: 'codex',
      cwd: `/workspace/${id}`,
      title: 'Maestro',
      role: 'orchestrator',
    },
  };
}

describe('orchestration bridge pane recovery', () => {
  beforeEach(() => {
    // Presentations await the workspace layout hydrate in production; these
    // scenarios all model a workspace whose layout already settled.
    useLayoutStore.setState({ hydrated: true });
    useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
    terminal.getPaneSessionId.mockReset().mockReturnValue(null);
    terminal.isPaneSessionHealthy.mockReset().mockReturnValue(true);
    terminal.waitForSession.mockReset().mockResolvedValue('session-new');
  });

  it('replaces a lone bare shell while adopting an exact live main-owned session', async () => {
    let presentationHandler:
      | ((req: MissionPanePresentationRequest) => void)
      | null = null;
    terminal.waitForSession.mockResolvedValueOnce('session-live');
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-live' &&
      listPanes(useLayoutStore.getState().root).some(
        (pane) => pane.id === paneId,
      )
        ? 'session-live'
        : null,
    );
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPanePresentationRequest: vi.fn(
            (cb: (req: MissionPanePresentationRequest) => void) => {
              presentationHandler = cb;
              return vi.fn();
            },
          ),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
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
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-shell',
        pane: {
          id: 'shell-1',
          kind: 'shell',
          title: 'Shell',
          isStructuralPlaceholder: true,
        },
      },
      focusedPaneId: 'shell-1',
    });
    const mounted = mount();
    const request: MissionPanePresentationRequest = {
      missionId: 'mission-live',
      paneId: 'pane-live',
      sessionId: 'session-live',
      role: 'orchestrator',
      pane: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        cwd: '/workspace/a',
        title: 'Execução + QA · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
      },
    };

    await act(async () => {
      presentationHandler?.(request);
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith(
          'pane-live',
          75_000,
        );
      });
    });
    // Main may replay the same presentation hint until the adopted session is
    // mirrored back. The renderer must treat the exact identity idempotently.
    act(() => presentationHandler?.(request));

    expect(terminal.markPersistedAuthorityOnSpawn).toHaveBeenCalledOnce();
    expect(terminal.markPersistedAuthorityOnSpawn).toHaveBeenCalledWith(
      'pane-live',
    );
    expect(terminal.respawnMissionPaneFresh).not.toHaveBeenCalled();
    expect(terminal.cancelPaneRecovery).not.toHaveBeenCalled();
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['pane-live']);
    expect(listPanes(useLayoutStore.getState().root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'pane-live',
          missionId: 'mission-live',
          role: 'orchestrator',
        }),
      ]),
    );
    act(() => mounted.root.unmount());
  });

  it('holds a presentation until the layout hydrates, then replaces the placeholder (ghost pane race)', async () => {
    // The exact production race: the bridge mounts and Main presents mission
    // panes BEFORE the persisted workspace layout hydrates. Un-gated, the
    // later hydrate replaced the mission panes with the persisted structural
    // placeholder — the "empty pane covering a live mission" bug.
    useLayoutStore.setState({
      hydrated: false,
      root: {
        kind: 'leaf',
        id: 'leaf-boot',
        pane: {
          id: 'shell-boot',
          kind: 'shell',
          title: 'shell',
          isStructuralPlaceholder: true,
        },
      },
      focusedPaneId: 'shell-boot',
    });
    terminal.waitForSession.mockResolvedValueOnce('session-boot');
    const present = installPresentationHarness();
    const mounted = mount();

    act(() => {
      present(presentationRequest('boot'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // Not hydrated yet: the presentation must not have touched the tree.
    expect(terminal.waitForSession).not.toHaveBeenCalled();
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['shell-boot']);

    // The persisted layout lands (placeholder-only restore). Only now may the
    // presentation proceed — and it replaces the placeholder, never the
    // other way around.
    act(() => {
      useLayoutStore.getState().hydrate(null);
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith(
          'pane-boot',
          75_000,
        );
      });
    });
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['pane-boot']);
    act(() => mounted.root.unmount());
  });

  it('normalizes a restored bare shell beside the exact healthy mission pane', async () => {
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-restored' ? 'session-restored' : null,
    );
    const present = installPresentationHarness();
    useLayoutStore.getState().setPanes([
      {
        id: 'shell-restored',
        kind: 'shell',
        title: 'shell',
        isStructuralPlaceholder: true,
      },
      {
        id: 'pane-restored',
        kind: 'cli-agent',
        title: 'Maestro',
        adapterId: 'codex',
        missionId: 'mission-restored',
        role: 'orchestrator',
      },
    ]);
    const mounted = mount();

    act(() => {
      present(presentationRequest('restored'));
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['pane-restored']);
    expect(terminal.markPersistedAuthorityOnSpawn).not.toHaveBeenCalled();
    expect(terminal.waitForSession).not.toHaveBeenCalled();
    act(() => mounted.root.unmount());
  });

  it('preserves identifiable manual shells and mixed layouts', async () => {
    terminal.waitForSession
      .mockResolvedValueOnce('session-manual')
      .mockResolvedValueOnce('session-mixed');
    const present = installPresentationHarness();
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-manual-shell',
        pane: {
          id: 'shell-manual',
          kind: 'shell',
          title: 'Meu terminal',
          cwd: '/workspace/manual',
          titlePinned: true,
        },
      },
      focusedPaneId: 'shell-manual',
    });
    const mounted = mount();

    await act(async () => {
      present(presentationRequest('manual'));
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith(
          'pane-manual',
          75_000,
        );
      });
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['shell-manual', 'pane-manual']);

    act(() => {
      useLayoutStore.getState().setPanes([
        { id: 'shell-mixed', kind: 'shell', title: 'shell' },
        {
          id: 'browser-mixed',
          kind: 'browser',
          title: 'browser',
          browserUrl: 'https://example.com',
        },
      ]);
    });

    await act(async () => {
      present(presentationRequest('mixed'));
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith(
          'pane-mixed',
          75_000,
        );
      });
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['shell-mixed', 'browser-mixed', 'pane-mixed']);
    act(() => mounted.root.unmount());
  });

  it('preserves a bare shell claimed by the operator even when it is the only pane', async () => {
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'shell-operator' ? 'session-operator' : null,
    );
    terminal.waitForSession.mockResolvedValueOnce('session-mission');
    const present = installPresentationHarness();
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-operator-shell',
        pane: {
          id: 'shell-operator',
          kind: 'shell',
          title: 'shell',
        },
      },
      focusedPaneId: 'shell-operator',
    });
    const mounted = mount();

    await act(async () => {
      present(presentationRequest('mission'));
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith(
          'pane-mission',
          75_000,
        );
      });
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['shell-operator', 'pane-mission']);
    expect(terminal.getPaneSessionId('shell-operator'))
      .toBe('session-operator');
    act(() => mounted.root.unmount());
  });

  it('replaces the lone structural placeholder with the first main-owned mission pane', async () => {
    let presentationHandler:
      | ((req: MissionPanePresentationRequest) => void)
      | null = null;
    terminal.waitForSession.mockResolvedValueOnce('session-first');
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPanePresentationRequest: vi.fn(
            (cb: (req: MissionPanePresentationRequest) => void) => {
              presentationHandler = cb;
              return vi.fn();
            },
          ),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
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
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-first-placeholder',
        pane: {
          id: 'shell-first-placeholder',
          kind: 'shell',
          title: 'Shell',
          isStructuralPlaceholder: true,
        },
      },
      focusedPaneId: 'shell-first-placeholder',
    });
    const mounted = mount();

    await act(async () => {
      presentationHandler?.({
        missionId: 'mission-first',
        paneId: 'pane-first',
        sessionId: 'session-first',
        role: 'orchestrator',
        pane: {
          adapterId: 'codex',
          model: 'gpt-5.6-sol',
          cwd: '/workspace/first',
          title: 'Maestro',
          agentName: 'Maestro',
          role: 'orchestrator',
        },
      });
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith(
          'pane-first',
          75_000,
        );
      });
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['pane-first']);
    act(() => mounted.root.unmount());
  });

  it('spawn channel replaces the lone structural placeholder', async () => {
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
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-spawn-placeholder',
        pane: {
          id: 'shell-spawn-placeholder',
          kind: 'shell',
          title: 'Shell',
          isStructuralPlaceholder: true,
        },
      },
      focusedPaneId: 'shell-spawn-placeholder',
    });
    const mounted = mount();

    act(() => {
      spawnHandler?.({
        requestId: 'orchspawn-launch',
        paneId: 'pane-launch',
        adapterId: 'claude',
        missionId: 'mission-launch',
        role: 'orchestrator',
        resume: false,
        resumeLatestOnly: false,
        restorePersistedAuthority: false,
      });
    });
    await vi.waitFor(() => {
      expect(sendPaneSpawnResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, paneId: 'pane-launch' }),
      );
    });

    // O placeholder vazio não sobra como tile: o primeiro pane real da
    // orquestração o substitui (mesma regra do canal de apresentação).
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['pane-launch']);
    act(() => mounted.root.unmount());
  });

  it('re-presents the same live pane after switching A to B and back to A', async () => {
    let presentationHandler:
      | ((req: MissionPanePresentationRequest) => void)
      | null = null;
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPanePresentationRequest: vi.fn(
            (cb: (req: MissionPanePresentationRequest) => void) => {
              presentationHandler = cb;
              return vi.fn();
            },
          ),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
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
    const request: MissionPanePresentationRequest = {
      missionId: 'mission-returning',
      paneId: 'pane-returning',
      sessionId: 'session-returning',
      role: 'orchestrator',
      pane: {
        adapterId: 'codex',
        cwd: '/workspace/a',
        title: 'Returning orchestrator',
        role: 'orchestrator',
      },
    };
    terminal.waitForSession.mockResolvedValue('session-returning');
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === request.paneId &&
      listPanes(useLayoutStore.getState().root).some(
        (pane) => pane.id === request.paneId,
      )
        ? request.sessionId
        : null,
    );
    setActiveWorkspacePath('/workspace/a');
    useOrchStore.setState({ workspaceEpoch: 10 });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-a',
        pane: { id: 'shell-a', kind: 'shell', title: 'A' },
      },
      focusedPaneId: 'shell-a',
    });
    const mounted = mount();

    act(() => presentationHandler?.(request));
    await vi.waitFor(() => {
      expect(terminal.markPersistedAuthorityOnSpawn).toHaveBeenCalledTimes(1);
    });

    setActiveWorkspacePath('/workspace/b');
    useOrchStore.setState({ workspaceEpoch: 11 });
    act(() => {
      useLayoutStore.getState().setPanes([
        { id: 'shell-b', kind: 'shell', title: 'B' },
      ]);
    });
    setActiveWorkspacePath('/workspace/a');
    useOrchStore.setState({ workspaceEpoch: 12 });
    act(() => {
      useLayoutStore.getState().setPanes([
        { id: 'shell-a-returned', kind: 'shell', title: 'A again' },
      ]);
      presentationHandler?.(request);
    });

    await vi.waitFor(() => {
      expect(terminal.markPersistedAuthorityOnSpawn).toHaveBeenCalledTimes(2);
    });
    expect(listPanes(useLayoutStore.getState().root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: request.paneId,
          missionId: request.missionId,
        }),
      ]),
    );
    act(() => mounted.root.unmount());
  });

  it('does not let a late A presentation flight poison the next A epoch', async () => {
    let presentationHandler:
      | ((req: MissionPanePresentationRequest) => void)
      | null = null;
    let settleA: ((sessionId: string | null) => void) | null = null;
    terminal.waitForSession
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleA = resolve;
          }),
      )
      .mockResolvedValueOnce('session-flight');
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPanePresentationRequest: vi.fn(
            (cb: (req: MissionPanePresentationRequest) => void) => {
              presentationHandler = cb;
              return vi.fn();
            },
          ),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
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
    const request: MissionPanePresentationRequest = {
      missionId: 'mission-flight',
      paneId: 'pane-flight',
      sessionId: 'session-flight',
      role: 'worker',
      pane: {
        adapterId: 'codex',
        cwd: '/workspace/a',
        title: 'Worker flight',
        role: 'worker',
      },
    };
    setActiveWorkspacePath('/workspace/a');
    useOrchStore.setState({ workspaceEpoch: 20 });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-flight-a',
        pane: { id: 'shell-flight-a', kind: 'shell', title: 'A' },
      },
      focusedPaneId: 'shell-flight-a',
    });
    const mounted = mount();

    act(() => presentationHandler?.(request));
    await vi.waitFor(() => expect(settleA).not.toBeNull());
    setActiveWorkspacePath('/workspace/b');
    useOrchStore.setState({ workspaceEpoch: 21 });
    act(() => {
      useLayoutStore.getState().setPanes([
        { id: 'shell-flight-b', kind: 'shell', title: 'B' },
      ]);
      settleA?.(request.sessionId);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['shell-flight-b']);

    setActiveWorkspacePath('/workspace/a');
    useOrchStore.setState({ workspaceEpoch: 22 });
    act(() => {
      useLayoutStore.getState().setPanes([
        { id: 'shell-flight-a-returned', kind: 'shell', title: 'A again' },
      ]);
      presentationHandler?.(request);
    });
    await vi.waitFor(() => {
      expect(terminal.markPersistedAuthorityOnSpawn).toHaveBeenCalledTimes(2);
    });
    expect(listPanes(useLayoutStore.getState().root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: request.paneId }),
      ]),
    );
    act(() => mounted.root.unmount());
  });

  it('respawns the stable pane fresh, rebinds it and acknowledges a new session', async () => {
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    const rebindMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: vi.fn(
            (cb: (req: MissionPaneRecoveryRequest) => void) => {
              recoveryHandler = cb;
              return vi.fn();
            },
          ),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult,
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator,
        },
      },
    });
    const pane = {
      id: 'pane-orch',
      kind: 'cli-agent' as const,
      title: 'Orchestrator',
      adapterId: 'codex',
        role: 'orchestrator' as const,
    };
    useLayoutStore.setState({
      root: { kind: 'leaf', id: 'leaf-orch', pane },
      focusedPaneId: 'pane-orch',
    });
    const mounted = mount();

    await act(async () => {
      recoveryHandler?.({
        requestId: 'recovery-a',
        missionId: 'mission-a',
        paneId: 'pane-orch',
        expectedSessionId: 'session-old',
        role: 'orchestrator',
        pane: {
          adapterId: 'codex',
          title: 'Orchestrator',
          role: 'orchestrator',
        },
        recap: 'Continue safely.',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(terminal.respawnMissionPaneFresh).toHaveBeenCalledWith(
      pane,
      'session-old',
      75_000,
      'recovery-a',
      false,
    );
    expect(rebindMissionOrchestrator).toHaveBeenCalledWith(
      'mission-a',
      'session-new',
    );
    expect(terminal.submitPromptToPaneConfirmed).toHaveBeenCalledWith(
      'pane-orch',
      'Continue safely.',
      'session-new',
    );
    expect(terminal.submitPromptToPaneConfirmed.mock.invocationCallOrder[0])
      .toBeLessThan(rebindMissionOrchestrator.mock.invocationCallOrder[0]);
    expect(sendPaneRecoveryResult).toHaveBeenCalledWith({
      requestId: 'recovery-a',
      ok: true,
      paneId: 'pane-orch',
      sessionId: 'session-new',
    });
    act(() => mounted.root.unmount());
  });

  it('F-995: a conta selada pelo Main na recuperação vence o espelho do layout (troca por limite)', async () => {
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    const rebindMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: vi.fn(
            (cb: (req: MissionPaneRecoveryRequest) => void) => {
              recoveryHandler = cb;
              return vi.fn();
            },
          ),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult,
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator,
        },
      },
    });
    const pane = {
      id: 'pane-orch',
      kind: 'cli-agent' as const,
      title: 'Orchestrator',
      adapterId: 'codex',
      accountId: 'acct-esgotada',
        role: 'orchestrator' as const,
    };
    useLayoutStore.setState({
      root: { kind: 'leaf', id: 'leaf-orch', pane },
      focusedPaneId: 'pane-orch',
    });
    const mounted = mount();

    await act(async () => {
      recoveryHandler?.({
        requestId: 'recovery-f969',
        missionId: 'mission-a',
        paneId: 'pane-orch',
        expectedSessionId: 'session-old',
        role: 'orchestrator',
        pane: {
          adapterId: 'codex',
          accountId: 'acct-com-folga',
          title: 'Orchestrator',
          role: 'orchestrator',
        },
        recap: 'Continue safely.',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(terminal.respawnMissionPaneFresh).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pane-orch', accountId: 'acct-com-folga' }),
      'session-old',
      75_000,
      'recovery-f969',
      false,
    );
    expect(
      listPanes(useLayoutStore.getState().root).find((entry) => entry.id === 'pane-orch')?.accountId,
    ).toBe('acct-com-folga');
    expect(rebindMissionOrchestrator).toHaveBeenCalledWith(
      'mission-a',
      'session-new',
    );
    expect(terminal.submitPromptToPaneConfirmed).toHaveBeenCalledWith(
      'pane-orch',
      'Continue safely.',
      'session-new',
    );
    expect(terminal.submitPromptToPaneConfirmed.mock.invocationCallOrder[0])
      .toBeLessThan(rebindMissionOrchestrator.mock.invocationCallOrder[0]);
    expect(sendPaneRecoveryResult).toHaveBeenCalledWith({
      requestId: 'recovery-f969',
      ok: true,
      paneId: 'pane-orch',
      sessionId: 'session-new',
    });
    act(() => mounted.root.unmount());
  });

  it.each([
    ['retomada exata recebe só a nota', true, 'NOTA: mesma conversa'],
    ['sem retomada exata recebe o pacote inteiro', false, 'PACOTE completo'],
  ])('F-1473: troca de conta com histórico compartilhado — %s', async (_label, exact, submitted) => {
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    const rebindMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    terminal.paneResumedExactly.mockReturnValue(exact);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: vi.fn(
            (cb: (req: MissionPaneRecoveryRequest) => void) => {
              recoveryHandler = cb;
              return vi.fn();
            },
          ),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult,
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator,
        },
      },
    });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-orch',
        pane: {
          id: 'pane-orch',
          kind: 'cli-agent' as const,
          title: 'Orchestrator',
          adapterId: 'claude',
          accountId: 'acct-a',
          role: 'orchestrator' as const,
        },
      },
      focusedPaneId: 'pane-orch',
    });
    const mounted = mount();

    await act(async () => {
      recoveryHandler?.({
        requestId: `recovery-1473-${exact}`,
        missionId: 'mission-a',
        paneId: 'pane-orch',
        expectedSessionId: 'session-old',
        role: 'orchestrator',
        pane: { adapterId: 'claude', accountId: 'acct-b', title: 'Orchestrator', role: 'orchestrator' },
        recap: 'PACOTE completo',
        resumeNote: 'NOTA: mesma conversa',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(terminal.respawnMissionPaneFresh).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pane-orch', accountId: 'acct-b' }),
      'session-old',
      75_000,
      `recovery-1473-${exact}`,
      true,
    );
    expect(terminal.paneResumedExactly).toHaveBeenCalledWith('pane-orch', 'session-new');
    expect(terminal.submitPromptToPaneConfirmed).toHaveBeenCalledTimes(1);
    expect(terminal.submitPromptToPaneConfirmed).toHaveBeenCalledWith('pane-orch', submitted, 'session-new');
    expect(sendPaneRecoveryResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true, sessionId: 'session-new' }));
    terminal.paneResumedExactly.mockReturnValue(false);
    act(() => mounted.root.unmount());
  });

  it('cancels a late missing-pane spawn when it never becomes healthy', async () => {
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    terminal.waitForHealthyPaneSession.mockResolvedValueOnce(null);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: vi.fn(
            (cb: (req: MissionPaneRecoveryRequest) => void) => {
              recoveryHandler = cb;
              return vi.fn();
            },
          ),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult,
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
      },
    });
    const unrelated = {
      id: 'pane-shell',
      kind: 'shell' as const,
      title: 'Shell',
    };
    useLayoutStore.setState({
      root: { kind: 'leaf', id: 'leaf-shell', pane: unrelated },
      focusedPaneId: 'pane-shell',
    });
    const mounted = mount();

    act(() => {
      recoveryHandler?.({
        requestId: 'recovery-missing',
        missionId: 'mission-a',
        paneId: 'pane-missing',
        role: 'worker',
        pane: {
          adapterId: 'codex',
          title: 'Missing worker',
          role: 'worker',
        },
        recap: 'Continue safely.',
      });
    });
    await vi.waitFor(() => {
      expect(sendPaneRecoveryResult).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'recovery-missing',
        ok: false,
      }));
    });

    expect(terminal.cancelPaneRecovery).toHaveBeenCalledWith(
      'pane-missing',
      undefined,
    );
    act(() => mounted.root.unmount());
  });

  it('a recovery de A nunca monta o pane de missão na árvore de B', async () => {
    // Campo 23/09: a recovery espera o layout assentar. Se o operador troca de
    // projeto nesse meio-tempo, o layout que assenta é o de B — e o pane da
    // missão de A caía no grid de B (e na gravação seguinte, no layout de B).
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: vi.fn(
            (cb: (req: MissionPaneRecoveryRequest) => void) => {
              recoveryHandler = cb;
              return vi.fn();
            },
          ),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult,
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
      },
    });
    setActiveWorkspacePath('/workspace/a');
    useOrchStore.setState({ workspaceEpoch: 20 });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-a',
        pane: { id: 'shell-a', kind: 'shell', title: 'A' },
      },
      focusedPaneId: 'shell-a',
      // Uma leitura de layout em voo: a recovery fica parada no settle.
      hydrated: false,
    });
    const mounted = mount();

    act(() => {
      recoveryHandler?.({
        requestId: 'recovery-cross-workspace',
        missionId: 'mission-a',
        paneId: 'pane-worker-a',
        role: 'worker',
        pane: { adapterId: 'codex', title: 'Worker de A', role: 'worker' },
        recap: 'Continue.',
      });
    });

    setActiveWorkspacePath('/workspace/b');
    useOrchStore.setState({ workspaceEpoch: 21 });
    act(() => {
      useLayoutStore.setState({
        root: {
          kind: 'leaf',
          id: 'leaf-b',
          pane: { id: 'shell-b', kind: 'shell', title: 'B' },
        },
        focusedPaneId: 'shell-b',
        hydrated: true,
      });
    });

    await vi.waitFor(() => {
      expect(sendPaneRecoveryResult).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'recovery-cross-workspace', ok: false }),
      );
    });
    expect(
      listPanes(useLayoutStore.getState().root).map((pane) => pane.id),
    ).toEqual(['shell-b']);
    expect(terminal.markPersistedAuthorityOnSpawn).not.toHaveBeenCalled();
    act(() => mounted.root.unmount());
  });

  it('does not cancel a newer session when a stale recovery loses the CAS race', async () => {
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    terminal.respawnMissionPaneFresh.mockRejectedValueOnce(
      new Error('mission pane session changed before recovery'),
    );
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: vi.fn(
            (cb: (req: MissionPaneRecoveryRequest) => void) => {
              recoveryHandler = cb;
              return vi.fn();
            },
          ),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult,
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
      },
    });
    const pane = {
      id: 'pane-orch',
      kind: 'cli-agent' as const,
      title: 'Orchestrator',
      adapterId: 'codex',
      role: 'orchestrator' as const,
    };
    useLayoutStore.setState({
      root: { kind: 'leaf', id: 'leaf-orch', pane },
      focusedPaneId: 'pane-orch',
    });
    const mounted = mount();

    act(() => {
      recoveryHandler?.({
        requestId: 'recovery-stale',
        missionId: 'mission-a',
        paneId: 'pane-orch',
        expectedSessionId: 'session-old',
        role: 'orchestrator',
        pane: {
          adapterId: 'codex',
          title: 'Orchestrator',
          role: 'orchestrator',
        },
        recap: 'Continue safely.',
      });
    });
    await vi.waitFor(() => {
      expect(sendPaneRecoveryResult).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'recovery-stale',
        ok: false,
      }));
    });

    expect(terminal.cancelPaneRecovery).not.toHaveBeenCalled();
    act(() => mounted.root.unmount());
  });

  it('does not rebind a replacement session when its recap was not delivered', async () => {
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    const rebindMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    terminal.submitPromptToPaneConfirmed.mockResolvedValueOnce(false);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: vi.fn(
            (cb: (req: MissionPaneRecoveryRequest) => void) => {
              recoveryHandler = cb;
              return vi.fn();
            },
          ),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult,
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator,
        },
      },
    });
    const pane = {
      id: 'pane-orch',
      kind: 'cli-agent' as const,
      title: 'Orchestrator',
      adapterId: 'codex',
      role: 'orchestrator' as const,
    };
    useLayoutStore.setState({
      root: { kind: 'leaf', id: 'leaf-orch', pane },
      focusedPaneId: 'pane-orch',
    });
    const mounted = mount();

    act(() => {
      recoveryHandler?.({
        requestId: 'recovery-recap-failed',
        missionId: 'mission-a',
        paneId: 'pane-orch',
        expectedSessionId: 'session-old',
        role: 'orchestrator',
        pane: {
          adapterId: 'codex',
          title: 'Orchestrator',
          role: 'orchestrator',
        },
        recap: 'Continue safely.',
      });
    });
    await vi.waitFor(() => {
      expect(sendPaneRecoveryResult).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'recovery-recap-failed',
        ok: false,
      }));
    });

    expect(rebindMissionOrchestrator).not.toHaveBeenCalled();
    expect(terminal.cancelPaneRecovery).toHaveBeenCalledWith(
      'pane-orch',
      'session-new',
    );
    act(() => mounted.root.unmount());
  });

  it('closes browser cleanup only when pane id and request seal both match', () => {
    let closeHandler: ((request: PaneCloseRequest) => void) | null = null;
    const syncPanes = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: vi.fn(
            (cb: (request: PaneCloseRequest) => void) => {
              closeHandler = cb;
              return vi.fn();
            },
          ),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes,
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
      },
    });
    const pane = {
      id: 'browser-shared',
      kind: 'browser' as const,
      title: 'Pre-existing browser',
      browserOpenRequestId: 'browseropen-owner',
    };
    useLayoutStore.setState({
      root: { kind: 'leaf', id: 'leaf-browser', pane },
      focusedPaneId: pane.id,
    });
    const mounted = mount();
    syncPanes.mockClear();

    act(() => {
      closeHandler?.({
        paneId: pane.id,
        requestId: 'browseropen-foreign',
      });
    });
    expect(
      listPanes(useLayoutStore.getState().root).some(
        (candidate) => candidate.id === pane.id,
      ),
    ).toBe(true);
    expect(syncPanes).not.toHaveBeenCalled();

    act(() => {
      closeHandler?.({
        paneId: pane.id,
        requestId: 'browseropen-owner',
      });
    });
    expect(
      listPanes(useLayoutStore.getState().root).some(
        (candidate) => candidate.id === pane.id,
      ),
    ).toBe(false);
    expect(syncPanes).toHaveBeenCalled();
    act(() => mounted.root.unmount());
  });

  it('persists the main browser-open request seal on the created pane', async () => {
    let browserHandler: ((request: BrowserPaneOpenRequest) => void) | null = null;
    const sendBrowserOpenResult = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: vi.fn(
            (cb: (request: BrowserPaneOpenRequest) => void) => {
              browserHandler = cb;
              return vi.fn();
            },
          ),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult,
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
      },
    });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-shell',
        pane: { id: 'pane-shell', kind: 'shell', title: 'Shell' },
      },
      focusedPaneId: 'pane-shell',
    });
    const mounted = mount();

    await act(async () => {
      browserHandler?.({
        requestId: 'browseropen-created',
        paneId: 'browser-created',
        url: 'https://example.com',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const created = listPanes(useLayoutStore.getState().root).find(
      (pane) => pane.id === 'browser-created',
    );
    expect(created).toMatchObject({
      kind: 'browser',
      browserOpenRequestId: 'browseropen-created',
    });
    expect(sendBrowserOpenResult).toHaveBeenCalledWith({
      requestId: 'browseropen-created',
      ok: true,
      paneId: 'browser-created',
    });
    act(() => mounted.root.unmount());
  });

  it('reports a pending pane when session materialization times out without cleanup', async () => {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    const sendPaneSpawnResult = vi.fn();
    const syncPanes = vi.fn();
    terminal.waitForSession.mockResolvedValueOnce(null);
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
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes,
          sendPaneSpawnResult,
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
      },
    });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-shell',
        pane: { id: 'pane-shell', kind: 'shell', title: 'Shell' },
      },
      focusedPaneId: 'pane-shell',
    });
    const mounted = mount();
    const request: OrchPaneSpawnRequest = {
      requestId: 'orchspawn-failed',
      paneId: 'pane-failed',
      adapterId: 'codex',
      missionId: 'mission-a',
      role: 'worker',
      allowPending: true,
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
    };

    act(() => spawnHandler?.(request));
    await vi.waitFor(() => {
      expect(sendPaneSpawnResult).toHaveBeenCalledWith({
        requestId: request.requestId,
        ok: true,
        paneId: request.paneId,
        sessionId: null,
        pending: true,
      });
    });

    expect(sendPaneSpawnResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    );
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toContain(request.paneId);
    expect(syncPanes).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ paneId: request.paneId })]),
    );
    act(() => mounted.root.unmount());
  });

  it('removes and synchronizes an orchestration pane when session materialization throws', async () => {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    const sendPaneSpawnResult = vi.fn();
    const syncPanes = vi.fn();
    terminal.waitForSession.mockRejectedValueOnce(
      new Error('session materialization crashed'),
    );
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
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes,
          sendPaneSpawnResult,
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
      },
    });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-shell',
        pane: { id: 'pane-shell', kind: 'shell', title: 'Shell' },
      },
      focusedPaneId: 'pane-shell',
    });
    const mounted = mount();
    const request: OrchPaneSpawnRequest = {
      requestId: 'orchspawn-threw',
      paneId: 'pane-threw',
      adapterId: 'codex',
      missionId: 'mission-a',
      role: 'worker',
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
    };

    act(() => spawnHandler?.(request));
    await vi.waitFor(() => {
      expect(sendPaneSpawnResult).toHaveBeenCalledWith({
        requestId: request.requestId,
        ok: false,
        error: 'session materialization crashed',
      });
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['pane-shell']);
    expect(syncPanes).toHaveBeenLastCalledWith([
      expect.objectContaining({ paneId: 'pane-shell' }),
    ]);
    act(() => mounted.root.unmount());
  });

  it('honors a sealed orchestration close and ignores a foreign request', () => {
    let closeHandler: ((request: PaneCloseRequest) => void) | null = null;
    const syncPanes = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: vi.fn(
            (cb: (request: PaneCloseRequest) => void) => {
              closeHandler = cb;
              return vi.fn();
            },
          ),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes,
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
          rebindMissionOrchestrator: vi.fn(async () => ({ ok: true })),
        },
      },
    });
    const panes = [
      { id: 'pane-shell', kind: 'shell' as const, title: 'Shell' },
      {
        id: 'pane-worker',
        kind: 'cli-agent' as const,
        title: 'Worker',
        adapterId: 'codex',
        orchRequestId: 'orchspawn-owner',
      },
    ];
    useLayoutStore.getState().setPanes(panes);
    const mounted = mount();
    syncPanes.mockClear();

    act(() => {
      closeHandler?.({
        paneId: 'pane-worker',
        requestId: 'orchspawn-foreign',
      });
    });
    expect(listPanes(useLayoutStore.getState().root)).toHaveLength(2);
    expect(syncPanes).not.toHaveBeenCalled();

    act(() => {
      closeHandler?.({
        paneId: 'pane-worker',
        requestId: 'orchspawn-owner',
      });
    });
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['pane-shell']);
    expect(syncPanes).toHaveBeenCalled();
    act(() => mounted.root.unmount());
  });

  it('fecha pedido por sessão só se o terminal ainda tem a sessão esperada', () => {
    let closeHandler: ((request: PaneCloseRequest) => void) | null = null;
    const syncPanes = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: vi.fn((cb: (request: PaneCloseRequest) => void) => {
            closeHandler = cb;
            return vi.fn();
          }),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes,
        },
      },
    });
    const pane = { id: 'pane-reused', kind: 'cli-agent' as const, title: 'Helper', adapterId: 'codex' };
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'leaf-helper', pane }, focusedPaneId: pane.id });
    terminal.getPaneSessionId.mockReturnValue('session-new');
    const mounted = mount();
    syncPanes.mockClear();

    act(() => closeHandler?.({ paneId: pane.id, expectedSessionId: 'session-old' }));
    expect(listPanes(useLayoutStore.getState().root).some((candidate) => candidate.id === pane.id)).toBe(true);
    expect(syncPanes).not.toHaveBeenCalled();

    act(() => closeHandler?.({ paneId: pane.id, expectedSessionId: 'session-new' }));
    expect(listPanes(useLayoutStore.getState().root).some((candidate) => candidate.id === pane.id)).toBe(false);
    act(() => mounted.root.unmount());
  });

  it('fecha o helper cuja sessão esperada já saiu (autoCloseOnHandoff)', () => {
    // O main mata a sessão e só então pede o fechamento; quando o pedido
    // chega, o exit já zerou o host. Antes disso o pedido era ignorado e o
    // helper que entregou ficava aberto em "process exited".
    let closeHandler: ((request: PaneCloseRequest) => void) | null = null;
    const syncPanes = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: vi.fn((cb: (request: PaneCloseRequest) => void) => {
            closeHandler = cb;
            return vi.fn();
          }),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes,
        },
      },
    });
    const pane = { id: 'pane-helper-done', kind: 'cli-agent' as const, title: 'Helper', adapterId: 'codex' };
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'leaf-helper-done', pane }, focusedPaneId: pane.id });
    terminal.getPaneSessionId.mockReturnValue(null);
    const mounted = mount();

    act(() => closeHandler?.({ paneId: pane.id, expectedSessionId: 'session-delivered' }));
    expect(listPanes(useLayoutStore.getState().root).some((candidate) => candidate.id === pane.id)).toBe(false);
    expect(syncPanes).toHaveBeenCalled();
    act(() => mounted.root.unmount());
  });

  it('aviso de fechamento marca a sessão e NÃO fecha o pane antes do exit', () => {
    let closeHandler: ((request: PaneCloseRequest) => void) | null = null;
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: vi.fn((cb: (request: PaneCloseRequest) => void) => {
            closeHandler = cb;
            return vi.fn();
          }),
          onPaneParkRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
        },
      },
    });
    const pane = { id: 'pane-helper-closing', kind: 'cli-agent' as const, title: 'Helper', adapterId: 'codex' };
    useLayoutStore.setState({ root: { kind: 'leaf', id: 'leaf-helper-closing', pane }, focusedPaneId: pane.id });
    terminal.getPaneSessionId.mockReturnValue('session-closing');
    const mounted = mount();

    act(() => closeHandler?.({ paneId: pane.id, closingSessionId: 'session-closing' }));
    expect(terminal.markPaneClosingDeliberately).toHaveBeenCalledWith(pane.id, 'session-closing');
    expect(listPanes(useLayoutStore.getState().root).some((candidate) => candidate.id === pane.id)).toBe(true);
    act(() => mounted.root.unmount());
  });
});

// ── F-1475: a missão mostra um Maestro só, sem panes mortos acumulados ──────

describe('F-1475 — um Maestro por missão na tela', () => {
  beforeEach(() => {
    useLayoutStore.setState({ hydrated: true });
    useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
    useSessionStateStore.setState({ paneStates: new Map() });
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
    useSessionStateStore.setState({ paneStates: new Map() });
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
    terminal.getPaneSessionId.mockReset().mockReturnValue(null);
    terminal.isPaneSessionHealthy.mockReset().mockReturnValue(true);
    terminal.isSpawnHeld.mockReset().mockReturnValue(false);
    terminal.waitForSession.mockReset().mockResolvedValue('session-new');
  });

  /** Morte física provada: o exit do PTY chegou a este renderer. */
  function markExited(...ids: string[]): void {
    for (const id of ids) useSessionStateStore.getState().setPaneState(id, 'exited');
  }

  function paneIds(): string[] {
    return listPanes(useLayoutStore.getState().root).map((pane) => pane.id);
  }

  /** O que o operador lê como Maestro: o papel atual OU o assento selado pelo Main. */
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
   * O print do cliente (0.76.250): três "Claude · Coordenar e revisar" mortos
   * da mesma missão ao lado do que estava subindo. Um deles já foi rebaixado
   * a worker pelo espelho de liderança — o papel mente, o assento selado não.
   */
  function seedDeadMaestros(): void {
    useLayoutStore.getState().setPanes([
      { id: 'pane-dead-1', kind: 'cli-agent', title: 'Claude · Coordenar e revisar', adapterId: 'claude', missionId: 'mission-a', role: 'orchestrator' },
      { id: 'pane-dead-2', kind: 'cli-agent', title: 'Claude · Coordenar e revisar', adapterId: 'claude', missionId: 'mission-a', role: 'orchestrator', seatedOrchestrator: true },
      { id: 'pane-dead-3', kind: 'cli-agent', title: 'Claude · Coordenar e revisar', adapterId: 'claude', missionId: 'mission-a', role: 'worker', seatedOrchestrator: true },
      { id: 'pane-worker', kind: 'cli-agent', title: 'Worker', adapterId: 'codex', missionId: 'mission-a', role: 'worker' },
      { id: 'pane-neighbour', kind: 'cli-agent', title: 'Outra missão', adapterId: 'claude', missionId: 'mission-b', role: 'orchestrator' },
    ]);
    markExited('pane-dead-1', 'pane-dead-2', 'pane-dead-3', 'pane-worker', 'pane-neighbour');
  }

  function maestroPresentation(): MissionPanePresentationRequest {
    return {
      missionId: 'mission-a',
      paneId: 'pane-a',
      sessionId: 'session-a',
      role: 'orchestrator',
      pane: {
        adapterId: 'claude',
        cwd: '/workspace/a',
        title: 'Claude · Coordenar e revisar',
        role: 'orchestrator',
      },
    };
  }

  it('a apresentação Main-owned do Maestro aposenta os Maestros mortos da mesma missão', async () => {
    terminal.waitForSession.mockResolvedValueOnce('session-a');
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-a' && paneIds().includes(paneId) ? 'session-a' : null,
    );
    const present = installPresentationHarness();
    seedDeadMaestros();
    const mounted = mount();

    await act(async () => {
      present(maestroPresentation());
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith('pane-a', 75_000);
      });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(maestrosOf('mission-a')).toEqual(['pane-a']);
      });
    });

    // Worker da missão e Maestro de OUTRA missão não são cadáveres desta troca.
    expect(paneIds().sort()).toEqual(['pane-a', 'pane-neighbour', 'pane-worker']);
    // O pane apresentado carrega o assento: um rebaixamento futuro não o esconde.
    expect(
      listPanes(useLayoutStore.getState().root).find((pane) => pane.id === 'pane-a')
        ?.seatedOrchestrator,
    ).toBe(true);
    act(() => mounted.root.unmount());
  });

  it('sem o sucessor anexado, nenhum Maestro morto sai (nada se perde sem prova)', async () => {
    terminal.waitForSession.mockResolvedValueOnce(null);
    const present = installPresentationHarness();
    seedDeadMaestros();
    const mounted = mount();

    await act(async () => {
      present(maestroPresentation());
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith('pane-a', 75_000);
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(paneIds()).toEqual(
      expect.arrayContaining(['pane-dead-1', 'pane-dead-2', 'pane-dead-3', 'pane-worker', 'pane-neighbour']),
    );
    act(() => mounted.root.unmount());
  });

  function installSpawnHarness(): {
    readonly spawn: (request: OrchPaneSpawnRequest) => void;
    readonly exit: (
      sessionId: string,
      event: { exitCode: number; terminationOrigin?: string },
    ) => void;
    readonly sendPaneSpawnResult: ReturnType<typeof vi.fn>;
  } {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    const exitHandlers = new Map<
      string,
      (event: { exitCode: number; terminationOrigin?: string }) => void
    >();
    const sendPaneSpawnResult = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: vi.fn((cb: (request: OrchPaneSpawnRequest) => void) => {
            spawnHandler = cb;
            return vi.fn();
          }),
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
        pty: {
          onExit: vi.fn(
            (
              sessionId: string,
              cb: (event: { exitCode: number; terminationOrigin?: string }) => void,
            ) => {
              exitHandlers.set(sessionId, cb);
              return vi.fn(() => exitHandlers.delete(sessionId));
            },
          ),
        },
      },
    });
    return {
      spawn: (request) => spawnHandler?.(request),
      exit: (sessionId, event) => exitHandlers.get(sessionId)?.(event),
      sendPaneSpawnResult,
    };
  }

  function attemptRequest(): OrchPaneSpawnRequest {
    return {
      requestId: 'orchspawn-attempt',
      paneId: 'pane-attempt',
      adapterId: 'claude',
      missionId: 'mission-a',
      role: 'orchestrator',
      title: 'Claude · Coordenar e revisar',
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
    };
  }

  it('bind recusado pelo Main: o pane da tentativa sai e o Maestro antigo fica com o histórico', async () => {
    terminal.waitForSession.mockResolvedValueOnce('session-attempt');
    const harness = installSpawnHarness();
    useLayoutStore.getState().setPanes([
      { id: 'pane-shell', kind: 'shell', title: 'Shell' },
      {
        id: 'pane-old',
        kind: 'cli-agent',
        title: 'Claude · Coordenar e revisar',
        adapterId: 'claude',
        missionId: 'mission-a',
        role: 'orchestrator',
        seatedOrchestrator: true,
        terminalScrollback: 'última tela do Maestro',
        terminalScrollbackCols: 80,
      },
    ]);
    markExited('pane-old');
    const mounted = mount();

    act(() => harness.spawn(attemptRequest()));
    await vi.waitFor(() => {
      expect(harness.sendPaneSpawnResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, paneId: 'pane-attempt', sessionId: 'session-attempt' }),
      );
    });
    expect(paneIds()).toContain('pane-attempt');
    // O grant não é sucessor provado: o Maestro antigo não sai antes do bind.
    expect(paneIds()).toContain('pane-old');

    // O fast-lane encerra a sessão com a origem rotulada e só depois devolve o
    // erro: a folha da tentativa não pode virar o próximo "processo caiu".
    act(() =>
      harness.exit('session-attempt', {
        exitCode: 1,
        terminationOrigin: 'fast-lane:spawn-binding-failed',
      }),
    );

    // A missão nunca fica sem Maestro na tela nem perde o scrollback dele.
    expect(paneIds()).toEqual(['pane-shell', 'pane-old']);
    expect(
      listPanes(useLayoutStore.getState().root).find((pane) => pane.id === 'pane-old')
        ?.terminalScrollback,
    ).toBe('última tela do Maestro');
    act(() => mounted.root.unmount());
  });

  it('queda sem origem rotulada não fecha o pane da tentativa (o histórico fica)', async () => {
    terminal.waitForSession.mockResolvedValueOnce('session-attempt');
    const harness = installSpawnHarness();
    useLayoutStore.setState({
      root: { kind: 'leaf', id: 'leaf-shell', pane: { id: 'pane-shell', kind: 'shell', title: 'Shell' } },
      focusedPaneId: 'pane-shell',
    });
    const mounted = mount();

    act(() => harness.spawn(attemptRequest()));
    await vi.waitFor(() => {
      expect(harness.sendPaneSpawnResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, paneId: 'pane-attempt' }),
      );
    });
    act(() => harness.exit('session-attempt', { exitCode: 129 }));

    expect(paneIds()).toEqual(['pane-shell', 'pane-attempt']);
    act(() => mounted.root.unmount());
  });
});
