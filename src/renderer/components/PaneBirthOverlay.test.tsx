/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneBirthOverlay } from './PaneBirthOverlay';
import { useSessionStateStore } from '../state/session-state-store';
import type { PaneModel } from '../../shared/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const sessionListeners = new Set<
  (paneId: string, sessionId: string | null) => void
>();
let liveSessionId: string | null = null;

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: () => liveSessionId,
  onPaneSessionChange: (cb: (paneId: string, sessionId: string | null) => void) => {
    sessionListeners.add(cb);
    return () => sessionListeners.delete(cb);
  },
}));

const PANE: PaneModel = {
  id: 'pane-birth',
  kind: 'cli-agent',
  title: 'Codex',
  adapterId: 'codex',
  agentName: 'Codex Dev',
  model: 'gpt-5.6-sol',
} as PaneModel;

const roots: Root[] = [];

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<PaneBirthOverlay pane={PANE} />));
  return host;
}

beforeEach(() => {
  liveSessionId = null;
  sessionListeners.clear();
  useSessionStateStore.setState({
    paneStates: new Map(),
    displayStates: new Map(),
  } as never);
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('PaneBirthOverlay', () => {
  it('explains the empty terminal while the session is being born', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
    });
    const host = mount();
    expect(host.textContent).toContain('Preparando agente…');
    expect(host.textContent).toContain('Codex Dev');
    expect(host.textContent).toContain('gpt-5.6-sol');
  });

  it('leaves the tree as soon as the PTY reports its session', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
    });
    const host = mount();
    expect(host.textContent).toContain('Preparando agente…');
    act(() => {
      liveSessionId = 'session-1';
      for (const cb of sessionListeners) cb(PANE.id, 'session-1');
    });
    expect(host.textContent).toBe('');
  });

  it('ignores a session event addressed to another pane', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'spawning');
    });
    const host = mount();
    act(() => {
      for (const cb of sessionListeners) cb('pane-other', 'session-other');
    });
    expect(host.textContent).toContain('Preparando agente…');
  });

  it('never covers a pane whose session already died', () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(PANE.id, 'exited');
    });
    expect(mount().textContent).toBe('');
  });
});
