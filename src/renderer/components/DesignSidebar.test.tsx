/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserDesignElementContext } from '../../shared/browser-design';
import { DesignSidebar } from './DesignSidebar';
import { useDesignSelectionStore } from '../state/design-selection-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const PANE_ID = 'pane-browser';

const SELECTION: BrowserDesignElementContext = {
  ref: 'e1',
  tag: 'button',
  id: 'save',
  classes: ['btn'],
  selector: '#save',
  rect: { x: 0, y: 0, width: 10, height: 10 },
  text: 'Salvar',
  outerHtml: '<button id="save">Salvar</button>',
  attributes: {},
  computedStyles: {
    'padding-top': '10px',
    'font-size': '15px',
    color: 'rgb(255, 255, 255)',
    'background-color': 'rgb(47, 106, 224)',
  },
  url: 'http://localhost:5173/',
};

let setStylePreview: ReturnType<typeof vi.fn>;
let clearStylePreview: ReturnType<typeof vi.fn>;
let sendDesignSelection: ReturnType<typeof vi.fn>;
let designApi: {
  status: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
  redo: ReturnType<typeof vi.fn>;
};
let container: HTMLDivElement;
let root: Root;

function emitSelection(): void {
  act(() => {
    useDesignSelectionStore.getState().applyEvent({
      paneId: PANE_ID,
      event: {
        eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e70',
        generation: '6e8a1b53-0f9c-4a2d-9e8f-1a2b3c4d5e6f',
        type: 'selection',
        at: 1,
        selection: SELECTION,
      },
    });
  });
}

function input(prop: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(
    `input[data-style-prop="${prop}"]`,
  );
  expect(el, `input for ${prop}`).not.toBeNull();
  return el!;
}

