/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UI_SETTINGS, type UiSettings } from '../../../shared/settings-types';
import { useSettingsStore } from '../../state/settings-store';
import { KeybindingsEditor } from './KeybindingsSettings';

vi.mock('../../terminal/terminal-host', () => ({ applyTerminalSettings: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const originalNexus = Object.getOwnPropertyDescriptor(window, 'nexus');
let root: Root | null = null;
let uiSet: ReturnType<typeof vi.fn>;

beforeEach(() => {
  let ui: UiSettings = { ...DEFAULT_UI_SETTINGS, keybindings: {} };
  uiSet = vi.fn(async (patch: Partial<UiSettings>) => {
    ui = { ...ui, ...patch };
    return ui;
  });
  // Sem `platform`: Linux/Windows — Mod é Ctrl.
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: { settings: { uiSet } },
  });
  useSettingsStore.setState({ ui });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  if (originalNexus) Object.defineProperty(window, 'nexus', originalNexus);
  else Reflect.deleteProperty(window, 'nexus');
});

function render(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<KeybindingsEditor />));
  return host;
}

function row(host: HTMLElement, command: string): HTMLElement {
  return host.querySelector<HTMLElement>(`[data-command="${command}"]`)!;
}

function button(scope: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found;
}

function pressOnCapture(scope: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const capture = scope.querySelector<HTMLButtonElement>('.keybinding-row__capture')!;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    capture.dispatchEvent(event);
  });
  return event;
}

describe('Configurações › Atalhos', () => {
  it('mostra os padrões de hoje', () => {
    const host = render();
    expect(row(host, 'mission-new').querySelector('kbd')?.textContent).toBe('Ctrl+N');
    expect(row(host, 'focus-pane-n').querySelector('kbd')?.textContent).toBe('Ctrl+1-9');
  });

  it('grava, avisa o conflito e salva o novo atalho', async () => {
    const host = render();
    act(() => button(row(host, 'mission-new'), 'Alterar').click());
    expect(document.activeElement?.className).toContain('keybinding-row__capture');

    // A tecla gravada não vaza para o atalho global (defaultPrevented + stop).
    const pressed = pressOnCapture(row(host, 'mission-new'), {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
    });
    expect(pressed.defaultPrevented).toBe(true);
    expect(row(host, 'mission-new').querySelector('kbd')?.textContent).toBe('Ctrl+K');
    // Teclado continua na linha: o foco cai em Salvar, não no <body>.
    expect(document.activeElement?.textContent).toBe('Salvar');
    expect(row(host, 'mission-new').textContent).toContain(
      'Conflita com Buscar terminais, missões e ações',
    );

    await act(async () => button(row(host, 'mission-new'), 'Salvar').click());
    expect(uiSet).toHaveBeenCalledWith({ keybindings: { 'mission-new': ['Mod+K'] } });
    expect(useSettingsStore.getState().ui.keybindings).toEqual({
      'mission-new': ['Mod+K'],
    });
  });

  it('recusa combinação inválida sem oferecer Salvar', () => {
    const host = render();
    act(() => button(row(host, 'task-board'), 'Alterar').click());
    pressOnCapture(row(host, 'task-board'), { key: 'b', code: 'KeyB' });
    expect(row(host, 'task-board').querySelector('[role="alert"]')?.textContent).toMatch(
      /Ctrl/,
    );
    expect(
      Array.from(row(host, 'task-board').querySelectorAll('button')).some((item) =>
        item.textContent?.includes('Salvar'),
      ),
    ).toBe(false);

    act(() => button(row(host, 'task-board'), 'Tentar de novo').click());
    pressOnCapture(row(host, 'task-board'), { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(row(host, 'task-board').textContent).toContain('Reservado: copiar.');
  });

  it('modificador sozinho e IME não terminam a gravação; Esc cancela', () => {
    const host = render();
    act(() => button(row(host, 'cheatsheet'), 'Alterar').click());
    pressOnCapture(row(host, 'cheatsheet'), { key: 'Control', ctrlKey: true });
    pressOnCapture(row(host, 'cheatsheet'), { key: 'a', ctrlKey: true, isComposing: true });
    expect(row(host, 'cheatsheet').querySelector('.keybinding-row__capture')).not.toBeNull();
    pressOnCapture(row(host, 'cheatsheet'), { key: 'Escape' });
    expect(row(host, 'cheatsheet').querySelector('.keybinding-row__capture')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Alterar');
    expect(uiSet).not.toHaveBeenCalled();
  });

  it('restaura o padrão de um comando e de todos', async () => {
    act(() =>
      useSettingsStore.setState({
        ui: {
          ...DEFAULT_UI_SETTINGS,
          keybindings: { 'mission-new': ['Mod+Alt+N'], settings: [] },
        },
      }),
    );
    const host = render();
    expect(row(host, 'settings').textContent).toContain('Sem atalho');

    await act(async () => button(row(host, 'mission-new'), 'Restaurar padrão').click());
    expect(uiSet).toHaveBeenLastCalledWith({ keybindings: { settings: [] } });

    await act(async () => button(host, 'Restaurar todos os padrões').click());
    expect(uiSet).toHaveBeenLastCalledWith({ keybindings: {} });
    expect(row(host, 'settings').querySelector('kbd')?.textContent).toBe('Ctrl+,');
  });
});
