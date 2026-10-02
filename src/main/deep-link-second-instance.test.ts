import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;
const listeners = new Map<string, Listener>();
const electron = vi.hoisted(() => ({
  setAsDefaultProtocolClient: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  focus: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
    setAsDefaultProtocolClient: electron.setAsDefaultProtocolClient,
    requestSingleInstanceLock: electron.requestSingleInstanceLock,
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [{ isMinimized: () => false, restore: vi.fn(), focus: electron.focus }],
  },
}));
vi.mock('./native-confirm', () => ({ confirmNativeAction: vi.fn(() => false) }));
vi.mock('./auth-deep-link', () => ({ finishAuthDeepLink: vi.fn() }));
vi.mock('./linux-desktop-entry', () => ({ ensureLinuxDesktopEntry: vi.fn() }));

import { ensureLinuxDesktopEntry } from './linux-desktop-entry';
import { wireDeepLinks, type DeepLink } from './deep-link';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('wireDeepLinks second-instance delivery (F-731)', () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
  });

  it('returns from the second-instance event before the link handler runs', async () => {
    // A segunda instância espera a confirmação deste evento por 20 s; se o
    // handler (diálogo nativo síncrono) rodar dentro dele, o Chromium mata o
    // app em execução. O handler precisa rodar depois que o evento retorna.
    const handled: Array<{ link: DeepLink; trusted: boolean }> = [];
    expect(wireDeepLinks((link, trusted) => handled.push({ link, trusted }))).toBe(true);

    listeners.get('second-instance')?.({}, ['/usr/bin/nexus-ide', 'nexus://open?path=/tmp/x']);

    expect(handled).toEqual([]);
    expect(electron.focus).toHaveBeenCalledOnce();
    await nextTurn();
    expect(handled).toEqual([{ link: { kind: 'open', path: '/tmp/x' }, trusted: false }]);
  });

  it('only focuses the window when the second launch carries no link', async () => {
    const handler = vi.fn();
    wireDeepLinks(handler);
    listeners.get('second-instance')?.({}, ['/usr/bin/nexus-ide']);
    await nextTurn();
    expect(handler).not.toHaveBeenCalled();
    expect(electron.focus).toHaveBeenCalledOnce();
  });

  it('prepares the Linux desktop entry before registering the protocol', () => {
    wireDeepLinks(vi.fn());
    const ensured = vi.mocked(ensureLinuxDesktopEntry).mock.invocationCallOrder[0];
    const registered = electron.setAsDefaultProtocolClient.mock.invocationCallOrder[0];
    expect(ensured).toBeLessThan(registered);
    expect(electron.setAsDefaultProtocolClient).toHaveBeenCalledWith('nexus');
  });

  it('reports a second instance so the caller quits', () => {
    electron.requestSingleInstanceLock.mockReturnValueOnce(false);
    expect(wireDeepLinks(vi.fn())).toBe(false);
    expect(listeners.has('second-instance')).toBe(false);
  });
});
