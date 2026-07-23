import { beforeEach, describe, expect, it, vi } from 'vitest';

const relayMocks = vi.hoisted(() => ({
  seal: vi.fn(),
  open: vi.fn(),
  sockets: [] as Array<{
    readyState: number;
    bufferedAmount: number;
    sent: Uint8Array[];
    failNextSendSync: boolean;
    failNextSendAsync: boolean;
    holdSendCallbacks: boolean;
    pendingSendCallbacks: Array<(error?: Error) => void>;
    close: ReturnType<typeof vi.fn>;
    openNow(): void;
    settleNextSend(error?: Error): void;
  }>,
}));

vi.mock('../../../vendor/omp/wire/codec', () => ({
  seal: relayMocks.seal,
  open: relayMocks.open,
  packEnvelope(peerId: number, payload: Uint8Array): Uint8Array {
    const envelope = new Uint8Array(payload.byteLength + 4);
    new DataView(envelope.buffer).setUint32(0, peerId, false);
    envelope.set(payload, 4);
    return envelope;
  },
  unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
    if (data.byteLength < 4) return null;
    return {
      peerId: new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false),
      payload: data.subarray(4),
    };
  },
}));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeWebSocket extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly url: string;
    readyState = FakeWebSocket.CONNECTING;
    bufferedAmount = 0;
    binaryType = '';
    sent: Uint8Array[] = [];
    failNextSendSync = false;
    failNextSendAsync = false;
    holdSendCallbacks = false;
    pendingSendCallbacks: Array<(error?: Error) => void> = [];
    close = vi.fn(() => {
      this.readyState = FakeWebSocket.CLOSED;
    });

    constructor(url: string) {
      super();
      this.url = url;
      relayMocks.sockets.push(this);
    }

    openNow(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }

    settleNextSend(error?: Error): void {
      this.pendingSendCallbacks.shift()?.(error);
    }

    send(data: Uint8Array, callback?: (error?: Error) => void): void {
      if (this.failNextSendSync) {
        this.failNextSendSync = false;
        throw new Error('synthetic synchronous write failure');
      }
      this.sent.push(new Uint8Array(data));
      if (this.holdSendCallbacks && callback) {
        this.pendingSendCallbacks.push(callback);
        return;
      }
      if (this.failNextSendAsync) {
        this.failNextSendAsync = false;
        queueMicrotask(() => callback?.(new Error('synthetic asynchronous write failure')));
        return;
      }
      queueMicrotask(() => callback?.());
    }
  }

  return { default: FakeWebSocket };
});

import { RelaySocket } from './relay-socket';

