import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startRelayServer, type RelayServer } from './server';

const ROOM = 'relayttltestroom0000000000000001';

describe('relay server (Railway)', () => {
  let relay: RelayServer | null = null;

  afterEach(() => {
    relay?.stop();
    relay = null;
  });

  it('F-1472: TTL de sala ociosa fecha também o host com 4001 (não deixa host preso a sala morta)', async () => {
    relay = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      allowedOrigins: new Set(),
      maxRooms: 4,
      maxPeersPerRoom: 2,
      maxFrameBytes: 1024,
      roomTtlMs: 50,
      heartbeatMs: 60_000,
      maxUpgradesPerIpPerMinute: 100,
    });
    const host = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${ROOM}?role=host`);
    const closed = new Promise<{ code: number; reason: string } | 'still-open'>((resolve) => {
      const timer = setTimeout(() => resolve('still-open'), 2_000);
      host.once('close', (code: number, reason: Buffer) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
    await new Promise<void>((resolve, reject) => {
      host.once('open', () => resolve());
      host.once('error', reject);
    });

    expect(await closed).toEqual({ code: 4001, reason: 'idle timeout' });
    host.terminate();

    // A sala sumiu de fato: um guest com o QR antigo recebe 4004.
    const guest = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${ROOM}?role=guest`);
    const guestClose = await new Promise<number>((resolve) => {
      guest.once('close', (code: number) => resolve(code));
    });
    expect(guestClose).toBe(4004);
  });

  it('F-1472: heartbeat derruba host que não responde ping (zumbi) e libera a sala; host vivo fica', async () => {
    relay = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      allowedOrigins: new Set(),
      maxRooms: 4,
      maxPeersPerRoom: 2,
      maxFrameBytes: 1024,
      roomTtlMs: 60_000,
      heartbeatMs: 100,
      maxUpgradesPerIpPerMinute: 100,
    });
    const url = (room: string, role: string) =>
      `ws://127.0.0.1:${relay!.port}/r/${room}?role=${role}`;
    const opened = (socket: WebSocket) =>
      new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
    const LIVE = 'relayheartbeatliveroom0000000001';
    // Wi-Fi caiu: o socket existe no relay, mas ninguém responde ping.
    const zombie = new WebSocket(url(ROOM, 'host'), { autoPong: false });
    const live = new WebSocket(url(LIVE, 'host'));
    await Promise.all([opened(zombie), opened(live)]);
    let liveClosed = false;
    live.once('close', () => {
      liveClosed = true;
    });

    const zombieGone = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_000);
      zombie.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(zombieGone).toBe(true);
    expect(liveClosed).toBe(false);

    // A sala do zumbi foi liberada: o host verdadeiro volta para o MESMO id.
    const back = new WebSocket(url(ROOM, 'host'));
    await opened(back);
    const backClose = new Promise<number>((resolve) => back.once('close', (code: number) => resolve(code)));
    const raced = await Promise.race([
      backClose,
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 150)),
    ]);
    expect(raced).toBe('open');
    back.terminate();
    live.terminate();
  });
});
