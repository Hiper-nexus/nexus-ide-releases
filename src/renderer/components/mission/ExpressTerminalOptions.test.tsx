/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useTerminalGridDialogStore } from '../../state/terminal-grid-dialog-store';
import { ExpressTerminalOptions } from './ExpressTerminalOptions';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = '';
});

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(<ExpressTerminalOptions />);
  });
  return host;
}

function buttonWith(host: HTMLElement, text: string): HTMLButtonElement {
  const match = [...host.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes(text),
  );
  if (!match) throw new Error(`sem botão contendo "${text}"`);
  return match as HTMLButtonElement;
}

describe('ExpressTerminalOptions', () => {
  beforeEach(() => {
    useTerminalGridDialogStore.setState({ isOpen: false, options: {} });
  });

  it('ensina o caminho manual e oferece as duas portas', () => {
    const host = mount();
    expect(host.textContent).toContain('Prefere trabalhar nos terminais?');
    expect(buttonWith(host, 'Montar meus terminais')).toBeTruthy();
    expect(buttonWith(host, 'Terminal sem IA')).toBeTruthy();
  });

  it('"Montar meus terminais" abre o assistente que escolhe pasta, quantidade e IAs', () => {
    const host = mount();
    const open = vi.spyOn(useTerminalGridDialogStore.getState(), 'open');

    act(() => buttonWith(host, 'Montar meus terminais').click());

    // O diálogo já cuida de pasta/quantidade/IA por painel, do limite e da
    // navegação — a tela de criação só abre a porta.
    expect(open).toHaveBeenCalledWith({ initialCount: 2 });
  });

  it('"Terminal sem IA" navega para os terminais E cria o pane', () => {
    const host = mount();
    const openTerminal = vi.spyOn(
      useProductNavigationStore.getState(),
      'openTerminal',
    );
    const addShellPane = vi.spyOn(useLayoutStore.getState(), 'addShellPane');

    act(() => buttonWith(host, 'Terminal sem IA').click());

    // Navegar sozinho só revela a superfície, sem criar pane; criar sem
    // navegar faz o pane nascer invisível. Os dois, na ordem.
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(addShellPane).toHaveBeenCalledTimes(1);
    expect(openTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      addShellPane.mock.invocationCallOrder[0]!,
    );
  });

  it('mostra o atalho e abre o quadro a partir do cartão de tarefas', () => {
    const host = mount();
    expect(
      host.querySelector('[data-launcher-action="pane"] kbd')?.textContent,
    ).toBe('1');
    expect(
      host.querySelector('[data-launcher-action="shell"] kbd')?.textContent,
    ).toBe('4');
    const openTaskBoard = vi.spyOn(
      useProductNavigationStore.getState(),
      'openTaskBoard',
    );
    act(() => buttonWith(host, 'Quadro de tarefas').click());
    expect(openTaskBoard).toHaveBeenCalledTimes(1);
  });

  it('os cartões são alvos secundários confortáveis (≥32px) com nome acessível', () => {
    const host = mount();
    for (const label of ['Montar meus terminais', 'Terminal sem IA']) {
      const button = buttonWith(host, label);
      expect(button.className).toContain('action-card');
      // Secundário da tela: nunca o CTA primário nem o acento de estado.
      expect(button.className).toContain('action-card--ghost');
      expect(button.getAttribute('aria-label') ?? button.textContent).toContain(
        label,
      );
    }
  });
});
