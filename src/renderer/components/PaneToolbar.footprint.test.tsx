/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { useSessionStateStore } from '../state/session-state-store';
import { usePaneFootprintStore } from '../state/pane-footprint-store';

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

import { formatFootprintLabel, PaneToolbar } from './PaneToolbar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const pane: PaneModel = {
  id: 'agent-cost',
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

describe('formatFootprintLabel', () => {
  it('arredonda valores abaixo de 100 MB à dezena', () => {
    expect(formatFootprintLabel(83 * 1024 * 1024)).toBe('80 MB');
  });

  it('mostra MB inteiro entre 100 MB e 1 GB', () => {
    expect(formatFootprintLabel(512 * 1024 * 1024)).toBe('512 MB');
  });

  it('mostra GB com uma casa decimal acima de 1 GB', () => {
    expect(formatFootprintLabel(1.8 * 1024 * 1024 * 1024)).toBe('1.8 GB');
  });
});

describe('PaneToolbar — badge de custo por pane (0.76.45)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStateStore.setState({
      paneStates: new Map([[pane.id, 'busy']]),
      displayStates: new Map([[pane.id, 'busy']]),
    });
    usePaneFootprintStore.setState({
      capturedAt: null,
      bySessionId: {},
      systemMemory: null,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mostra o RSS arredondado da sessão do pane, com tooltip de N processos', () => {
    usePaneFootprintStore.setState({
      capturedAt: 1000,
      bySessionId: { 'session-a': { rssBytes: 512 * 1024 * 1024, processCount: 3 } },
      systemMemory: null,
    });
    const { host } = mount();

    const badge = host.querySelector('.toolbar__footprint');
    expect(badge?.textContent).toBe('512 MB');
    expect(badge?.getAttribute('data-tip')).toBe('3 processos · RSS da árvore');
  });

  it('não renderiza nada quando o footprint da sessão é null (sem telemetria inventada)', () => {
    usePaneFootprintStore.setState({
      capturedAt: 1000,
      bySessionId: { 'session-a': { rssBytes: null, processCount: 0 } },
      systemMemory: null,
    });
    const { host } = mount();
    expect(host.querySelector('.toolbar__footprint')).toBeNull();
  });

  it('não renderiza nada antes do primeiro broadcast chegar', () => {
    const { host } = mount();
    expect(host.querySelector('.toolbar__footprint')).toBeNull();
  });

  it('reserva largura mínima estável (tabular-nums) para não tremer a cada atualização', () => {
    usePaneFootprintStore.setState({
      capturedAt: 1000,
      bySessionId: { 'session-a': { rssBytes: 80 * 1024 * 1024, processCount: 2 } },
      systemMemory: null,
    });
    const { host, root } = mount();
    const small = host.querySelector<HTMLElement>('.toolbar__footprint')!;
    expect(small.style.fontVariantNumeric).toBe('tabular-nums');
    const minWidth = small.style.minWidth;
    expect(minWidth).not.toBe('');

    act(() => {
      usePaneFootprintStore.setState({
        capturedAt: 2000,
        bySessionId: { 'session-a': { rssBytes: 1.8 * 1024 * 1024 * 1024, processCount: 9 } },
        systemMemory: null,
      });
    });
    act(() => root.render(<PaneToolbar pane={pane} isFocused />));
    const big = host.querySelector<HTMLElement>('.toolbar__footprint')!;
    expect(big.style.minWidth).toBe(minWidth);
  });
});
