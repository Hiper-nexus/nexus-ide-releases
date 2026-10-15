// Gate de montagem do boot: o renderer carrega em paralelo ao bootstrap, mas
// só monta quando o Main resolve `boot:ready`. O handler só responde ao
// WebContents da janela principal confiável — como todo invoke sensível.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../shared/channels';

const electronMock = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('electron', () => electronMock);
vi.mock('./observability/main-trace', () => ({ trace: vi.fn() }));

type GateModule = typeof import('./boot-ready-gate');
type TrustedModule = typeof import('./security/trusted-ipc');

async function loadModules(): Promise<{
  gate: GateModule;
  trusted: TrustedModule;
  handler: (event: unknown) => Promise<unknown>;
}> {
  vi.resetModules();
  electronMock.ipcMain.handle.mockReset();
  const gate = await import('./boot-ready-gate');
  const trusted = await import('./security/trusted-ipc');
  gate.registerBootReadyIpc();
  const call = electronMock.ipcMain.handle.mock.calls.find(
    ([channel]) => channel === WINDOW_CHANNELS.bootReady,
  );
  if (!call) throw new Error('boot:ready handler not registered');
  return { gate, trusted, handler: call[1] as (event: unknown) => Promise<unknown> };
}

function trustedEvent(trusted: TrustedModule): { sender: unknown; senderFrame: unknown } {
  const mainFrame = { id: 1 };
  const contents = {
    isDestroyed: () => false,
    isCrashed: () => false,
    getURL: () => 'nexus-app://renderer/index.html',
    mainFrame,
    once: vi.fn(),
  };
  const win = { isDestroyed: () => false, webContents: contents };
  trusted.bindTrustedMainWindow(win as never, 'nexus-app://renderer/index.html');
  return { sender: contents, senderFrame: mainFrame };
}

describe('boot:ready mount gate', () => {
  beforeEach(async () => {
    await loadModules();
  });

  it('registers the channel exactly once across repeated registrations', async () => {
    const gate = await import('./boot-ready-gate');
    gate.registerBootReadyIpc();
    gate.registerBootReadyIpc();
    const registrations = electronMock.ipcMain.handle.mock.calls.filter(
      ([channel]) => channel === WINDOW_CHANNELS.bootReady,
    );
    expect(registrations).toHaveLength(1);
  });

  it('holds the renderer invoke until resolveBootReady', async () => {
    const { gate, trusted, handler } = await loadModules();
    const pending = handler(trustedEvent(trusted));
    for (let round = 0; round < 5; round += 1) await Promise.resolve();
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolveBootReady();
    await expect(pending).resolves.toBeUndefined();
  });

  it('every waiter observes the same resolution (single shared gate)', async () => {
    const { gate, trusted, handler } = await loadModules();
    const first = handler(trustedEvent(trusted));
    const second = handler(trustedEvent(trusted));
    gate.resolveBootReady();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('rejectBootReady fails the waiters — bootstrap failure never mounts React', async () => {
    const { gate, trusted, handler } = await loadModules();
    const pending = handler(trustedEvent(trusted));
    const expectation = expect(pending).rejects.toThrow('bootstrap exploded');
    gate.rejectBootReady(new Error('bootstrap exploded'));
    await expectation;
  });

  it('refuses senders that are not the trusted main window', async () => {
    const { handler } = await loadModules();
    expect(() =>
      handler({ sender: { getURL: () => 'https://evil.example' }, senderFrame: null }),
    ).toThrow();
  });
});
