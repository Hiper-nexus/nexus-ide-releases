/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrchestrationModeDialog } from './OrchestrationModeDialog';
import {
  useOrchestrationModeStore,
  type OrchestrationModeRequest,
  type PromoteOrchestrationDecision,
} from '../state/orchestration-mode-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

const BASE_REQUEST: OrchestrationModeRequest = {
  title: 'Executar plano',
  body: 'Escolha como esta missão deve sair do plano para a execução.',
  storyCount: 3,
  recommended: 'pack',
  templateRequiredForPack: false,
};

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

function renderWithInvoker(): HTMLButtonElement {
  const host = render(
    <>
      <button type="button">Executar plano da missão</button>
      <OrchestrationModeDialog />
    </>,
  );
  const invoker = host.querySelector<HTMLButtonElement>('button');
  if (!invoker) throw new Error('Mode dialog invoker was not rendered');
  return invoker;
}

function ask(
  overrides: Partial<OrchestrationModeRequest> = {},
): Promise<PromoteOrchestrationDecision | null> {
  let decision!: Promise<PromoteOrchestrationDecision | null>;
  act(() => {
    decision = useOrchestrationModeStore.getState().ask({
      ...BASE_REQUEST,
      ...overrides,
    });
  });
  return decision;
}

function currentDialog(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-modal="true"]',
  );
  if (!dialog) throw new Error('Orchestration mode dialog was not rendered');
  return dialog;
}

function buttonIn(dialog: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(
    dialog.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Dialog button was not rendered: ${label}`);
  return button;
}

function referencedText(element: HTMLElement, attribute: string): string {
  return (element.getAttribute(attribute) ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

// jsdom rewrites import.meta.url, so the stylesheets come from the vitest root.
const stylesDir = path.resolve(process.cwd(), 'src/renderer/styles');
const allCss = fs
  .readdirSync(stylesDir)
  .filter((file) => file.endsWith('.css'))
  .map((file) => fs.readFileSync(path.join(stylesDir, file), 'utf8'))
  .join('\n');

/** A class no stylesheet mentions leaves the native control: on Windows, the OS canvas. */
function hasCssRule(className: string): boolean {
  return new RegExp(`\\.${className}(?![\\w-])`).test(allCss);
}

function keydown(target: EventTarget, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  useOrchestrationModeStore.setState({ pending: null, queue: [] });
});

afterEach(() => {
  act(() => {
    const state = useOrchestrationModeStore.getState();
    if (state.pending) state.decide(null);
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe('OrchestrationModeDialog behavioral contract', () => {
  it('uses rendered title and description as its accessible name and moves initial focus to the recommendation', () => {
    const invoker = renderWithInvoker();
    invoker.focus();

    void ask();

    const dialog = currentDialog();
    expect(referencedText(dialog, 'aria-labelledby')).toBe(BASE_REQUEST.title);
    expect(referencedText(dialog, 'aria-describedby')).toBe(BASE_REQUEST.body);
    expect(document.activeElement).toBe(buttonIn(dialog, 'Wave Pack'));
  });

  it('traps forward and reverse Tab navigation across both choices, the Pack select, and cancel', () => {
    renderWithInvoker();
    void ask();

    const dialog = currentDialog();
    const pack = buttonIn(dialog, 'Wave Pack');
    const guided = buttonIn(dialog, 'Guiado');
    const select = dialog.querySelector<HTMLSelectElement>('select');
    const cancel = buttonIn(dialog, 'Cancelar');
    if (!select) throw new Error('Pack template select was not rendered');
    const focusables: HTMLElement[] = [pack, guided, select, cancel];

    for (const [index, element] of focusables.entries()) {
      element.focus();
      keydown(element, 'Tab');
      expect(document.activeElement).toBe(
        focusables[(index + 1) % focusables.length],
      );
    }

    for (const [index, element] of focusables.entries()) {
      element.focus();
      keydown(element, 'Tab', true);
      expect(document.activeElement).toBe(
        focusables[(index - 1 + focusables.length) % focusables.length],
      );
    }
  });

  it('lets native arrow-key input from the Pack select propagate without preventing it', () => {
    renderWithInvoker();
    void ask();

    const select = currentDialog().querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Pack template select was not rendered');
    let observedAtDocument = false;
    const observe = () => {
      observedAtDocument = true;
    };
    document.addEventListener('keydown', observe);

    select.focus();
    const event = keydown(select, 'ArrowDown');

    document.removeEventListener('keydown', observe);
    expect(event.defaultPrevented).toBe(false);
    expect(observedAtDocument).toBe(true);
    expect(document.activeElement).toBe(select);
  });

  it('styles the Pack template field it renders instead of leaving the native control', () => {
    renderWithInvoker();
    void ask();

    const select = currentDialog().querySelector<HTMLSelectElement>('select');
    const label = select?.closest('label');
    if (!select || !label) throw new Error('Pack template field was not rendered');
    for (const element of [label, select]) {
      for (const className of element.classList) {
        expect(hasCssRule(className), `.${className} has a stylesheet rule`).toBe(true);
      }
    }
  });

  it('resolves Pack, Guiado, and explicit cancel through the rendered controls', async () => {
    const invoker = renderWithInvoker();

    invoker.focus();
    const packDecision = ask({
      storyCount: 1,
      templateRequiredForPack: true,
    });
    const packDialog = currentDialog();
    const select = packDialog.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Pack template select was not rendered');
    act(() => {
      select.value = 'saas';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    let packResult: PromoteOrchestrationDecision | null | undefined;
    await act(async () => {
      buttonIn(packDialog, 'Wave Pack').click();
      packResult = await packDecision;
    });
    expect(packResult).toEqual({ mode: 'pack', wavePackTemplateId: 'saas' });
    expect(document.activeElement).toBe(invoker);

    invoker.focus();
    const guidedDecision = ask({ recommended: 'guided' });
    let guidedResult: PromoteOrchestrationDecision | null | undefined;
    await act(async () => {
      buttonIn(currentDialog(), 'Guiado').click();
      guidedResult = await guidedDecision;
    });
    expect(guidedResult).toEqual({ mode: 'guided' });
    expect(document.activeElement).toBe(invoker);

    invoker.focus();
    const cancelDecision = ask();
    let cancelResult: PromoteOrchestrationDecision | null | undefined;
    await act(async () => {
      buttonIn(currentDialog(), 'Cancelar').click();
      cancelResult = await cancelDecision;
    });
    expect(cancelResult).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it('cancels with Escape or backdrop click and restores focus to the invoking action', async () => {
    const invoker = renderWithInvoker();

    invoker.focus();
    const escapeDecision = ask();
    let escapeResult: PromoteOrchestrationDecision | null | undefined;
    await act(async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.activeElement?.dispatchEvent(event);
      escapeResult = await escapeDecision;
    });
    expect(escapeResult).toBeNull();
    expect(document.activeElement).toBe(invoker);

    invoker.focus();
    const backdropDecision = ask();
    const backdrop = currentDialog().querySelector<HTMLElement>(
      '.confirm__overlay',
    );
    if (!backdrop) throw new Error('Mode dialog backdrop was not rendered');
    let backdropResult: PromoteOrchestrationDecision | null | undefined;
    await act(async () => {
      backdrop.click();
      backdropResult = await backdropDecision;
    });
    expect(backdropResult).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});