function createSocket(): RelaySocket {
  return new RelaySocket({
    wsUrl: 'ws://127.0.0.1:7777/r/test-room',
    role: 'host',
    key: {} as CryptoKey,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('RelaySocket send queue hardening', () => {
  beforeEach(() => {
    relayMocks.sockets.length = 0;
    relayMocks.seal.mockReset();
    relayMocks.open.mockReset();
    relayMocks.seal.mockImplementation(async (_key: CryptoKey, frame: unknown) => {
      const seq =
        typeof frame === 'object' &&
        frame !== null &&
        'seq' in frame &&
        typeof frame.seq === 'number'
          ? frame.seq
          : 0;
      return new Uint8Array([seq]);
    });
  });

  it('fecha com erro observável quando a fila excede o limite por quantidade', async () => {
    const socket = createSocket();
    const onClose = vi.fn();
    socket.onClose = onClose;

    for (let seq = 1; seq <= 257; seq++) socket.send({ seq });

    await waitFor(() => onClose.mock.calls.length > 0);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith(
      expect.stringMatching(/queue overflow.*resync required/i),
      false,
    );
    expect(socket.state).toBe('failed');
    expect(socket.lastError).toMatch(/queue overflow.*resync required/i);
    expect(socket.pendingSendCount).toBe(0);
    expect(socket.pendingSendBytes).toBe(0);
  });

  it('fecha com erro observável quando um único envelope excede o limite em bytes', async () => {
    const socket = createSocket();
    const onClose = vi.fn();
    socket.onClose = onClose;
    relayMocks.seal.mockResolvedValueOnce(new Uint8Array(2 * 1024 * 1024));

    socket.send({ seq: 1 });

    await waitFor(() => onClose.mock.calls.length > 0);
    expect(onClose).toHaveBeenCalledWith(
      expect.stringMatching(/queue overflow.*resync required/i),
      false,
    );
    expect(socket.pendingSendBytes).toBe(0);
  });

  it('preserva a ordem dos envelopes durante backpressure e drain', async () => {
    const socket = createSocket();
    socket.connect();
    const ws = relayMocks.sockets[0]!;
    ws.openNow();
    ws.bufferedAmount = 64 * 1024;

    socket.send({ seq: 1 });
    socket.send({ seq: 2 });
    socket.send({ seq: 3 });

    await waitFor(() => socket.pendingSendCount === 3);
    expect(ws.sent).toHaveLength(0);
    ws.bufferedAmount = 0;
    await waitFor(() => ws.sent.length === 3);

    expect(ws.sent.map((envelope) => envelope[4])).toEqual([1, 2, 3]);
    expect(socket.pendingSendCount).toBe(0);
    expect(socket.pendingSendBytes).toBe(0);
  });

  it('sinaliza falha de seal e encerra sem enviar o frame', async () => {
    const socket = createSocket();
    const onClose = vi.fn();
    socket.onClose = onClose;
    socket.connect();
    const ws = relayMocks.sockets[0]!;
    ws.openNow();
    relayMocks.seal.mockRejectedValueOnce(new Error('synthetic seal failure'));

    socket.send({ seq: 1 });

    await waitFor(() => onClose.mock.calls.length > 0);
    expect(onClose).toHaveBeenCalledWith(
      expect.stringMatching(/seal failed.*resync required/i),
      false,
    );
    expect(ws.close).toHaveBeenCalledOnce();
    expect(ws.sent).toHaveLength(0);
    expect(socket.state).toBe('failed');
  });

  it('sinaliza falha assíncrona de ws.send e não repete o frame após resync explícito', async () => {
    const socket = createSocket();
    const onClose = vi.fn();
    socket.onClose = onClose;
    socket.connect();
    const failedWs = relayMocks.sockets[0]!;
    failedWs.openNow();
    failedWs.failNextSendAsync = true;

    socket.send({ seq: 1 });

    await waitFor(() => socket.state === 'failed');
    expect(onClose).toHaveBeenLastCalledWith(
      expect.stringMatching(/send failed.*resync required/i),
      false,
    );
    expect(failedWs.close).toHaveBeenCalledOnce();

    socket.connect();
    const recoveredWs = relayMocks.sockets[1]!;
    recoveredWs.openNow();
    socket.send({ seq: 2 });
    await waitFor(() => recoveredWs.sent.length === 1);

    expect(recoveredWs.sent.map((envelope) => envelope[4])).toEqual([2]);
    expect(socket.state).toBe('open');
    expect(socket.lastError).toBeNull();
  });

  it('aguarda confirmação do send anterior e não escreve frames posteriores após a falha', async () => {
    const socket = createSocket();
    socket.connect();
    const ws = relayMocks.sockets[0]!;
    ws.openNow();
    ws.holdSendCallbacks = true;

    socket.send({ seq: 1 });
    socket.send({ seq: 2 });
    await waitFor(() => ws.sent.length === 1);
    expect(ws.sent.map((envelope) => envelope[4])).toEqual([1]);

    ws.settleNextSend(new Error('synthetic delayed write failure'));
    await waitFor(() => socket.state === 'failed');

    expect(ws.sent.map((envelope) => envelope[4])).toEqual([1]);
    expect(socket.pendingSendCount).toBe(0);
  });

  it('falha de send durante drain fecha e limpa toda a fila sem replay parcial', async () => {
    const socket = createSocket();
    const onClose = vi.fn();
    socket.onClose = onClose;
    socket.send({ seq: 1 });
    socket.send({ seq: 2 });
    await waitFor(() => socket.pendingSendCount === 2);

    socket.connect();
    const ws = relayMocks.sockets[0]!;
    ws.failNextSendSync = true;
    ws.openNow();

    await waitFor(() => socket.state === 'failed');
    expect(onClose).toHaveBeenCalledWith(
      expect.stringMatching(/send failed.*resync required/i),
      false,
    );
    expect(ws.sent).toHaveLength(0);
    expect(socket.pendingSendCount).toBe(0);
    expect(socket.pendingSendBytes).toBe(0);
  });
});
