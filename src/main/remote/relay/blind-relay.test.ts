import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { packEnvelope, unpackEnvelope } from '../../../vendor/omp/wire/codec';
import {
  RELAY_CLOSE_HOST_CONFLICT,
  RELAY_CLOSE_NO_ROOM,
  RELAY_CLOSE_ROOM_CLOSED,
  RELAY_CLOSE_ROOM_FULL,
  startBlindRelay,
  type BlindRelay,
} from './blind-relay';

const ROOM = 'a'.repeat(32);

// O relay é content-blind: os testes usam payloads arbitrários sem crypto —
// exatamente o que o relay enxerga em produção (bytes opacos).
function makeEnvelope(peerId: number, payload: number[]): Uint8Array {
  return packEnvelope(peerId, new Uint8Array(payload));
}

function connect(
  url: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  const ws = new WebSocket(url, headers ? { headers } : {});
  ws.binaryType = 'nodebuffer';
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected response ${res.statusCode}`));
    });
  });
}

function nextMessage(
  ws: WebSocket,
  timeoutMs = 5_000,
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data: data as Buffer, isBinary });
    });
  });
}

function nextClose(
  ws: WebSocket,
  timeoutMs = 5_000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('blind-relay', () => {
  let relay: BlindRelay | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.terminate();
      } catch {
        // Já fechado.
      }
    }
    await relay?.stop();
    relay = null;
  });

  function track(ws: WebSocket): WebSocket {
    sockets.push(ws);
    return ws;
  }

  async function joinRoom(roomId: string, role: 'host' | 'guest'): Promise<WebSocket> {
    return track(await connect(`${relay!.url}/r/${roomId}?role=${role}`));
  }

  it('F-1487: o ping do heartbeat ganha pong (sala aceita), para guest e host', async () => {
    relay = await startBlindRelay();
    const host = await joinRoom(ROOM, 'host');
    const guest = await joinRoom(ROOM, 'guest');
    await nextMessage(host); // peer-joined
    guest.send('{"t":"ping"}');
    const pong = await nextMessage(guest);
    expect(pong).toMatchObject({ isBinary: false });
    expect(pong.data.toString()).toBe('{"t":"pong"}');
    host.send('{"t":"ping"}');
    expect((await nextMessage(host)).data.toString()).toBe('{"t":"pong"}');
  });

  it('host + 2 guests: broadcast (peer 0) e unicast (peer N) pelo envelope', async () => {
    relay = await startBlindRelay();
    const host = await joinRoom(ROOM, 'host');
    const guest1 = await joinRoom(ROOM, 'guest');
    const joined1 = await nextMessage(host);
    expect(joined1.isBinary).toBe(false);
    expect(JSON.parse(joined1.data.toString())).toEqual({
      t: 'peer-joined',
      peer: 1,
    });
    const guest2 = await joinRoom(ROOM, 'guest');
    const joined2 = await nextMessage(host);
    expect(JSON.parse(joined2.data.toString())).toEqual({
      t: 'peer-joined',
      peer: 2,
    });

    // Broadcast: peerId 0 chega aos dois guests, bytes inalterados.
    const broadcast = makeEnvelope(0, [10, 20, 30]);
    const b1 = nextMessage(guest1);
    const b2 = nextMessage(guest2);
    host.send(broadcast);
    expect((await b1).data).toEqual(Buffer.from(broadcast));
    expect((await b2).data).toEqual(Buffer.from(broadcast));

    // Unicast: peerId 2 chega só ao guest2.
    const unicast = makeEnvelope(2, [42]);
    const only2 = nextMessage(guest2);
    let guest1Got = false;
    guest1.once('message', () => {
      guest1Got = true;
    });
    host.send(unicast);
    expect((await only2).data).toEqual(Buffer.from(unicast));
    await delay(100);
    expect(guest1Got).toBe(false);
  });

  it('frames de guest têm o peerId reescrito antes de chegar ao host', async () => {
    relay = await startBlindRelay();
    const host = await joinRoom(ROOM, 'host');
    const guest = await joinRoom(ROOM, 'guest');
    await nextMessage(host); // peer-joined

    const fromHost = nextMessage(host);
    // Guest sempre manda peer 0; o relay reescreve para o id do remetente (1).
    guest.send(makeEnvelope(0, [1, 2, 3]));
    const received = await fromHost;
    expect(received.isBinary).toBe(true);
    const envelope = unpackEnvelope(new Uint8Array(received.data));
    expect(envelope).not.toBeNull();
    expect(envelope!.peerId).toBe(1);
    expect(Buffer.from(envelope!.payload)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('guest em sala inexistente é fechado com 4004', async () => {
    relay = await startBlindRelay();
    const guest = await joinRoom('f'.repeat(32), 'guest');
    const closed = await nextClose(guest);
    expect(closed.code).toBe(RELAY_CLOSE_NO_ROOM);
  });

  it('segundo host na mesma sala é fechado com 4009 sem derrubar a sala', async () => {
    relay = await startBlindRelay();
    const host = await joinRoom(ROOM, 'host');
    const conflict = await joinRoom(ROOM, 'host');
    const closed = await nextClose(conflict);
    expect(closed.code).toBe(RELAY_CLOSE_HOST_CONFLICT);
    // Sala original continua viva: guest ainda entra.
    const guest = await joinRoom(ROOM, 'guest');
    const joined = await nextMessage(host);
    expect(JSON.parse(joined.data.toString()).t).toBe('peer-joined');
    expect(guest.readyState).toBe(WebSocket.OPEN);
  });

  it('cap de peers por sala: excedente é fechado com 4029', async () => {
    relay = await startBlindRelay({ maxPeersPerRoom: 1 });
    const host = await joinRoom(ROOM, 'host');
    await joinRoom(ROOM, 'guest');
    await nextMessage(host); // peer-joined 1
    const overflow = await joinRoom(ROOM, 'guest');
    const closed = await nextClose(overflow);
    expect(closed.code).toBe(RELAY_CLOSE_ROOM_FULL);
  });

  it('cap de salas: host além do limite é fechado com 4029', async () => {
    relay = await startBlindRelay({ maxRooms: 1 });
    await joinRoom(ROOM, 'host');
    const second = await joinRoom('b'.repeat(32), 'host');
    const closed = await nextClose(second);
    expect(closed.code).toBe(RELAY_CLOSE_ROOM_FULL);
    expect(relay.stats().rooms).toBe(1);
  });

  it('host desconectando: guests recebem TEXT room-closed e close 4001', async () => {
    relay = await startBlindRelay();
    const host = await joinRoom(ROOM, 'host');
    const guest = await joinRoom(ROOM, 'guest');
    await nextMessage(host); // peer-joined
    const control = nextMessage(guest);
    const closed = nextClose(guest);
    host.close(1000);
    const controlMsg = await control;
    expect(controlMsg.isBinary).toBe(false);
    expect(JSON.parse(controlMsg.data.toString())).toEqual({ t: 'room-closed' });
    expect((await closed).code).toBe(RELAY_CLOSE_ROOM_CLOSED);
    expect(relay.stats().rooms).toBe(0);
  });

  it('TTL de sala ociosa: sala sem tráfego é varrida e fechada', async () => {
    relay = await startBlindRelay({ roomTtlMs: 100, sweepIntervalMs: 25 });
    const host = await joinRoom(ROOM, 'host');
    const guest = await joinRoom(ROOM, 'guest');
    await nextMessage(host); // peer-joined
    const hostClosed = nextClose(host);
    const guestClosed = nextClose(guest);
    expect((await hostClosed).code).toBe(RELAY_CLOSE_ROOM_CLOSED);
    expect((await guestClosed).code).toBe(RELAY_CLOSE_ROOM_CLOSED);
    expect(relay.stats().rooms).toBe(0);
  });

  it('atividade renova o TTL da sala', async () => {
    relay = await startBlindRelay({ roomTtlMs: 200, sweepIntervalMs: 25 });
    const host = await joinRoom(ROOM, 'host');
    // Tráfego periódico abaixo do TTL mantém a sala viva além do TTL bruto.
    for (let i = 0; i < 4; i += 1) {
      await delay(80);
      host.send(makeEnvelope(0, [i]));
    }
    expect(relay.stats().rooms).toBe(1);
    expect(host.readyState).toBe(WebSocket.OPEN);
  });

  it('verificação de Origin: browser fora da allowlist é rejeitado no upgrade', async () => {
    relay = await startBlindRelay({ allowedOrigins: ['https://app.nexus.test'] });
    await expect(
      connect(`${relay.url}/r/${ROOM}?role=host`, {
        Origin: 'https://evil.example',
      }),
    ).rejects.toThrow();
    // Origin permitida passa; ausência de Origin (cliente não-browser) passa.
    const allowed = track(
      await connect(`${relay.url}/r/${ROOM}?role=host`, {
        Origin: 'https://app.nexus.test',
      }),
    );
    expect(allowed.readyState).toBe(WebSocket.OPEN);
  });

  it('path/role inválidos não fazem upgrade', async () => {
    relay = await startBlindRelay();
    await expect(connect(`${relay.url}/r/${ROOM}?role=admin`)).rejects.toThrow();
    await expect(connect(`${relay.url}/x/${ROOM}?role=host`)).rejects.toThrow();
    await expect(connect(`${relay.url}/r/curto?role=host`)).rejects.toThrow();
  });

  it('rate-limit por IP bloqueia upgrades em excesso na janela', async () => {
    relay = await startBlindRelay({ maxUpgradesPerIpPerMinute: 2 });
    await joinRoom(ROOM, 'host');
    await joinRoom(ROOM, 'guest');
    await expect(connect(`${relay.url}/r/${ROOM}?role=guest`)).rejects.toThrow();
  });
});
