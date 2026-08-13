// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentWaitingEvent } from '../../shared/types';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import { useAgentWaitingStore } from '../state/agent-waiting-store';
import {
  initAgentNotificationBridge,
  resetAgentNotificationBridgeForTests,
} from './agent-notification-bridge';
import {
  useSessionStateStore,
  __resetSessionStateDisplayTimersForTests,
} from '../state/session-state-store';

let waitingHandler: ((event: AgentWaitingEvent) => void) | null = null;

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: {
          id: 'pane-claude',
          kind: 'cli-agent',
          title: 'Claude',
          adapterId: 'claude',
          agentName: 'Claude',
        },
      },
    }),
  },
}));

const setState = (id: string, s: 'spawning' | 'busy' | 'idle' | 'exited') =>
  useSessionStateStore.getState().setPaneState(id, s);

/** Leva um pane por boot completo (spawning→busy→idle) sem notificação. */
function bootToIdle(id: string): void {
  setState(id, 'spawning');
  setState(id, 'busy');
  setState(id, 'idle');
  vi.advanceTimersByTime(1_500); // vence o hold de displayStates
}

describe('agent-notification-bridge', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    waitingHandler = null;
    vi.stubGlobal('window', {
      nexus: {
        orch: {
          onBgTaskEvent: () => () => {},
          onAgentWaiting: (cb: (event: AgentWaitingEvent) => void) => {
            waitingHandler = cb;
            return () => {
              if (waitingHandler === cb) waitingHandler = null;
            };
          },
        },
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(0);
    useSessionStateStore.setState({
      paneStates: new Map(),
      displayStates: new Map(),
    });
    useAgentNotificationStore.setState({ items: [], open: false });
    useAgentWaitingStore.getState().clear();
    __resetSessionStateDisplayTimersForTests();
    resetAgentNotificationBridgeForTests();
    stop = initAgentNotificationBridge();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    __resetSessionStateDisplayTimersForTests();
    resetAgentNotificationBridgeForTests();
    useAgentWaitingStore.getState().clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not notify on a boot/respawn (spawning→busy→idle)', () => {
    vi.advanceTimersByTime(1_000);
    bootToIdle('pane-claude');
    // Boot dura > mínimo, mas a época não nasceu de um turno → sem CONCLUÍDO.
    expect(useAgentNotificationStore.getState().items).toHaveLength(0);
  });

  it('does not notify on short busy→idle blips within the display hold', () => {
    bootToIdle('pane-claude');
    setState('pane-claude', 'busy');
    setState('pane-claude', 'idle'); // volta a busy antes do hold vencer
    setState('pane-claude', 'busy');
    vi.advanceTimersByTime(300);
    expect(useAgentNotificationStore.getState().items).toHaveLength(0);
  });

  it('notifies completed after a sustained real turn (idle→busy→idle)', () => {
    bootToIdle('pane-claude');
    setState('pane-claude', 'busy'); // idle→busy: turno real
    vi.advanceTimersByTime(1_600); // trabalho sustentado > MIN_BUSY
    setState('pane-claude', 'idle');
    vi.advanceTimersByTime(1_500); // vence o hold → display vira idle

    const items = useAgentNotificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('completed');
    expect(items[0]?.agentLabel).toBe('Claude');
  });

  it('notifies exited through the live bridge', () => {
    setState('pane-claude', 'busy');
    setState('pane-claude', 'exited');
    expect(useAgentNotificationStore.getState().items[0]?.kind).toBe('exited');
  });

  it('ignores non-cli panes through the live bridge', () => {
    setState('pane-shell', 'busy');
    setState('pane-shell', 'exited');
    expect(useAgentNotificationStore.getState().items).toHaveLength(0);
  });

  it('stops feeding after teardown', () => {
    stop?.();
    stop = null;
    bootToIdle('pane-claude');
    setState('pane-claude', 'busy');
    vi.advanceTimersByTime(2_000);
    setState('pane-claude', 'exited');
    expect(useAgentNotificationStore.getState().items).toHaveLength(0);
  });

  it('a stale stop handle does not tear down a restarted bridge', () => {
    const staleStop = stop!;
    staleStop(); // primeira parada real
    const fresh = initAgentNotificationBridge();
    staleStop(); // handle obsoleto — não pode derrubar o bridge novo
    setState('pane-claude', 'busy');
    setState('pane-claude', 'exited');
    expect(useAgentNotificationStore.getState().items[0]?.kind).toBe('exited');
    fresh();
  });

  it('hook awaiting-input vira needs_input e latch vivo', () => {
    waitingHandler?.({
      source: 'semantic',
      sessionId: 's1',
      paneId: 'pane-claude',
      agentLabel: 'Claude',
      state: 'awaiting-input',
      at: 10,
    });
    const items = useAgentNotificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('needs_input');
    expect(items[0]?.agentLabel).toBe('Claude');
    expect(
      useAgentWaitingStore.getState().snapshot.entries.has('pane-claude'),
    ).toBe(true);
  });

  it('working depois de awaiting-input solta o latch', () => {
    waitingHandler?.({
      source: 'semantic',
      sessionId: 's1',
      paneId: 'pane-claude',
      agentLabel: 'Claude',
      state: 'awaiting-input',
      at: 10,
    });
    waitingHandler?.({
      source: 'semantic',
      sessionId: 's1',
      paneId: 'pane-claude',
      agentLabel: 'Claude',
      state: 'working',
      at: 20,
    });
    expect(useAgentWaitingStore.getState().snapshot.entries.size).toBe(0);
  });

  it('exited limpa o latch do pane', () => {
    waitingHandler?.({
      source: 'orca',
      sessionId: 's1',
      paneId: 'pane-claude',
      agentLabel: 'Claude',
      state: 'waiting',
      at: 10,
    });
    setState('pane-claude', 'busy');
    setState('pane-claude', 'exited');
    expect(useAgentWaitingStore.getState().snapshot.entries.size).toBe(0);
  });
});
