import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_AUTOMATION_CHANNELS } from '../../shared/browser-automation';

const electron = vi.hoisted(() => ({
  responseHandler: undefined as
    | ((event: { sender: { id: number } }, raw: unknown) => void)
    | undefined,
  on: vi.fn(
    (
      _channel: string,
      handler: (event: { sender: { id: number } }, raw: unknown) => void,
    ) => {
      electron.responseHandler = handler;
    },
  ),
}));

vi.mock('electron', () => ({ ipcMain: { on: electron.on } }));

import {
  registerBrowserAutomationResponseHandler,
  rejectPendingBrowserAutomation,
  runBrowserAutomation,
} from './browser-automation-runtime';

function browserWebContents(id = 41) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    send: vi.fn(),
  };
}

describe('browser automation runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    registerBrowserAutomationResponseHandler();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('correlates a response only to the browser WebContents that sent it', async () => {
    const webContents = browserWebContents();
    const resultPromise = runBrowserAutomation(
      'pane-a',
      webContents as never,
      'read',
      {},
    );
    const [channel, request] = webContents.send.mock.calls[0] as [
      string,
      { requestId: string },
    ];

    electron.responseHandler?.(
      { sender: { id: webContents.id + 1 } },
      { requestId: request.requestId, ok: true, result: { spoofed: true } },
    );
    electron.responseHandler?.(
      { sender: { id: webContents.id } },
      { requestId: request.requestId, ok: true, result: { trusted: true } },
    );

    expect(channel).toBe(BROWSER_AUTOMATION_CHANNELS.request);
    await expect(resultPromise).resolves.toEqual({ trusted: true });
  });

  it('rejects outstanding work when its browser renderer disappears', async () => {
    const webContents = browserWebContents(77);
    const resultPromise = runBrowserAutomation(
      'pane-b',
      webContents as never,
      'inspect',
      { ref: 'e1' },
    );
    const rejection = expect(resultPromise).rejects.toThrow('browser pane was destroyed');

    rejectPendingBrowserAutomation(webContents.id, 'browser pane was destroyed');

    await rejection;
  });

  it('enforces the minimum timeout and clears the pending request', async () => {
    const webContents = browserWebContents(88);
    const resultPromise = runBrowserAutomation(
      'pane-c',
      webContents as never,
      'wait',
      {},
      1,
    );
    const rejection = expect(resultPromise).rejects.toThrow(
      'browser automation timed out',
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
  });
});
