import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {},
  ipcMain: {},
}));

import { createRealMissionPrematureExitHandlers } from './real-mission-e2e';

describe('real mission premature exit receipts', () => {
  it('maps app and renderer lifecycle loss to closed failure codes', () => {
    let settled = false;
    const finish = vi.fn(() => {
      settled = true;
    });
    const handlers = createRealMissionPrematureExitHandlers({
      isSettled: () => settled,
      finish,
    });

    handlers.beforeQuit();
    handlers.ownerDestroyed();
    handlers.rendererGone();

    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith('app-error');
  });

  it('uses renderer-failed for either owner-loss event', () => {
    for (const event of ['ownerDestroyed', 'rendererGone'] as const) {
      const finish = vi.fn();
      const handlers = createRealMissionPrematureExitHandlers({
        isSettled: () => false,
        finish,
      });

      handlers[event]();

      expect(finish).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledWith('renderer-failed');
    }
  });

  it('wires all premature exit hooks into the packaged gate', () => {
    const source = readFileSync(
      new URL('./real-mission-e2e.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("app.on('before-quit', onBeforeQuit)");
    expect(source).toContain("owner.once('destroyed', onOwnerDestroyed)");
    expect(source).toContain(
      "owner.once('render-process-gone', onOwnerRenderProcessGone)",
    );
  });
});
