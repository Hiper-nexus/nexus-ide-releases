/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import type { JevPaneHint } from '../../shared/jev-ipc';
import { useJevHintStore } from '../state/jev-hint-store';

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

const pane: PaneModel = {
  id: 'agent-jev',
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

function setHint(sessionId: string, hint: JevPaneHint) {
  useJevHintStore.setState((s) => {
    const next = new Map(s.bySessionId);
    next.set(sessionId, hint);
    return { bySessionId: next };
  });
}

describe('PaneToolbar — chip do classificador (paneState) diz quem respondeu e fala do pane', () => {
  afterEach(() => {
    useJevHintStore.setState({ bySessionId: new Map() });
    document.body.innerHTML = '';
  });

  it('hint do Jev: "Jev · pane esperando você" + modelo no tooltip', () => {
    setHint('session-a', {
      state: 'waiting_for_human',
      confidence: 0.86,
      needsHuman: 0.9,
      at: Date.now(),
      model: 'jev-1.13.0',
      provider: 'jev',
    });
    const { host } = mount();
    expect(host.textContent).toContain('Jev · pane esperando você');
    expect(host.innerHTML).toContain('confiança 0.86');
    expect(host.innerHTML).toContain('jev-1.13.0');
  });

  it('quem respondeu foi o Clef: "Clef · pane ocioso" (não "Jev: ocioso")', () => {
    setHint('session-a', {
      state: 'idle_prompt',
      confidence: 0.7,
      needsHuman: 0,
      at: Date.now(),
      model: 'clef-omni',
      provider: 'clef',
    });
    const { host } = mount();
    expect(host.textContent).toContain('Clef · pane ocioso');
    expect(host.textContent).not.toContain('Jev: ocioso');
    expect(host.innerHTML).toContain('clef-omni');
  });

  it('quem respondeu foi a Luna: "Luna · pane terminou"', () => {
    setHint('session-a', {
      state: 'finished',
      confidence: 0.9,
      needsHuman: 0,
      at: Date.now(),
      model: 'gpt-6-luna',
      provider: 'luna',
    });
    const { host } = mount();
    expect(host.textContent).toContain('Luna · pane terminou');
  });

  it('hint sem provider (evento antigo) cai no Jev', () => {
    setHint('session-a', {
      state: 'working',
      confidence: 0.8,
      needsHuman: 0,
      at: Date.now(),
      model: 'jev-1.13.0',
    });
    const { host } = mount();
    expect(host.textContent).toContain('Jev · pane trabalhando');
  });

  it('hint velho (>10min) não aparece', () => {
    setHint('session-a', {
      state: 'finished',
      confidence: 0.9,
      needsHuman: 0,
      at: Date.now() - 11 * 60_000,
      model: 'jev-1.13.0',
    });
    const { host } = mount();
    expect(host.textContent).not.toContain('pane terminou');
  });

  it('sem hint para a sessão não aparece', () => {
    const { host } = mount();
    expect(host.textContent).not.toMatch(/· pane /);
  });
});
