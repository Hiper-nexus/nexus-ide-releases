/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { useSessionStateStore } from '../state/session-state-store';

const power = vi.hoisted(() => ({
  hibernateHost: vi.fn(() => true),
  wakeHost: vi.fn(() => true),
  askConfirm: vi.fn(async () => true),
}));

vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: power.hibernateHost,
  wakeHost: power.wakeHost,
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
}));
vi.mock('../state/confirm-store', () => ({ askConfirm: power.askConfirm }));
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
  id: 'agent-a',
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

describe('PaneToolbar hibernate/wake regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStateStore.setState({
      paneStates: new Map([[pane.id, 'idle']]),
      displayStates: new Map([[pane.id, 'idle']]),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hibernates an idle agent immediately and wakes the same pane identity', () => {
    const first = mount();
    const sleep = first.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dormir"]',
    );
    expect(sleep).not.toBeNull();
    act(() => sleep!.click());
    expect(power.hibernateHost).toHaveBeenCalledWith(pane.id);
    expect(power.askConfirm).not.toHaveBeenCalled();
    act(() => first.root.unmount());

    act(() => {
      useSessionStateStore.getState().setPaneState(pane.id, 'hibernated');
    });
    const second = mount();
    const wake = second.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Acordar"]',
    );
    expect(wake).not.toBeNull();
    act(() => wake!.click());
    expect(power.wakeHost).toHaveBeenCalledWith(pane);
    act(() => second.root.unmount());
  });

  it('requires explicit confirmation before killing a busy agent', async () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(pane.id, 'busy');
    });
    power.askConfirm.mockResolvedValueOnce(false);
    const { host, root } = mount();
    const sleep = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dormir"]',
    );

    await act(async () => sleep!.click());
    expect(power.askConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true }),
    );
    expect(power.hibernateHost).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
