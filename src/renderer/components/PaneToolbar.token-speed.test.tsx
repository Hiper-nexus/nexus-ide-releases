/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import {
  EMPTY_TOKEN_SPEED_SNAPSHOT,
  type PaneTokenSpeed,
  type TokenSpeedSample,
} from '../../shared/token-speed-types';
import { useTokenSpeedStore } from '../state/token-speed-store';

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

const agentPane: PaneModel = {
  id: 'agent-1',
  kind: 'cli-agent',
  title: 'Worker A',
  adapterId: 'codex',
};
const shellPane: PaneModel = { id: 'shell-1', kind: 'shell', title: 'shell' };

function sample(over: Partial<TokenSpeedSample> = {}): TokenSpeedSample {
  return {
    paneId: 'agent-1',
    at: 1_000,
    startedAt: 0,
    outputTokens: 403,
    generationMs: 1_300,
    tokensPerSecond: 310,
    ttftMs: 5_200,
    model: 'gpt-5-codex',
    source: 'estimated',
    ...over,
  };
}

function paneSpeed(over: Partial<PaneTokenSpeed> = {}): PaneTokenSpeed {
  return {
    paneId: 'agent-1',
    model: 'gpt-5-codex',
    turns: 2,
    last: sample(),
    averageTokensPerSecond: 250,
    peakTokensPerSecond: 310,
    lastTtftMs: 5_200,
    streaming: false,
    history: [sample()],
    ...over,
  };
}

function mount(pane: PaneModel): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<PaneToolbar pane={pane} isFocused />));
  return { host, root };
}

let mounted: Root | null = null;

afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
  useTokenSpeedStore.getState().reset();
  document.body.innerHTML = '';
});

describe('PaneToolbar — chip de velocidade de tokens', () => {
  it('não ocupa espaço no pane sem medição', () => {
    const { host, root } = mount(agentPane);
    mounted = root;
    expect(host.querySelector('.tokspeed-chip')).toBeNull();
  });

  it('mostra a velocidade DO PANE, não o agregado do workspace', () => {
    act(() => {
      useTokenSpeedStore.getState().receive({
        ...EMPTY_TOKEN_SPEED_SNAPSHOT,
        // Agregado do workspace é outro número: o chip não pode exibi-lo.
        last: sample({ paneId: 'agent-2', tokensPerSecond: 999 }),
        panes: [paneSpeed()],
      });
    });
    const { host, root } = mount(agentPane);
    mounted = root;
    const chip = host.querySelector('.tokspeed-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('310');
    expect(chip?.textContent).not.toContain('999');
  });

  it('marca o pane que está gerando agora', () => {
    act(() => {
      useTokenSpeedStore.getState().receive({
        ...EMPTY_TOKEN_SPEED_SNAPSHOT,
        streaming: true,
        panes: [paneSpeed({ streaming: true })],
      });
    });
    const { host, root } = mount(agentPane);
    mounted = root;
    expect(
      host.querySelector('.tokspeed-chip')?.getAttribute('data-streaming'),
    ).toBe('on');
  });

  it('pane sem medição NÃO herda o número de outro pane', () => {
    act(() => {
      useTokenSpeedStore.getState().receive({
        ...EMPTY_TOKEN_SPEED_SNAPSHOT,
        // Só o VIZINHO mediu, e ele está a todo vapor.
        last: sample({ paneId: 'agent-2', tokensPerSecond: 900 }),
        streaming: true,
        panes: [paneSpeed({ paneId: 'agent-2', streaming: true })],
      });
    });
    const { host, root } = mount(agentPane);
    mounted = root;
    // Exibir 900 aqui seria atribuir a este pane a velocidade do vizinho.
    expect(host.querySelector('.tokspeed-chip')).toBeNull();
  });

  it('pane que não é agente nunca recebe o chip', () => {
    act(() => {
      useTokenSpeedStore.getState().receive({
        ...EMPTY_TOKEN_SPEED_SNAPSHOT,
        last: sample(),
        panes: [paneSpeed({ paneId: 'shell-1' })],
      });
    });
    const { host, root } = mount(shellPane);
    mounted = root;
    expect(host.querySelector('.tokspeed-chip')).toBeNull();
  });
});
