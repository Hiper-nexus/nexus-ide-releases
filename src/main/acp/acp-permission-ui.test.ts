import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// F-1200: no macOS um showMessageBox sem janela-mãe é NSAlert runModal e prende
// a main thread até o clique. O pedido de permissão ACP nasce do agente.
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

import { requestAcpPermission } from './acp-permission-ui';

function fakeWindow(visible: boolean) {
  return { isDestroyed: () => false, isVisible: () => visible, isFocusable: () => true };
}

const params = {
  toolCall: { title: 'Editar package.json' },
  options: [{ optionId: 'allow-once', name: 'Permitir uma vez' }],
};
const context = { agentLabel: 'acp-worker', missionId: 'mission-1' };

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

describe('permissão ACP (F-1200)', () => {
  it('vira sheet na janela do Nexus mesmo fora de foco e fecha no prazo do pedido', async () => {
    const win = fakeWindow(false);
    electron.windows = [win];

    await expect(requestAcpPermission(params, context)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    expect(electron.showMessageBox).toHaveBeenCalledOnce();
    const [parent, options] = electron.showMessageBox.mock.calls[0];
    expect(parent).toBe(win);
    expect(options).toMatchObject({ cancelId: 0 });
    expect((options as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
  });

  it('sem nenhuma janela cancela na hora em vez de prender a main thread', async () => {
    await expect(requestAcpPermission(params, context)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });

    expect(electron.showMessageBox).not.toHaveBeenCalled();
  });
});
