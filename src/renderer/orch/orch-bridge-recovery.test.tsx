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
import { useHomeStore } from '../state/home-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
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
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
    useHomeStore.setState({ visible: false });
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

  it('normalizes a restored bare shell beside the exact healthy mission pane', async () => {
    terminal.getPaneSessionId.mockImplementation((paneId: string) =>
      paneId === 'pane-restored' ? 'session-restored' : null,
    );
    const present = installPresentationHarness();
    useHomeStore.setState({ visible: false });
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
    useHomeStore.setState({ visible: false });
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
    useHomeStore.setState({ visible: false });
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

  it('replaces the Home placeholder shell with the first main-owned mission pane', async () => {
    let presentationHandler:
      | ((req: MissionPanePresentationRequest) => void)
      | null = null;
    terminal.waitForSession.mockResolvedValueOnce('session-home');
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
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
    useHomeStore.setState({ visible: true });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-home-placeholder',
        pane: {
          id: 'shell-home-placeholder',
          kind: 'shell',
          title: 'Shell',
          isStructuralPlaceholder: true,
        },
      },
      focusedPaneId: 'shell-home-placeholder',
    });
    const mounted = mount();

    await act(async () => {
      presentationHandler?.({
        missionId: 'mission-home',
        paneId: 'pane-home',
        sessionId: 'session-home',
        role: 'orchestrator',
        pane: {
          adapterId: 'codex',
          model: 'gpt-5.6-sol',
          cwd: '/workspace/home',
          title: 'Maestro',
          agentName: 'Maestro',
          role: 'orchestrator',
        },
      });
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith(
          'pane-home',
          75_000,
        );
      });
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
      .toEqual(['pane-home']);
    expect(useHomeStore.getState().visible).toBe(false);
    act(() => mounted.root.unmount());
  });

  it('spawn channel replaces the lone structural placeholder and hides Home', async () => {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    const sendPaneSpawnResult = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
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
    useHomeStore.setState({ visible: true });
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
    expect(useHomeStore.getState().visible).toBe(false);
    act(() => mounted.root.unmount());
  });

  it('re-presents the same live pane after switching A to B and back to A', async () => {
    let presentationHandler:
      | ((req: MissionPanePresentationRequest) => void)
      | null = null;
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
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

  it('cancels a late missing-pane spawn when it never becomes healthy', async () => {
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    terminal.waitForHealthyPaneSession.mockResolvedValueOnce(null);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
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

  it('does not cancel a newer session when a stale recovery loses the CAS race', async () => {
    let recoveryHandler: ((req: MissionPaneRecoveryRequest) => void) | null = null;
    const sendPaneRecoveryResult = vi.fn();
    terminal.respawnMissionPaneFresh.mockRejectedValueOnce(
      new Error('mission pane session changed before recovery'),
    );
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
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

  it('removes a failed orchestration pane before reporting a missing session and retries without growth', async () => {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    const sendPaneSpawnResult = vi.fn();
    const syncPanes = vi.fn();
    let settleFirstWait: ((sessionId: string | null) => void) | null = null;
    terminal.waitForSession
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleFirstWait = resolve;
          }),
      )
      .mockResolvedValueOnce(null);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
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
      resume: false,
      resumeLatestOnly: false,
      restorePersistedAuthority: false,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      act(() => spawnHandler?.(request));
      if (attempt === 0) {
        await vi.waitFor(() => {
          expect(
            listPanes(useLayoutStore.getState().root).some(
              (pane) => pane.id === request.paneId,
            ),
          ).toBe(true);
        });
        // Terminal spawn failure historically cleared the spent token before
        // waitForSession returned. The still-in-flight sealed request retains
        // cleanup ownership of its exact Main-minted pane id.
        act(() => {
          useLayoutStore.getState().clearOrchRequestId(request.paneId);
          settleFirstWait?.(null);
        });
      }
      await vi.waitFor(() => {
        expect(sendPaneSpawnResult).toHaveBeenCalledTimes(attempt + 1);
      });
      expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id))
        .toEqual(['pane-shell']);
    }

    expect(sendPaneSpawnResult).toHaveBeenLastCalledWith({
      requestId: request.requestId,
      ok: false,
      paneId: request.paneId,
      error: 'session did not start (adapter missing or spawn failed)',
    });
    expect(syncPanes).toHaveBeenLastCalledWith([
      expect.objectContaining({ paneId: 'pane-shell' }),
    ]);
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
});
