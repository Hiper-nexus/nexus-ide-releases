import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';

// F-1201: o pedido vem do celular pareado, com o operador longe da mesa. No
// macOS um showMessageBox sem janela-mãe é NSAlert runModal e prende a main
// thread até alguém clicar na mesa.
const electron = vi.hoisted(() => {
  const state = {
    windows: [] as unknown[],
    focused: null as unknown,
    showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 1, checkboxChecked: false })),
  };
  const module = {
    BrowserWindow: {
      getAllWindows: () => state.windows,
      getFocusedWindow: () => state.focused,
    },
    dialog: { showMessageBox: state.showMessageBox },
  };
  return Object.assign(state, { module });
});
vi.mock('electron', () => electron.module);
// O mesmo mock também para `require('electron')`, que o vi.mock não intercepta.
const nodeRequire = createRequire(import.meta.url);
const electronId = nodeRequire.resolve('electron');
(nodeRequire.cache as Record<string, unknown>)[electronId] = {
  id: electronId, filename: electronId, loaded: true, exports: electron.module,
};

import { requestRemoteDesktopConfirmation } from './remote-desktop-confirmation';

function fakeWindow(visible: boolean) {
  return { isDestroyed: () => false, isVisible: () => visible, isFocusable: () => true };
}

let device = 0;
function request() {
  device += 1;
  return {
    confirmationSessionId: `device-${device}`,
    scope: testProjectScope(),
    toolName: 'remote_pane_input',
    reason: 'comando de alto impacto',
    args: { command: 'git push --force' },
  };
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  electron.windows = [];
  electron.focused = null;
  electron.showMessageBox.mockClear();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  delete (nodeRequire.cache as Record<string, unknown>)[electronId];
});

describe('confirmação de dispositivo remoto (F-1201)', () => {
  it('vira sheet na janela do Nexus mesmo oculta e fecha sozinha no prazo', async () => {
    const win = fakeWindow(false);
    electron.windows = [win];

    await expect(requestRemoteDesktopConfirmation(request())).resolves.toBe(true);

    expect(electron.showMessageBox).toHaveBeenCalledOnce();
    const [parent, options] = electron.showMessageBox.mock.calls[0];
    expect(parent).toBe(win);
    expect(options).toMatchObject({ cancelId: 0 });
    expect((options as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
  });

  it('sem nenhuma janela nega na hora em vez de prender a main thread', async () => {
    await expect(requestRemoteDesktopConfirmation(request())).resolves.toBe(false);

    expect(electron.showMessageBox).not.toHaveBeenCalled();
  });
});
