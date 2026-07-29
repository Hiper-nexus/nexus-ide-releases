import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listenOnLoopback,
  ReplaceableEventTapScope,
} from './mcp-server-lifecycle';

const openServers = new Set<http.Server>();

function closeServer(server: http.Server): Promise<void> {
  openServers.delete(server);
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => closeServer(server)));
});

describe('listenOnLoopback', () => {
  it('rejects a listen error instead of leaving startup pending', async () => {
    const occupied = http.createServer();
    openServers.add(occupied);
    const occupiedPort = await listenOnLoopback(occupied);

    const candidate = http.createServer();
    openServers.add(candidate);
    const initialListeningListeners =
      candidate.listenerCount('listening');
    const initialErrorListeners = candidate.listenerCount('error');
    const startup = listenOnLoopback(candidate, occupiedPort);
    const settled = await Promise.race([
      startup.then(
        () => 'resolved',
        (error: NodeJS.ErrnoException) => error.code,
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('pending'), 250);
      }),
    ]);

    expect(settled).toBe('EADDRINUSE');
    expect(candidate.listenerCount('listening')).toBe(
      initialListeningListeners,
    );
    expect(candidate.listenerCount('error')).toBe(initialErrorListeners);
  });

  it('resolves the physical port and removes startup listeners', async () => {
    const candidate = http.createServer();
    openServers.add(candidate);
    const initialListeningListeners =
      candidate.listenerCount('listening');
    const initialErrorListeners = candidate.listenerCount('error');

    const boundPort = await listenOnLoopback(candidate);

    expect(boundPort).toBe(
      (candidate.address() as AddressInfo).port,
    );
    expect(candidate.listenerCount('listening')).toBe(
      initialListeningListeners,
    );
    expect(candidate.listenerCount('error')).toBe(initialErrorListeners);
  });
});

describe('ReplaceableEventTapScope', () => {
  it('disposes every previous tap before installing a retry generation', () => {
    const dataTaps = new Set<() => void>();
    const stateTaps = new Set<() => void>();
    const exitTaps = new Set<() => void>();
    const observed = {
      data: vi.fn(),
      state: vi.fn(),
      exit: vi.fn(),
    };
    const scope = new ReplaceableEventTapScope();
    const install = (
      track: (dispose: () => void) => void,
    ): void => {
      const data = () => observed.data();
      const state = () => observed.state();
      const exit = () => observed.exit();
      dataTaps.add(data);
      track(() => dataTaps.delete(data));
      stateTaps.add(state);
      track(() => stateTaps.delete(state));
      exitTaps.add(exit);
      track(() => exitTaps.delete(exit));
    };

    scope.replace(install);
    scope.replace(install);

    expect(dataTaps.size).toBe(1);
    expect(stateTaps.size).toBe(1);
    expect(exitTaps.size).toBe(1);
    dataTaps.forEach((tap) => tap());
    stateTaps.forEach((tap) => tap());
    exitTaps.forEach((tap) => tap());
    expect(observed.data).toHaveBeenCalledOnce();
    expect(observed.state).toHaveBeenCalledOnce();
    expect(observed.exit).toHaveBeenCalledOnce();

    scope.dispose();
    scope.dispose();

    expect(dataTaps.size).toBe(0);
    expect(stateTaps.size).toBe(0);
    expect(exitTaps.size).toBe(0);
  });

  it('rolls back a partially installed generation', () => {
    const disposeFirstTap = vi.fn();
    const scope = new ReplaceableEventTapScope();

    expect(() =>
      scope.replace((track) => {
        track(disposeFirstTap);
        throw new Error('state tap registration failed');
      }),
    ).toThrow('state tap registration failed');

    expect(disposeFirstTap).toHaveBeenCalledOnce();
  });
});
