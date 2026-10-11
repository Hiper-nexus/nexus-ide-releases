import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLoopbackServer,
  listenOnLoopback,
  LOOPBACK_SERVER_TIMEOUTS,
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

describe('createLoopbackServer (F-1240)', () => {
  it('pedido que não termina de chegar recebe 408; resposta longa (long-poll) não é cortada', async () => {
    const candidate = createLoopbackServer(
      (req, res) => {
        req.resume();
        req.on('end', () => setTimeout(() => res.end('ok'), 600));
      },
      { headersTimeout: 200, requestTimeout: 300, connectionsCheckingInterval: 50 },
    );
    openServers.add(candidate);
    const port = await listenOnLoopback(candidate);

    // Corpo prometido e nunca entregue: o servidor corta pelo prazo do pedido.
    const slow = net.connect(port, '127.0.0.1');
    slow.write('POST /x HTTP/1.1\r\nHost: loopback\r\nContent-Length: 100\r\n\r\nabc');
    const reply = await new Promise<string>((resolve) => {
      let text = '';
      slow.on('data', (chunk) => {
        text += chunk.toString('utf8');
      });
      slow.on('close', () => resolve(text));
      slow.on('error', () => resolve(text));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 408/);

    // Pedido inteiro, resposta depois do prazo do pedido: o prazo não conta.
    const res = await fetch(`http://127.0.0.1:${port}/wait`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('produção: cabeçalhos em 10 s e o pedido inteiro em 30 s, conferidos a cada 5 s', () => {
    expect(LOOPBACK_SERVER_TIMEOUTS).toEqual({
      headersTimeout: 10_000,
      requestTimeout: 30_000,
      connectionsCheckingInterval: 5_000,
    });
    const candidate = createLoopbackServer(() => undefined);
    expect(candidate.headersTimeout).toBe(10_000);
    expect(candidate.requestTimeout).toBe(30_000);
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
