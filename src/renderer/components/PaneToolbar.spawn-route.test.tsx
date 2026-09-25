/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';

vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: vi.fn(),
  wakeHost: vi.fn(),
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  getPaneSessionId: vi.fn(() => 'session-a'),
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

function mount(pane: PaneModel): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<PaneToolbar pane={pane} isFocused />));
  return host;
}

describe('PaneToolbar — chip da rota do spawn', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const base: PaneModel = { id: 'p1', kind: 'cli-agent', title: 'Helper', adapterId: 'codex' };

  it('rota do Jev mostra "Jev"', () => {
    const host = mount({ ...base, spawnRoute: { source: 'jev' } });
    expect(host.textContent).toContain('Jev');
    expect(host.innerHTML).toContain('CLI escolhida pelo Jev');
  });

  it('queda mostra "sem Jev" com o motivo no tooltip', () => {
    const host = mount({ ...base, spawnRoute: { source: 'heuristic', jevUnavailable: 'timeout' } });
    expect(host.textContent).toContain('sem Jev');
    expect(host.innerHTML).toContain('tempo esgotado');
  });

  it('heurística sem queda (Jev pouco confiante) e pane sem rota não mostram chip', () => {
    expect(mount({ ...base, spawnRoute: { source: 'heuristic' } }).innerHTML).not.toContain('rota-chip');
    expect(mount(base).innerHTML).not.toContain('rota-chip');
  });
});
