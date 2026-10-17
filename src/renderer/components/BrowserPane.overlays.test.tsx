/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { buildGridTree } from '../lib/split-tree';
import { attachBrowserPane } from '../browser/browser-host';
import { OverlayLayer, resetOverlayRootForTest } from '../overlay/overlay-layer';
import { useAccessStore } from '../state/access-store';
import { useAccountStore } from '../state/account-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProviderStore } from '../state/provider-store';
import { useSessionStateStore } from '../state/session-state-store';
import { PanePicker } from './PanePicker';
import { PaneToolbar } from './PaneToolbar';

/**
 * Bug "pane de navegador sobrepõe menus": a WebContentsView é irmã nativa do
 * renderer e pinta acima de qualquer DOM. Aqui os componentes REAIS (picker
 * "+ Pane", menu "Ações do painel", modal portalado) abrem sobre o host real do
 * navegador, e a prova é o que o Main recebe: `setBounds({ visible })`.
 * O jsdom não tem layout, então as caixas dos popovers são fixadas por classe.
 */

vi.mock('../orch/confirm-reopen-mission', () => ({ confirmAndReopenMission: vi.fn() }));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: vi.fn(), wakeHost: vi.fn(), respawnWithResume: vi.fn(), scrollPaneToBottom: vi.fn(),
  getPaneSessionId: vi.fn(() => null),
  repaintPaneTui: vi.fn(),
  onPaneSessionChange: vi.fn(() => () => {}),
}));
vi.mock('./settings/AccountsManager', () => ({ AccountsManager: () => null }));
vi.mock('./CostBadge', () => ({ CostBadge: () => null }));
vi.mock('./DevServerChip', () => ({ DevServerChip: () => null }));
vi.mock('./CommandBlockMenu', () => ({ CommandBlockMenu: () => null }));
vi.mock('./AgentAvatar', () => ({ AgentAvatar: () => null, resolveAgentCategory: () => undefined }));
vi.mock('./ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Rect = [left: number, top: number, width: number, height: number];

const rectOf = ([left, top, width, height]: Rect): DOMRect =>
  ({ left, top, right: left + width, bottom: top + height, x: left, y: top, width, height }) as DOMRect;

/** O navegador ocupa a coluna da direita; tudo o que abre à esquerda a cruza. */
const BROWSER_SLOT: Rect = [320, 80, 640, 480];
const NOT_PAINTED: Rect = [0, 0, 0, 0];

let popoverBoxes: Record<string, Rect>;
let paneToolbarMeasure!: (width: number) => void;
let root: Root | undefined;
let host: HTMLElement;
const setBounds = vi.fn();
const detachers: Array<() => void> = [];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount(node: ReactNode): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function browserView(paneId: string): () => unknown {
  const slot = document.createElement('div');
  slot.getBoundingClientRect = () => rectOf(BROWSER_SLOT);
  document.body.append(slot);
  detachers.push(attachBrowserPane({ id: paneId, kind: 'browser', title: 'Preview' } as PaneModel, slot, vi.fn()));
  return () => setBounds.mock.calls.filter(([id]) => id === paneId).at(-1)?.[1]?.visible;
}

beforeEach(() => {
  popoverBoxes = {};
  setBounds.mockReset();
  useAccessStore.setState({ canUseApp: true, maxAgents: null });
  useProviderStore.setState({ providers: [] } as never);
  useAccountStore.setState({ accounts: [] } as never);
  useOrchStore.setState({ missions: [], paneMissions: {} });
  useSessionStateStore.setState({ paneStates: new Map(), displayStates: new Map() });
  resetOverlayRootForTest();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      paneToolbarMeasure = (width) => callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const key = Object.keys(popoverBoxes).find((selector) => this.matches(selector));
    return rectOf(key ? popoverBoxes[key]! : NOT_PAINTED);
  });
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      browser: {
        create: vi.fn(async (paneId: string) => ({
          paneId, url: 'http://127.0.0.1:51201/', title: 'Preview',
          canGoBack: false, canGoForward: false, loading: false,
        })),
        setBounds,
        onState: vi.fn(() => () => {}),
        destroy: vi.fn(),
      },
    },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  for (const detach of detachers.splice(0)) detach();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'nexus');
});

describe('o pane de navegador respeita popovers, menus e modais abertos', () => {
  it('esconde a view sob o picker "+ Pane" e a devolve quando ele fecha', async () => {
    popoverBoxes['.pane-picker__panel'] = [200, 60, 348, 420];
    const visible = browserView('browser-plus');
    mount(<PanePicker />);
    await flush();
    expect(visible()).toBe(true);

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="pane-picker-trigger"]')!.click());
    await flush();
    expect(document.querySelector('.pane-picker__panel[role="dialog"]')).not.toBeNull();
    expect(visible()).toBe(false);

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await flush();
    expect(document.querySelector('.pane-picker__panel')).toBeNull();
    expect(visible()).toBe(true);
  });

  it('não apaga a página quando o picker abre longe dela', async () => {
    popoverBoxes['.pane-picker__panel'] = [10, 60, 280, 420];
    const visible = browserView('browser-plus-away');
    mount(<PanePicker />);
    await flush();

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="pane-picker-trigger"]')!.click());
    // Espera os quadros reais (rAF) do attach: um sync tardio também não pode esconder.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(document.querySelector('.pane-picker__panel')).not.toBeNull();
    expect(visible()).toBe(true);
    expect(setBounds.mock.calls.filter(([, bounds]) => bounds.visible === false)).toEqual([]);
  });

  it('esconde a view sob o menu "Ações do painel" do próprio pane e a devolve ao fechar', async () => {
    popoverBoxes['.toolbar__menu'] = [560, 44, 320, 380];
    const pane: PaneModel = { id: 'browser-menu', kind: 'browser', title: 'Preview', browserUrl: 'http://127.0.0.1:51201/' };
    useLayoutStore.setState({ root: buildGridTree([pane]), focusedPaneId: pane.id, maximizedPaneId: null });
    const visible = browserView('browser-menu');
    mount(<PaneToolbar pane={pane} isFocused />);
    act(() => paneToolbarMeasure(120));
    await flush();
    expect(visible()).toBe(true);

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Mais ações do pane"]')!;
    act(() => trigger.click());
    await flush();
    expect(document.querySelector('.toolbar__menu[role="menu"]')).not.toBeNull();
    expect(visible()).toBe(false);

    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await flush();
    expect(document.querySelector('.toolbar__menu')).toBeNull();
    expect(visible()).toBe(true);
  });

  it('esconde a view sob um modal portalado na camada de overlay, onde quer que ele esteja', async () => {
    popoverBoxes['[data-testid="modal"]'] = [0, 0, 120, 60];
    const visible = browserView('browser-modal');
    mount(<></>);
    await flush();
    expect(visible()).toBe(true);

    act(() => root!.render(
      <OverlayLayer>
        <div role="dialog" aria-modal="true" aria-label="Atualização" data-testid="modal" />
      </OverlayLayer>,
    ));
    await flush();
    expect(document.getElementById('nexus-overlay-root')?.querySelector('[data-testid="modal"]')).not.toBeNull();
    expect(visible()).toBe(false);

    act(() => root!.render(<OverlayLayer>{null}</OverlayLayer>));
    await flush();
    expect(visible()).toBe(true);
  });
});
