/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalGridDialog } from './TerminalGridDialog';
import { useTerminalGridDialogStore } from '../state/terminal-grid-dialog-store';
import { useLayoutStore } from '../state/layout-store';
import { useProductNavigationStore } from '../state/product-navigation-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

describe('TerminalGridDialog', () => {
  beforeEach(() => {
    useTerminalGridDialogStore.getState().close();
  });

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      act(() => root?.unmount());
    }
    document.body.innerHTML = '';
  });

  it('não renderiza quando isOpen é false', () => {
    const host = render(<TerminalGridDialog />);
    expect(host.querySelector('.confirm')).toBeNull();
  });

  it('renderiza quando aberto e permite escolher quantidade de terminais', () => {
    const host = render(<TerminalGridDialog />);
    act(() => {
      useTerminalGridDialogStore.getState().open({ initialCount: 4 });
    });

    expect(host.querySelector('.confirm')).not.toBeNull();
    expect(host.textContent).toContain('Quantos terminais deseja abrir?');
    expect(host.textContent).toContain('4 Terminais');
  });

  it('ao confirmar, configura o grid com a quantidade escolhida e navega para terminal', () => {
    const setPanesSpy = vi.spyOn(useLayoutStore.getState(), 'setPanes');
    const openTerminalSpy = vi.spyOn(useProductNavigationStore.getState(), 'openTerminal');

    const host = render(<TerminalGridDialog />);
    act(() => {
      useTerminalGridDialogStore.getState().open({ initialCount: 2 });
    });

    // Clica no preset de 4 terminais
    const btn4 = [...host.querySelectorAll<HTMLButtonElement>('.terminal-grid-dialog__preset-btn')].find(
      (b) => b.textContent?.includes('4 Terminais'),
    );
    expect(btn4).toBeTruthy();
    act(() => {
      btn4!.click();
    });

    // Clica no botão de abrir
    const confirmBtn = host.querySelector<HTMLButtonElement>('.confirm__btn--primary');
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn?.textContent).toContain('Abrir 4 Terminais');

    act(() => {
      confirmBtn!.click();
    });

    expect(setPanesSpy).toHaveBeenCalled();
    const calledPanes = setPanesSpy.mock.calls[0][0];
    expect(calledPanes.length).toBe(4);
    expect(openTerminalSpy).toHaveBeenCalled();
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(false);
  });

  it('ao cancelar, fecha o diálogo sem alterar panes', () => {
    const setPanesSpy = vi.spyOn(useLayoutStore.getState(), 'setPanes');

    const host = render(<TerminalGridDialog />);
    act(() => {
      useTerminalGridDialogStore.getState().open({ initialCount: 2 });
    });

    const cancelBtn = [...host.querySelectorAll<HTMLButtonElement>('.confirm__btn')].find(
      (b) => b.textContent?.includes('Cancelar'),
    );
    expect(cancelBtn).toBeTruthy();
    act(() => {
      cancelBtn!.click();
    });

    expect(setPanesSpy).not.toHaveBeenCalled();
    expect(useTerminalGridDialogStore.getState().isOpen).toBe(false);
  });
});
