/** @vitest-environment jsdom */
import { useAccessStore } from '../state/access-store';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { buildGridTree } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';

const close = vi.hoisted(() => vi.fn());
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: close }));
vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: vi.fn(), wakeHost: vi.fn(), respawnWithResume: vi.fn(), scrollPaneToBottom: vi.fn(),
  getPaneSessionId: vi.fn(() => null),
  repaintPaneTui: vi.fn(),
  onPaneSessionChange: vi.fn(() => () => {}),
}));
vi.mock('./CostBadge', () => ({ CostBadge: () => null }));
vi.mock('./DevServerChip', () => ({ DevServerChip: () => null }));
vi.mock('./CommandBlockMenu', () => ({ CommandBlockMenu: () => null }));
vi.mock('./AgentAvatar', () => ({ AgentAvatar: () => null, resolveAgentCategory: () => undefined }));
vi.mock('./ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));

import { PaneToolbar } from './PaneToolbar';
import { getPaneSessionId, repaintPaneTui } from '../terminal/terminal-host';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let measure!: (width: number) => void;
const roots: Root[] = [];
const pane: PaneModel = { id: 'narrow-toolbar', kind: 'shell', title: 'Terminal' };

function mount(width: number): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<PaneToolbar pane={pane} isFocused />));
  act(() => measure(width));
  return host;
}

beforeEach(() => {
  useAccessStore.setState({ canUseApp: true, maxAgents: null });
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      measure = width => callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() {}
  });
  useLayoutStore.setState({ root: buildGridTree([pane]), focusedPaneId: pane.id, maximizedPaneId: null });
  useSessionStateStore.setState({ paneStates: new Map(), displayStates: new Map() });
});

afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Faz a barra montada medir `content` px de conteúdo rígido numa caixa de `box` px. */
function overflowToolbar(host: HTMLElement, content: number, box: number): void {
  const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
  Object.defineProperty(toolbar, 'scrollWidth', { configurable: true, get: () => content });
  Object.defineProperty(toolbar, 'clientWidth', { configurable: true, get: () => box });
}