function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  setStylePreview = vi.fn(async () => ({}));
  clearStylePreview = vi.fn(async () => ({ cleared: 1 }));
  sendDesignSelection = vi.fn(async () => ({ ok: true }));
  designApi = {
    status: vi.fn(async () => ({
      enabled: false,
      active: false,
      styleMode: 'tailwind',
      canUndo: false,
      canRedo: false,
      authorityReady: true,
    })),
    start: vi.fn(async () => ({ ok: true, files: 1, elements: 1 })),
    stop: vi.fn(async () => ({ ok: true })),
    apply: vi.fn(async () => ({ ok: true, file: 'App.jsx', kind: 'style' })),
    undo: vi.fn(async () => ({ ok: true, file: 'App.jsx', kind: 'undo' })),
    redo: vi.fn(async () => null),
  };
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      browser: {
        // The App-level bridge normally feeds the store; tests feed it direct.
        onDesignEvent: () => () => {},
        setStylePreview,
        clearStylePreview,
        sendDesignSelection,
      },
      design: designApi,
      layout: { save: vi.fn(), load: vi.fn() },
    },
  });
  useLayoutStore.getState().setPanes([
    { id: 'pane-cli', kind: 'cli-agent', title: 'claude', adapterId: 'claude' },
    { id: PANE_ID, kind: 'browser', title: 'browser' },
  ]);
  useOrchStore.setState({ paneMissions: { 'pane-cli': 'mission-a' } });
  useDesignSelectionStore.getState().reset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<DesignSidebar paneId={PANE_ID} />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('DesignSidebar', () => {
  it('renders nothing without a selection', () => {
    expect(container.querySelector('.design-sidebar')).toBeNull();
  });

  it('populates editable fields from the selection computed styles', () => {
    emitSelection();
    expect(input('padding-top').value).toBe('10px');
    expect(input('font-size').value).toBe('15px');
    expect(input('background-color').value).toBe('rgb(47, 106, 224)');
  });

  it('shows the CURRENT selection when mounted after the selection happened', () => {
    emitSelection();
    // Sidebar opened via the ≡ toggle AFTER the user picked the element.
    const lateContainer = document.createElement('div');
    document.body.appendChild(lateContainer);
    const lateRoot = createRoot(lateContainer);
    act(() => {
      lateRoot.render(<DesignSidebar paneId={PANE_ID} />);
    });
    expect(
      lateContainer.querySelector<HTMLInputElement>('input[data-style-prop="padding-top"]')
        ?.value,
    ).toBe('10px');
    act(() => {
      lateRoot.unmount();
    });
    lateContainer.remove();
  });

  it('edits preview optimistically on commit (Enter/blur)', () => {
    emitSelection();
    const field = input('padding-top');
    setValue(field, '16px');
    act(() => {
      field.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    });
    expect(setStylePreview).toHaveBeenCalledWith(PANE_ID, '#save', {
      'padding-top': '16px',
    });
  });

  it('Aplicar sends the style diff to the agent pane', async () => {
    emitSelection();
    const field = input('background-color');
    setValue(field, '#16a34a');
    act(() => {
      field.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    });
    const apply = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-apply]',
    )!;
    expect(apply.disabled).toBe(false);
    await act(async () => {
      apply.click();
    });
    expect(sendDesignSelection).toHaveBeenCalledWith(PANE_ID, {
      targetPaneId: 'pane-cli',
      styleDiff: {
        'background-color': { from: 'rgb(47, 106, 224)', to: '#16a34a' },
      },
    });
  });

  it('write-back section stays hidden when the project has not opted in', async () => {
    emitSelection();
    await act(async () => {});
    expect(container.querySelector('[data-testid=design-apply-direct]')).toBeNull();
  });

  it('write-back active + tagged selection → direct apply and undo/redo controls', async () => {
    designApi.status = vi.fn(async () => ({
      enabled: true,
      active: true,
      styleMode: 'tailwind',
      canUndo: true,
      canRedo: false,
      authorityReady: true,
    }));
    act(() => {
      useDesignSelectionStore.getState().applyEvent({
        paneId: PANE_ID,
        event: {
          eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e71',
          generation: '6e8a1b53-0f9c-4a2d-9e8f-1a2b3c4d5e6f',
          type: 'selection',
          at: 2,
          selection: {
            ...SELECTION,
            attributes: { 'data-nexus-id': 'abc123' },
          },
        },
      });
    });
    await act(async () => {});

    const field = input('padding-top');
    setValue(field, '24px');
    act(() => {
      field.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    });

    const applyDirect = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-apply-direct]',
    );
    expect(applyDirect).not.toBeNull();
    await act(async () => {
      applyDirect!.click();
    });
    expect(designApi.apply).toHaveBeenCalledWith(
      {
        browserPaneId: PANE_ID,
        paneId: 'pane-cli',
        missionId: 'mission-a',
      },
      {
        kind: 'style',
        nexusId: 'abc123',
        styles: { 'padding-top': '24px' },
      },
    );

    const undoButton = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-undo]',
    )!;
    expect(undoButton.disabled).toBe(false);
    await act(async () => {
      undoButton.click();
    });
    expect(designApi.undo).toHaveBeenCalledWith({
      browserPaneId: PANE_ID,
      paneId: 'pane-cli',
      missionId: 'mission-a',
    });
  });

  it('disables direct effects without main-approved mission PREVC authority', async () => {
    designApi.status = vi.fn(async () => ({
      enabled: true,
      active: false,
      styleMode: 'tailwind',
      canUndo: false,
      canRedo: false,
      authorityReady: false,
      authorityError: 'workflow stage review',
    }));
    useOrchStore.setState({ paneMissions: {} });
    emitSelection();
    await act(async () => {});

    const start = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-wb-start]',
    );
    expect(start?.disabled).toBe(true);
    expect(designApi.start).not.toHaveBeenCalled();
  });

  it('Reverter clears the preview and the pending diff', async () => {
    emitSelection();
    const field = input('padding-top');
    setValue(field, '20px');
    act(() => {
      field.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    });
    const revert = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-revert]',
    )!;
    await act(async () => {
      revert.click();
    });
    expect(clearStylePreview).toHaveBeenCalledWith(PANE_ID, '#save');
    expect(input('padding-top').value).toBe('10px');
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid=design-apply]')!
        .disabled,
    ).toBe(true);
  });
});
