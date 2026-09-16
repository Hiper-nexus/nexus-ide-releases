/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { useSessionStateStore } from '../state/session-state-store';
import { usePaneParkedStore } from '../state/pane-parked-store';

const power = vi.hoisted(() => ({
  hibernateHost: vi.fn(() => true),
  wakeHost: vi.fn(() => true),
}));

vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: power.hibernateHost,
  wakeHost: power.wakeHost,
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  getPaneSessionId: vi.fn(() => null),
  onPaneSessionChange: vi.fn(() => vi.fn()),
}));
vi.mock('../state/confirm-store', () => ({ askConfirm: vi.fn(async () => true) }));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('./CostBadge', () => ({ CostBadge: () => null }));
vi.mock('./DevServerChip', () => ({ DevServerChip: () => null }));
vi.mock('./ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('./CommandBlockMenu', () => ({ CommandBlockMenu: () => null }));
vi.mock('./AgentAvatar', () => ({
  AgentAvatar: () => null,
  resolveAgentCategory: () => undefined,
}));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));

import { PaneToolbar } from './PaneToolbar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const pane: PaneModel = {
  id: 'agent-parked',
  kind: 'cli-agent',
  title: 'Worker A',
  adapterId: 'codex',
};

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<PaneToolbar pane={pane} isFocused />));
  return { host, root };
}

describe('PaneToolbar — pane estacionado pelo guardian (0.76.45)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStateStore.setState({
      paneStates: new Map([[pane.id, 'exited']]),
      displayStates: new Map([[pane.id, 'exited']]),
    });
    usePaneParkedStore.setState({ parked: new Map() });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mostra "Dormindo" e o botão "Acordar" — não "Encerrado" — quando o pane está estacionado', () => {
    usePaneParkedStore
      .getState()
      .markParked(pane.id, { sessionId: 's1', parkedAt: 1, reason: 'idle' });
    const { host } = mount();

    expect(host.textContent).toContain('Dormindo');
    expect(host.textContent).not.toContain('Encerrado');
    const wake = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Acordar"]',
    );
    expect(wake).not.toBeNull();
  });

  it('clicar em "Acordar" chama wakeHost com o mesmo pane', () => {
    usePaneParkedStore
      .getState()
      .markParked(pane.id, { sessionId: 's1', parkedAt: 1, reason: 'memory-pressure' });
    const { host } = mount();

    const wake = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Acordar"]',
    )!;
    act(() => wake.click());

    expect(power.wakeHost).toHaveBeenCalledWith(pane);
    expect(power.hibernateHost).not.toHaveBeenCalled();
  });

  it('sem estacionamento, um pane exited mostra "Encerrado" normalmente', () => {
    const { host } = mount();
    expect(host.textContent).toContain('Encerrado');
    expect(host.textContent).not.toContain('Dormindo');
  });
});