describe('PaneToolbar narrow controls', () => {
  it('F-717: pane largo cuja barra cheia transborda desce para ícones e mantém o Fechar', () => {
    const host = mount(850);
    const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
    expect(toolbar.dataset.density).toBe('full');
    // Rótulos + custo + tok/s pediam 1011 px num pane de 850 px.
    overflowToolbar(host, 1025, 864);
    act(() => measure(850));
    expect(toolbar.dataset.density).toBe('icons');
    expect(host.querySelector('.toolbar__actions .toolbar__btn-label')).toBeNull();
    expect(host.querySelector('[aria-label="Fechar este pane"]')).not.toBeNull();
    // Em ícones a barra cabe: fica, sem alternar a cada quadro.
    overflowToolbar(host, 864, 864);
    act(() => measure(850));
    expect(toolbar.dataset.density).toBe('icons');
    // Só volta ao modo cheio com a largura que ele pediu mais a folga.
    act(() => measure(1011 + 31));
    expect(toolbar.dataset.density).toBe('icons');
    act(() => measure(1011 + 32));
    expect(toolbar.dataset.density).toBe('full');
  });

  it('keeps readable icon controls instead of crowded full labels on a medium pane', () => {
    const host = mount(600);
    const maximize = host.querySelector<HTMLButtonElement>('.toolbar__actions [aria-label="Ampliar"]');
    expect(maximize).not.toBeNull();
    expect(maximize?.querySelector('.toolbar__btn-label')).toBeNull();
    act(() => maximize!.click());
    expect(useLayoutStore.getState().maximizedPaneId).toBe(pane.id);
  });

  it.each([120, 160, 240])('moves optional actions to the existing menu at %ipx and retains the guarded close action', width => {
    const host = mount(width);
    const inline = host.querySelector('.toolbar__actions');
    expect([...inline!.querySelectorAll('button')].map(button => button.ariaLabel)).toEqual(['Mais ações do pane']);
    const closeButton = host.querySelector<HTMLButtonElement>('[aria-label="Fechar este pane"]');
    expect(closeButton).not.toBeNull();
    act(() => closeButton!.click());
    expect(close).toHaveBeenCalledExactlyOnceWith(pane.id, undefined, {
      hasLiveSession: false,
    });
  });

  it('opens layout actions outside the clipped pane and returns keyboard focus on Escape', () => {
    const host = mount(120);
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Mais ações do pane"]')!;
    act(() => trigger.click());
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(host.contains(menu)).toBe(false);
    expect(menu?.querySelector('[aria-label="À direita"]')).not.toBeNull();
    expect(menu?.querySelector('[aria-label="Abaixo"]')).not.toBeNull();
    expect(menu?.contains(document.activeElement)).toBe(true);
    const surfaceShortcut = vi.fn();
    window.addEventListener('keydown', surfaceShortcut);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    try {
      act(() => document.activeElement!.dispatchEvent(escape));
      expect(escape.defaultPrevented).toBe(true);
      expect(surfaceShortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', surfaceShortcut);
    }
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the maximize behavior reachable from the compact menu', () => {
    const host = mount(160);
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Mais ações do pane"]')!;
    act(() => trigger.click());
    const maximize = document.querySelector<HTMLButtonElement>('[role="menu"] [aria-label="Ampliar"]');
    expect(maximize).not.toBeNull();
    act(() => maximize!.click());
    expect(useLayoutStore.getState().maximizedPaneId).toBe(pane.id);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('navigates menu items with arrows, Home and End without reaching the grid shortcuts', () => {
    const host = mount(120);
    const surfaceShortcut = vi.fn();
    document.addEventListener('keydown', surfaceShortcut);
    try {
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="Mais ações do pane"]')!.click());
      const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const transitions = [
        ['ArrowDown', items[1]], ['ArrowUp', items[0]], ['ArrowUp', items.at(-1)],
        ['Home', items[0]], ['End', items.at(-1)], ['ArrowDown', items[0]],
      ] as const;
      for (const [key, target] of transitions) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        act(() => document.activeElement!.dispatchEvent(event));
        expect(document.activeElement).toBe(target);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(surfaceShortcut).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', surfaceShortcut);
    }
  });

  it('F-568: o título mantém o mesmo estilo de largura (className + style) trocando de conteúdo', () => {
    // A barra "treme" quando o box do título muda de largura sozinho a cada
    // frame do spinner do CLI. Aqui não há layout real (jsdom), então o
    // proxy é: as regras que controlam a largura (className + inline style,
    // com min-width/ellipsis/tabular-nums) nunca dependem do texto do
    // título — só o conteúdo textual muda entre renders.
    const titledPane: PaneModel = { id: 'title-toolbar', kind: 'shell', title: 'nexus-ide' };
    useLayoutStore.setState({
      root: buildGridTree([titledPane]),
      focusedPaneId: titledPane.id,
      maximizedPaneId: null,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<PaneToolbar pane={titledPane} isFocused />));
    act(() => measure(600));

    const titleEl = () => host.querySelector<HTMLElement>('.toolbar__title')!;
    const stableClassName = titleEl().className;
    const stableStyle = titleEl().getAttribute('style');

    for (const title of ['Brief da missão', 'a', 'um título bem mais comprido que o anterior']) {
      act(() => root.render(<PaneToolbar pane={{ ...titledPane, title }} isFocused />));
      expect(titleEl().className).toBe(stableClassName);
      expect(titleEl().getAttribute('style')).toBe(stableStyle);
      expect(titleEl().textContent).toBe(title);
    }
  });

  it('F-597: pane Claude cujo título OSC fala de Codex mostra Claude na frente', () => {
    const agent: PaneModel = {
      id: 'claude-as-codex',
      kind: 'cli-agent',
      title: 'Codex pane boot crash',
      adapterId: 'claude',
      model: 'claude-sonnet-5',
    };
    useLayoutStore.setState({
      root: buildGridTree([agent]),
      focusedPaneId: agent.id,
      maximizedPaneId: null,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<PaneToolbar pane={agent} isFocused />));
    act(() => measure(900));
    expect(host.querySelector('.toolbar__title')?.textContent).toBe(
      'Claude · Codex pane boot crash',
    );
  });

  it('F-216: oferece Redesenhar tela para cli-agent com sessão viva', () => {
    const agent: PaneModel = {
      id: 'repaint-agent',
      kind: 'cli-agent',
      title: 'Claude',
      adapterId: 'claude',
    };
    vi.mocked(getPaneSessionId).mockReturnValue('sess-live');
    useLayoutStore.setState({
      root: buildGridTree([agent]),
      focusedPaneId: agent.id,
      maximizedPaneId: null,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<PaneToolbar pane={agent} isFocused />));
    act(() => measure(900));

    const repaint = host.querySelector<HTMLButtonElement>(
      '[aria-label="Redesenhar tela"]',
    );
    expect(repaint).not.toBeNull();
    act(() => repaint!.click());
    expect(repaintPaneTui).toHaveBeenCalledExactlyOnceWith(agent.id);
  });

  it('F-216: esconde Redesenhar tela sem sessão ou fora de cli-agent', () => {
    const agentNoSession: PaneModel = {
      id: 'repaint-no-session',
      kind: 'cli-agent',
      title: 'Claude',
      adapterId: 'claude',
    };
    const shellPane: PaneModel = {
      id: 'repaint-shell',
      kind: 'shell',
      title: 'sh',
    };
    for (const target of [agentNoSession, shellPane]) {
      vi.mocked(getPaneSessionId).mockReturnValue(null);
      useLayoutStore.setState({
        root: buildGridTree([target]),
        focusedPaneId: target.id,
        maximizedPaneId: null,
      });
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      roots.push(root);
      act(() => root.render(<PaneToolbar pane={target} isFocused />));
      act(() => measure(900));
      expect(
        host.querySelector('[aria-label="Redesenhar tela"]'),
      ).toBeNull();
    }
  });

  it('exibe o botão de Foco Stage na barra de ferramentas em largura normal', () => {
    const pane2: PaneModel = { id: 'pane-2', kind: 'shell', title: 'Terminal 2' };
    useLayoutStore.setState({ root: buildGridTree([pane, pane2]), focusedPaneId: pane.id, maximizedPaneId: null });
    const host = mount(600);
    const stageBtn = host.querySelector<HTMLButtonElement>(
      '[aria-label="Foco Stage"], [aria-label="Grade Normal"]',
    );
    expect(stageBtn).not.toBeNull();
    act(() => stageBtn!.click());
    expect(useLayoutStore.getState().stageFocusMode).toBe(true);
  });
});
