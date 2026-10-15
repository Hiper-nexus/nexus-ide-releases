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

  it('resolves a reload invoke immediately after resolveBootReady has already settled', async () => {
    const { gate, trusted, handler } = await loadModules();
    gate.resolveBootReady();
    let settled = false;
    void handler(trustedEvent(trusted)).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(gate.isBootReadyPending()).toBe(false);
  });

  it('caps mount watchdog re-arms at BOOT_READY_DEADLINE_MS and stops once boot:ready settles', async () => {
    const { gate } = await loadModules();
    expect(gate.BOOT_READY_DEADLINE_MS).toBeGreaterThanOrEqual(90_000);
    const startedAt = 1_000;
    expect(gate.isBootReadyPending()).toBe(true);
    expect(gate.shouldRearmMountWatchdogForBootGate(startedAt, startedAt + 20_000)).toBe(true);
    expect(
      gate.shouldRearmMountWatchdogForBootGate(
        startedAt,
        startedAt + gate.BOOT_READY_DEADLINE_MS - 1,
      ),
    ).toBe(true);
    expect(
      gate.shouldRearmMountWatchdogForBootGate(
        startedAt,
        startedAt + gate.BOOT_READY_DEADLINE_MS,
      ),
    ).toBe(false);

    gate.resolveBootReady();
    expect(gate.shouldRearmMountWatchdogForBootGate(startedAt, startedAt + 2_000)).toBe(false);
  });

  it('rejects boot:ready at BOOT_READY_DEADLINE_MS when bootstrap never resolves and triggers error dialog + quit', async () => {
    vi.useFakeTimers();
    try {
      const { gate, trusted, handler } = await loadModules();
      const showErrorBox = vi.fn();
      const quitApp = vi.fn();
      const rendererWaiter = handler(trustedEvent(trusted));
      const waiterExpectation = expect(rendererWaiter).rejects.toThrow(/boot:ready deadline/i);

      const flow = gate
        .withBootReadyDeadline(() => new Promise<void>(() => {}))
        .catch((error: unknown) => {
          gate.handleBootReadyFailure(error, {
            isShutdownSealed: () => false,
            showErrorBox,
            quitApp,
          });
        });

      await vi.advanceTimersByTimeAsync(gate.BOOT_READY_DEADLINE_MS - 1);
      expect(gate.isBootReadyPending()).toBe(true);
      expect(showErrorBox).not.toHaveBeenCalled();
      expect(quitApp).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await flow;
      await waiterExpectation;

      expect(gate.isBootReadyPending()).toBe(false);
      expect(showErrorBox).toHaveBeenCalledTimes(1);
      expect(showErrorBox.mock.calls[0]?.[0]).toBe('NexusIDE não conseguiu inicializar');
      expect(quitApp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips error dialog and post-await orchestration when shutdown is sealed during bootstrap', async () => {
    const { gate, trusted, handler } = await loadModules();
    const showErrorBox = vi.fn();
    const quitApp = vi.fn();
    const initOrchestration = vi.fn();
    let shutdownSealed = false;
    let releaseBootstrapStep!: () => void;
    const bootstrapStep = new Promise<void>((resolve) => {
      releaseBootstrapStep = resolve;
    });

    const rendererWaiter = handler(trustedEvent(trusted));
    const waiterExpectation = expect(rendererWaiter).rejects.toThrow(/shutdown/i);

    const bootFlow = gate
      .withBootReadyDeadline(async () => {
        await bootstrapStep;
        if (shutdownSealed) {
          throw new Error('bootstrap aborted: shutdown sealed');
        }
        initOrchestration();
        gate.resolveBootReady();
      })
      .catch((error: unknown) => {
        gate.handleBootReadyFailure(error, {
          isShutdownSealed: () => shutdownSealed,
          showErrorBox,
          quitApp,
        });
      });

    // User closes window / Cmd+W during bootstrap -> seals shutdown admission.
    shutdownSealed = true;
    releaseBootstrapStep();
    await bootFlow;
    await waiterExpectation;

    expect(initOrchestration).not.toHaveBeenCalled();
    expect(showErrorBox).not.toHaveBeenCalled();
    expect(quitApp).not.toHaveBeenCalled();
  });
});

