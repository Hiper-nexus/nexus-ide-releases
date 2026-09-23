import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showOpenDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
}));

vi.mock('electron', () => ({
  dialog: { showOpenDialog },
}));

import { showOwnedOpenDialog } from './owned-open-dialog';

function owner() {
  return {
    isDestroyed: () => false,
  } as unknown as Electron.BrowserWindow;
}

describe('showOwnedOpenDialog', () => {
  beforeEach(() => {
    showOpenDialog.mockClear();
  });

  it('does not parent the dialog on Windows', async () => {
    const window = owner();
    const options = {
      title: 'Escolher pasta do workspace',
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    await showOwnedOpenDialog(window, options);
    if (process.platform === 'win32') {
      expect(showOpenDialog).toHaveBeenCalledTimes(1);
      expect(showOpenDialog).toHaveBeenCalledWith(options);
      expect(showOpenDialog.mock.calls[0]).toHaveLength(1);
    } else {
      expect(showOpenDialog).toHaveBeenCalledWith(window, options);
    }
  });

  it('opens with the options alone when there is no owner', async () => {
    const options = { title: 'sem dono', properties: ['openFile' as const] };
    await showOwnedOpenDialog(null, options);
    expect(showOpenDialog).toHaveBeenCalledWith(options);
  });
});
