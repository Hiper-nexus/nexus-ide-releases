// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_BUSY_MS_FOR_COMPLETED } from '../../shared/agent-notification';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import {
  initAgentNotificationBridge,
  resetAgentNotificationBridgeForTests,
} from './agent-notification-bridge';
import { useSessionStateStore } from '../state/session-state-store';

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

describe('agent-notification-bridge', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    useSessionStateStore.setState({ paneStates: new Map() });
    useAgentNotificationStore.setState({ items: [], open: false });
    resetAgentNotificationBridgeForTests();
    stop = initAgentNotificationBridge();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    resetAgentNotificationBridgeForTests();
  });

  it('does not notify on short busy→idle blips', () => {
    useSessionStateStore.getState().setPaneState('pane-claude', 'busy');
    useSessionStateStore.getState().setPaneState('pane-claude', 'idle');
    expect(useAgentNotificationStore.getState().items).toHaveLength(0);
  });

  it('notifies completed after sustained busy then idle', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    useSessionStateStore.getState().setPaneState('pane-claude', 'busy');

    nowSpy.mockReturnValue(1_000 + MIN_BUSY_MS_FOR_COMPLETED + 100);
    useSessionStateStore.getState().setPaneState('pane-claude', 'idle');

    const items = useAgentNotificationStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('completed');
    expect(items[0]?.agentLabel).toBe('Claude');
    nowSpy.mockRestore();
  });

  it('notifies exited through the live bridge', () => {
    useSessionStateStore.getState().setPaneState('pane-claude', 'busy');
    useSessionStateStore.getState().setPaneState('pane-claude', 'exited');
    expect(useAgentNotificationStore.getState().items[0]?.kind).toBe('exited');
  });

  it('ignores non-cli panes through the live bridge', () => {
    useSessionStateStore.getState().setPaneState('pane-shell', 'busy');
    useSessionStateStore.getState().setPaneState('pane-shell', 'exited');
    expect(useAgentNotificationStore.getState().items).toHaveLength(0);
  });
});
