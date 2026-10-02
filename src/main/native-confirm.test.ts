import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: { showMessageBoxSync: vi.fn(() => 0) },
}));

import { dialog } from 'electron';
import { confirmNativeAction, nativeDialogParent } from './native-confirm';

function fakeWindow(state: { visible: boolean; destroyed?: boolean }) {
  return {
    isVisible: () => state.visible,
    isDestroyed: () => state.destroyed ?? false,
  };
}

const OPTIONS = { title: 't', message: 'm', confirmLabel: 'Abrir' };

describe('nativeDialogParent', () => {
  it('never parents a dialog to a window Wayland has not mapped yet', () => {
    // Arranque a frio por nexus://open: a janela principal ainda está com
    // show:false. Presa a ela, a caixa derruba o app com erro de protocolo.
    expect(nativeDialogParent(fakeWindow({ visible: false }), 'linux')).toBeUndefined();
  });

  it('keeps the parent once the window is on screen', () => {
    const win = fakeWindow({ visible: true });
    expect(nativeDialogParent(win, 'linux')).toBe(win);
  });

  it('leaves macOS and Windows behaviour unchanged', () => {
    const hidden = fakeWindow({ visible: false });
    expect(nativeDialogParent(hidden, 'darwin')).toBe(hidden);
    expect(nativeDialogParent(hidden, 'win32')).toBe(hidden);
  });

  it('drops a destroyed or absent window on every platform', () => {
    expect(nativeDialogParent(fakeWindow({ visible: true, destroyed: true }), 'darwin')).toBeUndefined();
    expect(nativeDialogParent(null, 'linux')).toBeUndefined();
    expect(nativeDialogParent(undefined, 'win32')).toBeUndefined();
  });
});

describe('confirmNativeAction', () => {
  it('is fail-closed: only the confirm button returns true', () => {
    const show = vi.mocked(dialog.showMessageBoxSync);
    show.mockReturnValueOnce(0);
    expect(confirmNativeAction(OPTIONS)).toBe(false);
    show.mockReturnValueOnce(1);
    expect(confirmNativeAction(OPTIONS)).toBe(true);
    expect(show.mock.calls.at(-1)?.[0]).toMatchObject({
      buttons: ['Cancelar', 'Abrir'],
      defaultId: 0,
      cancelId: 0,
    });
  });
});
