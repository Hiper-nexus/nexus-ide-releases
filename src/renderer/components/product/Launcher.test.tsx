/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Launcher } from './Launcher';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});
function setup() {
  const handlers = {
    onOpenWorkspace: vi.fn(),
    onStartMission: vi.fn(),
    onOpenPane: vi.fn(),
    onOpenShellTerminal: vi.fn(),
    onOpenTaskBoard: vi.fn(),
    onOpenMemory: vi.fn(),
    onOpenProviders: vi.fn(),
  };
  return { host: render(<Launcher {...handlers} />), handlers };
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) =>
      b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
describe('Launcher onboarding', () => {
  it('explains the first project and gives one clear AI starting action', () => {
    const { host, handlers } = setup();
    expect(host.querySelector('h1')?.textContent).toBe(
      'O que você quer criar?',
    );
    expect(host.textContent).toContain('site, aplicativo');
    act(() => button(host, 'Criar com IA').click());
    expect(handlers.onStartMission).toHaveBeenCalledOnce();
    expect(handlers.onOpenPane).not.toHaveBeenCalled();
    expect(handlers.onOpenWorkspace).not.toHaveBeenCalled();
  });
  it('explains three real steps and provides an actionable AI setup shortcut', () => {
    const { host, handlers } = setup();
    expect(host.querySelectorAll('.launcher__steps > li')).toHaveLength(3);
    expect(host.textContent).toContain('Conte sua ideia');
    expect(host.textContent).toContain('Prepare o projeto');
    expect(host.textContent).toContain('Acompanhe e revise');
    act(() => button(host, 'Conectar uma IA').click());
    expect(handlers.onOpenProviders).toHaveBeenCalledOnce();
    expect(handlers.onStartMission).not.toHaveBeenCalled();
  });
  it('keeps project and terminal shortcuts available without completing a tour', () => {
    const { host, handlers } = setup();
    for (const [label, handler] of [
      ['Abrir projeto existente', handlers.onOpenWorkspace],
      ['Montar meus terminais', handlers.onOpenPane],
      ['Abrir terminal sem IA', handlers.onOpenShellTerminal],
    ] as const) {
      act(() => button(host, label).click());
      expect(handler).toHaveBeenCalledOnce();
    }
  });
  it('shows the task-board shortcut and runs it from the window', () => {
    const { host, handlers } = setup();
    const board = host.querySelector<HTMLButtonElement>(
      '[data-launcher-action="tasks"]',
    );
    expect(board?.querySelector('kbd')?.textContent).toBe('5');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }));
    });
    expect(handlers.onOpenTaskBoard).toHaveBeenCalledOnce();
  });
  it('ignores launcher digits when a modifier is held or the target is editable', () => {
    const { host, handlers } = setup();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true }),
      );
    });
    expect(handlers.onOpenPane).not.toHaveBeenCalled();
    const input = document.createElement('input');
    host.appendChild(input);
    const select = document.createElement('select');
    host.appendChild(select);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
      select.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    });
    expect(handlers.onOpenPane).not.toHaveBeenCalled();
    act(() => {
      select.blur();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    });
    expect(handlers.onOpenPane).toHaveBeenCalledOnce();
  });
  it('keeps organization tools under an optional disclosure and preserves their routes', () => {
    const { host, handlers } = setup();
    const details = host.querySelector('details');
    expect(details?.open).toBe(false);
    act(() => details!.querySelector('summary')!.click());
    expect(details?.open).toBe(true);
    act(() => button(host, 'Abrir Quadro de tarefas').click());
    act(() => button(host, 'Abrir Memória do projeto').click());
    expect(handlers.onOpenTaskBoard).toHaveBeenCalledOnce();
    expect(handlers.onOpenMemory).toHaveBeenCalledOnce();
  });
  it('uses keyboard reachable controls and avoids orchestration jargon', () => {
    const { host } = setup();
    const primary = button(host, 'Criar com IA');
    primary.focus();
    expect(document.activeElement).toBe(primary);
    expect(host.textContent).not.toMatch(
      /\b(?:Autopilot|Squad|PRD|orquestrador|worker|provider|XP|handoff)\b/i,
    );
  });
});


describe('Launcher rendered shortcuts', () => {
  it.each([
    ['1', 'onOpenPane'], ['2', 'onStartMission'], ['3', 'onOpenWorkspace'],
    ['4', 'onOpenShellTerminal'], ['5', 'onOpenTaskBoard'], ['6', 'onOpenMemory'],
  ] as const)('routes key %s to %s from a focused launcher button', (key, handler) => {
    const { host, handlers } = setup();
    const focused = button(host, 'Criar com IA');
    focused.focus();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => focused.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(handlers[handler]).toHaveBeenCalledOnce();
    for (const [name, callback] of Object.entries(handlers)) {
      if (name !== handler) expect(callback).not.toHaveBeenCalled();
    }
  });

  it.each(['input', 'textarea', 'contenteditable'] as const)(
    'leaves number keys in an editable %s untouched', (kind) => {
      const { host, handlers } = setup();
      const editor = document.createElement(kind === 'contenteditable' ? 'div' : kind);
      if (kind === 'contenteditable') {
        editor.setAttribute('contenteditable', 'true');
        // jsdom does not implement the browser's inherited isContentEditable property.
        Object.defineProperty(editor, 'isContentEditable', { value: true });
      }
      host.querySelector('.launcher')!.appendChild(editor);
      editor.focus();
      for (const key of ['1', '2', '3', '4', '5', '6']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        act(() => editor.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
      }
      for (const callback of Object.values(handlers)) expect(callback).not.toHaveBeenCalled();
    },
  );

  it('shows a shortcut hint on every rendered launcher action', () => {
    const { host } = setup();
    for (const [id, shortcut] of [
      ['pane', '1'], ['mission', '2'], ['workspace', '3'],
      ['shell', '4'], ['tasks', '5'], ['memory', '6'],
    ]) {
      const action = host.querySelector(`[data-launcher-action="${id}"]`);
      expect(action?.querySelector('kbd')?.textContent, id).toBe(shortcut);
    }
  });
});
