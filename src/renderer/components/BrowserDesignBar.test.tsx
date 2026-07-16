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
let setDeviceEmulation: ReturnType<typeof vi.fn>;
let sendDesignSelection: ReturnType<typeof vi.fn>;
let designAnnotate: ReturnType<typeof vi.fn>;
let listDesignAnnotations: ReturnType<typeof vi.fn>;
let deleteDesignAnnotation: ReturnType<typeof vi.fn>;
let clearDesignAnnotations: ReturnType<typeof vi.fn>;
let sendDesignAnnotations: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

/** Espelho main-side das anotações usado pelos mocks (fonte de verdade). */
let mockAnnotations: Array<{
  id: string;
  index: number;
  label: string;
  comment: string;
  intent: string;
  priority: string;
  createdAt: number;
}> = [];

function reindex(): void {
  mockAnnotations = mockAnnotations.map((annotation, i) => ({
    ...annotation,
    index: i + 1,
  }));
}

function setNexusMock(): void {
  mockAnnotations = [];
  setDesignMode = vi.fn(async (_paneId: string, active: boolean) => ({
    paneId: PANE_ID,
    active,
  }));
  setDeviceEmulation = vi.fn(async () => undefined);
  sendDesignSelection = vi.fn(async () => ({
    ok: true,
    targetPaneId: 'pane-cli',
    targetSessionId: 'sess-1',
    promptChars: 100,
  }));
  designAnnotate = vi.fn(
    async (_paneId: string, payload: { comment: string; intent: string }) => {
      mockAnnotations.push({
        id: `a${mockAnnotations.length + 1}`,
        index: mockAnnotations.length + 1,
        label: 'button#save "Salvar"',
        comment: payload.comment,
        intent: payload.intent,
        priority: 'suggestion',
        createdAt: 1,
      });
      return { paneId: PANE_ID, annotations: [...mockAnnotations] };
    },
  );
  listDesignAnnotations = vi.fn(async () => ({
    paneId: PANE_ID,
    annotations: [...mockAnnotations],
  }));
  deleteDesignAnnotation = vi.fn(async (_paneId: string, id: string) => {
    mockAnnotations = mockAnnotations.filter((a) => a.id !== id);
    reindex();
    return { paneId: PANE_ID, annotations: [...mockAnnotations] };
  });
  clearDesignAnnotations = vi.fn(async () => {
    mockAnnotations = [];
    return { paneId: PANE_ID, annotations: [] };
  });
  sendDesignAnnotations = vi.fn(async () => ({
    ok: true,
    targetPaneId: 'pane-cli',
    targetSessionId: 'sess-1',
    promptChars: 500,
    annotations: mockAnnotations.length,
  }));
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      browser: {
        setDesignMode,
        setDeviceEmulation,
        sendDesignSelection,
        designAnnotate,
        listDesignAnnotations,
        deleteDesignAnnotation,
        clearDesignAnnotations,
        sendDesignAnnotations,
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

beforeEach(async () => {
  setNexusMock();
  useDesignSelectionStore.getState().reset();
  useLayoutStore.getState().setPanes([
    { id: 'pane-cli', kind: 'cli-agent', title: 'claude', adapterId: 'claude' },
    { id: PANE_ID, kind: 'browser', title: 'browser' },
  ]);
  render();
  // Deixa a hidratação de anotações do mount (listDesignAnnotations) assentar.
  await act(async () => {});
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
    expect(setDeviceEmulation).toHaveBeenCalledWith(PANE_ID, 375);
    const full = container.querySelector<HTMLButtonElement>(
      '[data-testid=design-bp-full]',
    )!;
    await act(async () => {
      full.click();
    });
    expect(hostStubs.setBrowserViewportOverride).toHaveBeenCalledWith(PANE_ID, null);
    expect(setDeviceEmulation).toHaveBeenCalledWith(PANE_ID, null);
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

describe('BrowserDesignBar — anotações (paridade Orca)', () => {
  function setFieldValue(
    element: HTMLInputElement | HTMLSelectElement,
    value: string,
    eventName: 'input' | 'change',
  ): void {
    const proto =
      element instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    act(() => {
      setter.call(element, value);
      element.dispatchEvent(new window.Event(eventName, { bubbles: true }));
    });
  }

  function openComposer(): void {
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-annotate"]',
    )!;
    if (toggle.getAttribute('aria-pressed') !== 'true') {
      act(() => {
        toggle.click();
      });
    }
  }

  function typeComment(text: string): void {
    openComposer();
    setFieldValue(
      container.querySelector<HTMLInputElement>(
        'input[data-testid="design-annotation-comment"]',
      )!,
      text,
      'input',
    );
  }

  async function annotate(comment: string, intent = 'fix'): Promise<void> {
    typeComment(comment);
    if (intent !== 'fix') {
      setFieldValue(
        container.querySelector<HTMLSelectElement>(
          '[data-testid="design-annotation-intent"]',
        )!,
        intent,
        'change',
      );
    }
    const add = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-annotation-add"]',
    )!;
    await act(async () => {
      add.click();
    });
  }

  it('anota a seleção corrente com comentário + intenção e abre o tray', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    await annotate('aumentar o contraste', 'change');

    expect(designAnnotate).toHaveBeenCalledWith(PANE_ID, {
      comment: 'aumentar o contraste',
      intent: 'change',
    });
    const badge = container.querySelector('[data-testid="design-annotations-badge"]')!;
    expect(badge.textContent).toContain('1');
    const tray = container.querySelector('[data-testid="design-annotations-tray"]')!;
    expect(tray.textContent).toContain('aumentar o contraste');
    expect(tray.textContent).toContain('[mudar]');
    // O campo do composer limpa após anotar (pronto para a próxima nota).
    expect(
      container.querySelector<HTMLInputElement>(
        'input[data-testid="design-annotation-comment"]',
      )!.value,
    ).toBe('');
  });

  it('Enter no composer ANOTA — nunca dispara o envio pro agente', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    typeComment('esse botão deveria ser secundário?');
    const comment = container.querySelector<HTMLInputElement>(
      'input[data-testid="design-annotation-comment"]',
    )!;
    await act(async () => {
      comment.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(designAnnotate).toHaveBeenCalledWith(PANE_ID, {
      comment: 'esse botão deveria ser secundário?',
      intent: 'fix',
    });
    // O gesto de confirmar o comentário JAMAIS injeta prompt no agente.
    expect(sendDesignSelection).not.toHaveBeenCalled();
  });

  it('recusa anotar sem comentário (status orienta o usuário)', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    openComposer();
    const add = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-annotation-add"]',
    )!;
    await act(async () => {
      add.click();
    });
    expect(designAnnotate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('escreva o comentário');
  });

  it('anotações sobrevivem ao modo Design off; enviar em lote usa o pane alvo', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    await annotate('primeira nota');
    emit(modeEvent(false));

    // Badge continua visível com o picker desligado.
    const badge = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-annotations-badge"]',
    )!;
    expect(badge.textContent).toContain('1');

    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-annotations-send"]',
    )!;
    await act(async () => {
      send.click();
    });
    expect(sendDesignAnnotations).toHaveBeenCalledWith(PANE_ID, {
      targetPaneId: 'pane-cli',
    });
    expect(container.textContent).toContain('feedback enviado (1) ✓');
  });

  it('copiar feedback funciona SEM nenhum pane de agente (dryRun sem alvo)', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    await annotate('nota para copiar');
    // Remove o único agente do layout: copiar continua habilitado.
    act(() => {
      useLayoutStore.getState().setPanes([
        { id: PANE_ID, kind: 'browser', title: 'browser' },
      ]);
    });
    sendDesignAnnotations.mockResolvedValueOnce({
      ok: true,
      targetPaneId: '',
      targetSessionId: '',
      promptChars: 320,
      annotations: 1,
      prompt: 'BEGIN_UNTRUSTED_PAGE_DATA…',
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const copy = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-annotations-copy"]',
    )!;
    expect(copy.disabled).toBe(false);
    await act(async () => {
      copy.click();
    });
    expect(sendDesignAnnotations).toHaveBeenCalledWith(PANE_ID, {
      dryRun: true,
    });
    expect(writeText).toHaveBeenCalled();
  });

  it('excluir e limpar atualizam a lista pela resposta do main', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    await annotate('primeira');
    await annotate('segunda');
    expect(
      container.querySelector('[data-testid="design-annotations-badge"]')!
        .textContent,
    ).toContain('2');

    const del = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-annotation-delete-1"]',
    )!;
    await act(async () => {
      del.click();
    });
    expect(deleteDesignAnnotation).toHaveBeenCalledWith(PANE_ID, 'a1');
    expect(
      container.querySelector('[data-testid="design-annotations-badge"]')!
        .textContent,
    ).toContain('1');

    const clear = container.querySelector<HTMLButtonElement>(
      '[data-testid="design-annotations-clear"]',
    )!;
    await act(async () => {
      clear.click();
    });
    expect(clearDesignAnnotations).toHaveBeenCalledWith(PANE_ID);
    expect(
      container.querySelector('[data-testid="design-annotations-badge"]'),
    ).toBeNull();
  });

  it('navegação (mode reason=navigation) limpa as anotações no renderer', async () => {
    emit(modeEvent(true));
    emit(selectionEvent());
    await annotate('nota que morre com o documento');
    emit({
      paneId: PANE_ID,
      event: {
        eventId: '7f9b2c64-1a2b-4c3d-8e9f-0a1b2c3d4e70',
        generation: '7f9b2c64-1a0d-4b3e-8f90-2b3c4d5e6f70',
        type: 'mode',
        at: 9,
        mode: { active: false, reason: 'navigation' },
      },
    });
    expect(
      container.querySelector('[data-testid="design-annotations-badge"]'),
    ).toBeNull();
  });

  it('hidrata a lista do main ao montar (anotações persistem a remount)', async () => {
    mockAnnotations.push({
      id: 'a9',
      index: 1,
      label: 'div.card',
      comment: 'nota persistida',
      intent: 'fix',
      priority: 'suggestion',
      createdAt: 1,
    });
    act(() => {
      root.unmount();
    });
    container.remove();
    render();
    await act(async () => {});
    expect(listDesignAnnotations).toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="design-annotations-badge"]')!
        .textContent,
    ).toContain('1');
  });
});
