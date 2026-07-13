/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionPaneRecoveryRequest } from '../../shared/orch-types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchBridge } from './orch-bridge';

const terminal = vi.hoisted(() => ({
  cancelPaneRecovery: vi.fn(),
  getPaneSessionId: vi.fn(() => null as string | null),
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

describe('orchestration bridge pane recovery', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
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
});
