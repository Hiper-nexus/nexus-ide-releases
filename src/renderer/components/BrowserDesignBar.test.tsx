/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserDesignEventPayload } from '../../shared/types';
import type { BrowserDesignElementContext } from '../../shared/browser-design';
const hostStubs = vi.hoisted(() => ({
  setBrowserViewportOverride: vi.fn(),
  getBrowserViewportOverride: vi.fn(() => null),
}));
vi.mock('../browser/browser-host', () => hostStubs);

import { BrowserDesignBar } from './BrowserDesignBar';
import { useDesignSelectionStore } from '../state/design-selection-store';
import { useLayoutStore } from '../state/layout-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const PANE_ID = 'pane-browser';

const SELECTION: BrowserDesignElementContext = {
  ref: 'e1',
  tag: 'button',
  id: 'save',
  classes: ['btn-primary'],
  selector: '#save',
  rect: { x: 1, y: 2, width: 30, height: 10 },
  text: 'Salvar',
  outerHtml: '<button id="save">Salvar</button>',
  attributes: {},
  computedStyles: {},
  url: 'http://localhost:5173/',
};

let designEventCb: ((payload: BrowserDesignEventPayload) => void) | null = null;
let setDesignMode: ReturnType<typeof vi.fn>;
let sendDesignSelection: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

function setNexusMock(): void {
  setDesignMode = vi.fn(async (_paneId: string, active: boolean) => ({
    paneId: PANE_ID,
    active,
  }));
  sendDesignSelection = vi.fn(async () => ({
    ok: true,
    targetPaneId: 'pane-cli',
    targetSessionId: 'sess-1',
    promptChars: 100,
  }));
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      browser: {
        setDesignMode,
        sendDesignSelection,
        onDesignEvent: (cb: (payload: BrowserDesignEventPayload) => void) => {
          designEventCb = cb;
          return () => {
            if (designEventCb === cb) designEventCb = null;
          };
        },
      },
      layout: { save: vi.fn(), load: vi.fn() },
    },
  });
}

function render(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<BrowserDesignBar paneId={PANE_ID} />);
  });
}

function emit(payload: BrowserDesignEventPayload): void {
  act(() => {
    // The App-level bridge feeds the store; tests feed it directly.
    useDesignSelectionStore.getState().applyEvent(payload);
  });
}

function modeEvent(active: boolean): BrowserDesignEventPayload {
  return {
    paneId: PANE_ID,
    event: {
      eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e60',
      generation: '6e8a1b53-0f9c-4a2d-9e8f-1a2b3c4d5e6f',
      type: 'mode',
      at: 1,
      mode: { active, reason: active ? 'enable' : 'disable' },
    },
  };
}

function selectionEvent(): BrowserDesignEventPayload {
  return {
    paneId: PANE_ID,
    event: {
      eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e61',
      generation: '6e8a1b53-0f9c-4a2d-9e8f-1a2b3c4d5e6f',
      type: 'selection',
      at: 2,
      selection: SELECTION,
    },
  };
}

beforeEach(() => {
  setNexusMock();
  useDesignSelectionStore.getState().reset();
  useLayoutStore.getState().setPanes([
    { id: 'pane-cli', kind: 'cli-agent', title: 'claude', adapterId: 'claude' },
    { id: PANE_ID, kind: 'browser', title: 'browser' },
  ]);
  render();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  designEventCb = null;
});

function toggleButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[data-testid="design-toggle"]',
  );
  expect(button).not.toBeNull();
  return button!;
}

describe('BrowserDesignBar', () => {
  it('renders the design toggle off, without selection UI', () => {
    expect(toggleButton().getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-testid="design-send"]')).toBeNull();
  });

  it('toggles design mode via IPC and mirrors picker state from events', async () => {
    await act(async () => {
      toggleButton().click();
    });
    expect(setDesignMode).toHaveBeenCalledWith(PANE_ID, true);

    emit(modeEvent(true));
    expect(toggleButton().getAttribute('aria-pressed')).toBe('true');

    // Escape inside the page disables the picker → mode event false.
    emit(modeEvent(false));
    expect(toggleButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('ignores events from other panes', () => {
    emit({ ...modeEvent(true), paneId: 'other-pane' });
    expect(toggleButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the selection and sends it to the chosen agent pane', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());

    expect(container.textContent).toContain('button#save');
    const input = container.querySelector<HTMLInputElement>(
      'input[data-testid="design-instruction"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(input, 'deixa esse botão verde');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    const send = container.querySelector<HTMLButtonElement>(
      'button[data-testid="design-send"]',
    )!;
    await act(async () => {
      send.click();
    });
    expect(sendDesignSelection).toHaveBeenCalledWith(PANE_ID, {
      targetPaneId: 'pane-cli',
      instruction: 'deixa esse botão verde',
    });
  });

  it('clears the selection when design mode turns off', () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    expect(container.querySelector('[data-testid="design-send"]')).not.toBeNull();
    emit(modeEvent(false));
    expect(container.querySelector('[data-testid="design-send"]')).toBeNull();
  });

  it('multi-selection shows a count badge and sends all elements (F4)', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    emit({
      paneId: PANE_ID,
      event: {
        eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e62',
        generation: '6e8a1b53-0f9c-4a2d-9e8f-1a2b3c4d5e6f',
        type: 'selection',
        at: 3,
        selection: { ...SELECTION, ref: 'e2', selector: '.lead', additive: true },
      },
    });
    expect(container.querySelector('[data-testid=design-multi-badge]')?.textContent)
      .toContain('2');
  });

  it('clone button forwards the selection with the clone intent (F4)', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    const clone = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-clone]',
    )!;
    await act(async () => {
      clone.click();
    });
    expect(sendDesignSelection).toHaveBeenCalledWith(PANE_ID, {
      targetPaneId: 'pane-cli',
      intent: 'clone',
    });
  });

  it('breakpoint buttons override the viewport width (F4)', async () => {
    emit(modeEvent(true));
    const bp = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-bp-375]',
    )!;
    await act(async () => {
      bp.click();
    });
    expect(hostStubs.setBrowserViewportOverride).toHaveBeenCalledWith(PANE_ID, 375);
    const full = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-bp-full]',
    )!;
    await act(async () => {
      full.click();
    });
    expect(hostStubs.setBrowserViewportOverride).toHaveBeenCalledWith(PANE_ID, null);
  });

  it('disables sending when no agent pane exists', () => {
    act(() => {
      useLayoutStore.getState().setPanes([
        { id: PANE_ID, kind: 'browser', title: 'browser' },
      ]);
    });
    emit(modeEvent(true));
    emit(selectionEvent());
    const send = container.querySelector<HTMLButtonElement>(
      'button[data-testid="design-send"]',
    )!;
    expect(send.disabled).toBe(true);
  });
});
