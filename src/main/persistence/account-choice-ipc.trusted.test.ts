import { beforeEach, describe, expect, it, vi } from 'vitest';

// Aqui o `handleTrusted` é o REAL: prova que só o frame principal da janela
// principal registrada alcança o recibo (o outro arquivo mocka o guard).
const handleMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
}));

import type { AccountChoiceReceipt } from '../../shared/account-choice';
import { ACCOUNT_CHOICE_CHANNELS } from '../../shared/account-choice-channels';
import { bindTrustedMainWindow } from '../security/trusted-ipc';
import {
  forgetAccountChoiceReceipt,
  recordAccountChoiceReceipt,
} from './account-choice-receipts';
import { registerAccountChoiceIpc } from './account-choice-ipc';

const URL = 'nexus://app/index.html';

function fakeWindow() {
  const contents = {
    mainFrame: { id: 1 },
    isDestroyed: () => false,
    isCrashed: () => false,
    getURL: () => URL,
    once: vi.fn(),
  };
  const win = { webContents: contents, isDestroyed: () => false };
  return { win, contents };
}

const receipt: AccountChoiceReceipt = {
  adapterId: 'codex',
  source: 'active',
  account: { label: 'o•••@p•••.com', mode: 'subscription' },
  headroom: null,
  alternatives: [],
  decidedAt: 1_759_999_000_000,
};

type Invoke = (event: unknown, ...args: unknown[]) => unknown;

function registeredHandler(): Invoke {
  const entry = handleMock.mock.calls.find(([channel]) => channel === ACCOUNT_CHOICE_CHANNELS.get);
  if (!entry) throw new Error('accountChoice:get was not registered with ipcMain.handle');
  return entry[1] as Invoke;
}

describe('accountChoice:get — sender trust (real handleTrusted)', () => {
  beforeEach(() => {
    handleMock.mockReset();
    forgetAccountChoiceReceipt('sess-trusted');
  });

  it('serves the receipt from the real store to the bound main frame', () => {
    recordAccountChoiceReceipt('sess-trusted', receipt);
    registerAccountChoiceIpc();
    const { win, contents } = fakeWindow();
    bindTrustedMainWindow(win as never, URL);
    const event = { sender: contents, senderFrame: contents.mainFrame };
    expect(registeredHandler()(event, { sessionId: 'sess-trusted' })).toEqual(receipt);
    expect(registeredHandler()(event, { sessionId: 'outra-sessao' })).toBeNull();
  });

  it('refuses an unbound sender, a sub-frame and a navigated window — and never reads the store', () => {
    recordAccountChoiceReceipt('sess-trusted', receipt);
    const lookup = vi.fn(() => receipt);
    registerAccountChoiceIpc(lookup);
    const handler = registeredHandler();

    const unbound = fakeWindow();
    expect(() =>
      handler({ sender: unbound.contents, senderFrame: unbound.contents.mainFrame }, { sessionId: 'sess-trusted' }),
    ).toThrow('ipc sender não autorizado');

    const bound = fakeWindow();
    bindTrustedMainWindow(bound.win as never, URL);
    expect(() =>
      handler({ sender: bound.contents, senderFrame: { id: 999 } }, { sessionId: 'sess-trusted' }),
    ).toThrow('ipc sender não autorizado');

    const navigated = fakeWindow();
    bindTrustedMainWindow(navigated.win as never, URL);
    navigated.contents.getURL = () => 'https://evil.example/index.html';
    expect(() =>
      handler({ sender: navigated.contents, senderFrame: navigated.contents.mainFrame }, { sessionId: 'sess-trusted' }),
    ).toThrow('ipc sender não autorizado');

    expect(lookup).not.toHaveBeenCalled();
  });
});
