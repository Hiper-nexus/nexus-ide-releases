import { describe, expect, it, vi } from 'vitest';
import {
  MAIN_BUSY_AFTER_MS,
  MAIN_HEARTBEAT_PING_EVERY_MS,
  createMainHeartbeatMonitor,
} from './main-heartbeat';

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(ping: () => Promise<unknown>) {
  let clock = 0;
  const onBusyChange = vi.fn();
  const monitor = createMainHeartbeatMonitor({ ping, onBusyChange, now: () => clock });
  const advance = async (ms: number, stepMs = 1_000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      clock += stepMs;
      monitor.tick();
      await Promise.resolve();
    }
  };
  return { monitor, onBusyChange, advance, tickNow: () => monitor.tick() };
}

describe('createMainHeartbeatMonitor (F-764 C.7)', () => {
  it('main respondendo: pinga no ritmo e nunca acusa ocupado', async () => {
    const ping = vi.fn(async () => ({ at: 1 }));
    const { onBusyChange, advance, tickNow } = setup(ping);
    tickNow();
    await advance(30_000);
    expect(ping.mock.calls.length).toBeGreaterThanOrEqual(30_000 / MAIN_HEARTBEAT_PING_EVERY_MS - 1);
    expect(ping.mock.calls.length).toBeLessThanOrEqual(30_000 / MAIN_HEARTBEAT_PING_EVERY_MS + 1);
    expect(onBusyChange).not.toHaveBeenCalled();
  });

  it('ping 10 s sem resposta acusa ocupado, sem empilhar ping; a resposta apaga sozinha', async () => {
    const pending = deferred();
    const ping = vi.fn(() => pending.promise);
    const { monitor, onBusyChange, advance, tickNow } = setup(ping);
    tickNow();
    expect(ping).toHaveBeenCalledTimes(1);

    await advance(MAIN_BUSY_AFTER_MS - 1_000);
    expect(onBusyChange).not.toHaveBeenCalled();
    await advance(1_000);
    expect(onBusyChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(monitor.isBusy()).toBe(true);

    // Main preso por minutos: nenhum ping novo na fila dele, nenhuma notificação repetida.
    await advance(120_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(onBusyChange).toHaveBeenCalledTimes(1);

    pending.resolve({ at: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(monitor.isBusy()).toBe(false);

    // Volta ao ritmo normal.
    await advance(MAIN_HEARTBEAT_PING_EVERY_MS);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('erro de IPC também prova que o main atendeu', async () => {
    const ping = vi.fn(async () => {
      throw new Error("No handler registered for 'app:heartbeat'");
    });
    const { onBusyChange, advance, tickNow } = setup(ping);
    tickNow();
    await advance(20_000);
    expect(onBusyChange).not.toHaveBeenCalled();
    expect(ping.mock.calls.length).toBeGreaterThan(1);
  });

  it('ponte quebrada de forma síncrona não vira falso "main ocupado"', async () => {
    const ping = vi.fn(() => {
      throw new Error('ponte ausente');
    });
    const { onBusyChange, advance, tickNow } = setup(ping as unknown as () => Promise<unknown>);
    tickNow();
    await advance(20_000);
    expect(onBusyChange).not.toHaveBeenCalled();
  });

  it('dispose: resposta tardia não notifica componente desmontado', async () => {
    const pending = deferred();
    const { monitor, onBusyChange, advance, tickNow } = setup(() => pending.promise);
    tickNow();
    await advance(MAIN_BUSY_AFTER_MS);
    expect(onBusyChange).toHaveBeenCalledTimes(1);
    monitor.dispose();
    pending.resolve();
    await Promise.resolve();
    await advance(5_000);
    expect(onBusyChange).toHaveBeenCalledTimes(1);
  });
});
