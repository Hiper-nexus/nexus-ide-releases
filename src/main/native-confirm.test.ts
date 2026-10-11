import { beforeEach, describe, expect, it, vi } from 'vitest';

const windows = vi.hoisted(() => ({ list: [] as unknown[], focused: null as unknown }));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => windows.list,
    getFocusedWindow: () => windows.focused,
  },
  dialog: {
    showMessageBoxSync: vi.fn(() => 0),
    showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
  },
}));

import { dialog } from 'electron';
import {
  confirmNativeAction,
  nativeDialogParent,
  showMessageBoxWithoutBlocking,
} from './native-confirm';

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

describe('showMessageBoxWithoutBlocking (F-1200)', () => {
  const box = { message: 'm', buttons: ['Negar', 'Permitir'], cancelId: 0 };
  const host = (visible: boolean, focusable = true) => ({
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocusable: () => focusable,
  });
  const show = vi.mocked(dialog.showMessageBox);

  beforeEach(() => {
    show.mockClear();
    windows.list = [];
    windows.focused = null;
  });

  it('prefers the focused window, then a visible one, and never the non-focusable pet', async () => {
    const pet = host(true, false);
    const hidden = host(false);
    const visible = host(true);
    windows.list = [pet, hidden, visible];
    await showMessageBoxWithoutBlocking(box, {}, 'darwin');
    expect(show.mock.calls[0][0]).toBe(visible);

    windows.focused = hidden;
    await showMessageBoxWithoutBlocking(box, {}, 'darwin');
    expect(show.mock.calls[1][0]).toBe(hidden);
  });

  it('on macOS without a window returns null and shows nothing', async () => {
    windows.list = [host(true, false)];
    await expect(showMessageBoxWithoutBlocking(box, {}, 'darwin')).resolves.toBeNull();
    expect(show).not.toHaveBeenCalled();
  });

  it('keeps the parentless dialog where it does not block (Linux/Windows)', async () => {
    windows.list = [host(false)];
    await showMessageBoxWithoutBlocking(box, {}, 'linux');
    expect(show).toHaveBeenCalledWith(box);
  });

  it('closes the sheet as cancel once the timeout expires', async () => {
    vi.useFakeTimers();
    try {
      windows.list = [host(true)];
      show.mockImplementationOnce(((_win: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve({ response: 0, checkboxChecked: false }));
        })) as never);
      const pending = showMessageBoxWithoutBlocking(box, { timeoutMs: 7_000 }, 'darwin');
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(pending).resolves.toEqual({ response: 0, checkboxChecked: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
