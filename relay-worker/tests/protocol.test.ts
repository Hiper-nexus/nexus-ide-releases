/**
 * Protocolo do relay no workerd real (`wrangler dev`), contra os mesmos
 * contratos do relay da Railway (`server/src/relay/server.ts`).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it as nodeIt } from 'node:test';
import {
  APP_ORIGIN,
  envelope,
  newRoom,
  peerOf,
  sleep,
  startRelay,
  staysOpen,
  syntheticIp,
  TestClient,
  upgradeStatus,
  type Relay,
} from './harness';

const TTL_MS = 4_000;
const HEARTBEAT_MS = 400;
const IDLE_MS = 1_500;
const MAX_MESSAGES_PER_SECOND = 60;
const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';

// Fechamento que não vem é falha, não espera infinita.
const it = (name: string, fn: () => Promise<void>) => nodeIt(name, { timeout: 30_000 }, fn);

describe('nexus-relay (Durable Objects)', () => {
  let relay: Relay;
  const host = (room: string, options: { autoPong?: boolean } = {}) =>
    new TestClient(`${relay.wsBase}/r/${room}?role=host`, options);
  const guest = (room: string) => new TestClient(`${relay.wsBase}/r/${room}?role=guest`, { origin: APP_ORIGIN });
  const joined = (peer: number) => JSON.stringify({ t: 'peer-joined', peer });
  const left = (peer: number) => JSON.stringify({ t: 'peer-left', peer });

  before(async () => {
    relay = await startRelay({
      RELAY_ROOM_TTL_MS: String(TTL_MS),
      RELAY_HEARTBEAT_MS: String(HEARTBEAT_MS),
      RELAY_MAX_PEERS_PER_ROOM: '2',
      RELAY_MAX_FRAME_BYTES: '1024',
      RELAY_IDLE_TAKEOVER_MS: String(IDLE_MS),
      RELAY_MAX_MESSAGES_PER_SECOND: String(MAX_MESSAGES_PER_SECOND),
    });
  });

  after(async () => {
    await relay?.stop();
  });

  it('HTTP sem upgrade → 404 (o relay só fala WebSocket)', async () => {
    assert.equal((await fetch(`${relay.httpBase}/`)).status, 404);
    assert.equal((await fetch(`${relay.httpBase}/r/${newRoom()}?role=host`)).status, 404);
  });

  it('Origin estranha → 403 antes de olhar o path', async () => {
    const room = newRoom();
    assert.equal(await upgradeStatus(`${relay.httpBase}/r/${room}?role=guest`, { Origin: 'https://evil.example' }), 403);
    assert.equal(await upgradeStatus(`${relay.httpBase}/nada`, { Origin: 'https://evil.example' }), 403);
    assert.equal(await upgradeStatus(`${relay.httpBase}/r/${room}?role=guest`, { Origin: 'null' }), 403);
    assert.equal(await upgradeStatus(`${relay.httpBase}/r/${room}?role=guest`, { Origin: `${APP_ORIGIN}/` }), 403);
  });

  it('rota ou papel inválido → 404', async () => {
    const room = newRoom();
    for (const path of ['/nada', '/r/curta', `/r/${room}`, `/r/${room}?role=admin`, `/r/${room}/x?role=host`, `/r/${room}!?role=host`]) {
      assert.equal(await upgradeStatus(`${relay.httpBase}${path}`, { Origin: APP_ORIGIN }), 404, path);
    }
  });

  it('Origin do PWA faz upgrade (101); guest em sala sem host fecha com 4004', async () => {
    const room = newRoom();
    const lonely = guest(room);
    await lonely.opened;
    assert.deepEqual(await lonely.closed, { code: 4004, reason: 'no such room' });
  });

  it('segundo host → 4009 e o primeiro continua dono da sala', async () => {
    const room = newRoom();
    const first = host(room);
    await first.opened;
    const second = host(room);
    assert.deepEqual(await second.closed, { code: 4009, reason: 'host already connected' });
    const g = guest(room);
    await g.opened;
    assert.equal(await first.text((text) => text === joined(1)), joined(1));
    first.close();
    g.close();
  });

  it('excesso de peers → 4029; vaga liberada aceita de novo com peerId novo', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g1 = guest(room);
    const g2 = guest(room);
    await Promise.all([g1.opened, g2.opened]);
    const g3 = guest(room);
    assert.deepEqual(await g3.closed, { code: 4029, reason: 'room is full' });
    g1.close();
    await h.text((text) => text === left(1));
    const g4 = guest(room);
    await g4.opened;
    await h.text((text) => text === joined(3));
    assert.deepEqual(h.texts, [joined(1), joined(2), left(1), joined(3)]);
    h.close();
  });

  it('frame do guest chega ao host com o peerId do remetente; host faz unicast e broadcast sem alterar', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g1 = guest(room);
    await g1.opened;
    await h.text((text) => text === joined(1));
    const g2 = guest(room);
    await g2.opened;
    await h.text((text) => text === joined(2));

    g2.send(envelope(0, [7, 7]));
    assert.deepEqual(Array.from(await h.frame(0)), [0, 0, 0, 2, 7, 7]);
    // Guest não escolhe remetente: o relay reescreve qualquer peerId forjado.
    g1.send(envelope(99, [5]));
    assert.deepEqual(Array.from(await h.frame(1)), [0, 0, 0, 1, 5]);

    h.send(envelope(1, [1, 1]));
    h.send(envelope(0, [2]));
    assert.deepEqual(Array.from(await g1.frame(0)), [0, 0, 0, 1, 1, 1]);
    assert.deepEqual(Array.from(await g1.frame(1)), [0, 0, 0, 0, 2]);
    // O unicast para o peer 1 nunca chegou ao peer 2: o primeiro frame dele é o broadcast.
    assert.deepEqual(Array.from(await g2.frame(0)), [0, 0, 0, 0, 2]);
    assert.equal(g2.frames.length, 1);
    assert.equal(peerOf(h.frames[0]!), 2);
    h.close();
  });

  it('TEXT de cliente não é encaminhado; ping recebe pong do runtime', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g = guest(room);
    await g.opened;
    await h.text((text) => text === joined(1));

    g.send('{"t":"peer-joined","peer":42}');
    h.send('texto do host');
    g.send(PING);
    h.send(PING);
    assert.equal(await g.text((text) => text === PONG), PONG);
    assert.equal(await h.text((text) => text === PONG), PONG);
    // Um frame depois do TEXT prova a ordem: o TEXT já teria chegado antes dele.
    g.send(envelope(0, [3]));
    await h.frame(0);
    h.send(envelope(0, [4]));
    await g.frame(0);
    assert.deepEqual(h.texts, [joined(1), PONG]);
    assert.deepEqual(g.texts, [PONG]);
    h.close();
  });

  it('frame fora dos limites fecha quem mandou com 1009', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g1 = guest(room);
    await g1.opened;
    await h.text((text) => text === joined(1));
    g1.send(new Uint8Array([1, 2, 3]));
    assert.deepEqual(await g1.closed, { code: 1009, reason: 'invalid frame' });
    await h.text((text) => text === left(1));

    const g2 = guest(room);
    await g2.opened;
    await h.text((text) => text === joined(2));
    h.send(envelope(0, new Uint8Array(1_100)));
    assert.deepEqual(await h.closed, { code: 1009, reason: 'invalid frame' });
    assert.deepEqual(await g2.closed, { code: 4001, reason: 'room closed' });
    assert.deepEqual(g2.texts, ['{"t":"room-closed"}']);
  });

  it('host que sai fecha a sala: guests recebem room-closed + 4001 e o QR antigo dá 4004', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g = guest(room);
    await g.opened;
    await h.text((text) => text === joined(1));
    h.close();
    assert.deepEqual(await g.closed, { code: 4001, reason: 'room closed' });
    assert.deepEqual(g.texts, ['{"t":"room-closed"}']);
    const late = guest(room);
    assert.deepEqual(await late.closed, { code: 4004, reason: 'no such room' });
    // A sala é do próximo host que chegar (o desktop reconectando).
    const back = host(room);
    await back.opened;
    assert.equal(await staysOpen(back, 300), 'open');
    back.close();
  });

  it('TTL: frame renova o prazo; sala ociosa fecha guests (4001 room closed) e host (4001 idle timeout)', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g = guest(room);
    await g.opened;
    await h.text((text) => text === joined(1));
    // 5,4 s de conversa > TTL de 4 s: a sala segue viva enquanto há frame.
    for (let i = 0; i < 4; i++) {
      await sleep(1_350);
      g.send(envelope(0, [i]));
    }
    await h.frame(3);
    assert.equal(await staysOpen(h, 10), 'open');

    const idleSince = Date.now();
    assert.deepEqual(await h.closed, { code: 4001, reason: 'idle timeout' });
    assert.ok(Date.now() - idleSince >= TTL_MS - 200, 'fechou antes do TTL');
    assert.deepEqual(await g.closed, { code: 4001, reason: 'room closed' });
    assert.deepEqual(g.texts, ['{"t":"room-closed"}']);
    const late = guest(room);
    assert.deepEqual(await late.closed, { code: 4004, reason: 'no such room' });
  });

  it('heartbeat: host que pingou e calou (meio-aberto) cai e libera a sala; quem pinga e cliente antigo ficam', async () => {
    const zombieRoom = newRoom();
    const liveRoom = newRoom();
    const legacyRoom = newRoom();
    const zombie = host(zombieRoom);
    const live = host(liveRoom);
    const legacy = host(legacyRoom);
    await Promise.all([zombie.opened, live.opened, legacy.opened]);
    const zombieGuest = guest(zombieRoom);
    await zombieGuest.opened;

    // O Wi-Fi do desktop cai depois do primeiro ping: nada mais chega dele.
    zombie.send(PING);
    await zombie.text((text) => text === PONG);
    const pinger = setInterval(() => live.send(PING), HEARTBEAT_MS / 2);
    try {
      const startedAt = Date.now();
      assert.deepEqual(await zombie.closed, { code: 1001, reason: 'heartbeat timeout' });
      assert.ok(Date.now() - startedAt >= 2 * HEARTBEAT_MS - 200, 'caiu antes de 2 intervalos');
      assert.deepEqual(await zombieGuest.closed, { code: 4001, reason: 'room closed' });
      // Frame só para o TTL de 4 s não se misturar com o heartbeat aqui.
      live.send(envelope(0, [1]));
      legacy.send(envelope(0, [1]));
      assert.equal(await staysOpen(live, 4 * HEARTBEAT_MS), 'open');
      assert.equal(await staysOpen(legacy, 10), 'open');

      // O desktop volta para o MESMO id de sala (sem 4009 do próprio zumbi).
      const back = host(zombieRoom);
      await back.opened;
      assert.equal(await staysOpen(back, 300), 'open');
      back.close();
    } finally {
      clearInterval(pinger);
      live.close();
      legacy.close();
    }
  });

  it('perda sem close, host antigo (sem ping): ativo segue protegido por 4009; calado além do limite, o novo host assume (4008)', async () => {
    const room = newRoom();
    const old = host(room);
    await old.opened;
    const g = guest(room);
    await g.opened;
    await old.text((text) => text === joined(1));
    old.send(envelope(0, [1]));
    await g.frame(0);
    const early = host(room);
    assert.deepEqual(await early.closed, { code: 4009, reason: 'host already connected' });

    // A rede do desktop cai sem close: nada mais chega dele, nem frame nem ping.
    await sleep(IDLE_MS + 300);
    const fresh = host(room);
    await fresh.opened;
    assert.deepEqual(await old.closed, { code: 4008, reason: 'replaced by a new host' });
    assert.deepEqual(await g.closed, { code: 4001, reason: 'room closed' });
    assert.deepEqual(g.texts, ['{"t":"room-closed"}']);
    assert.equal(await staysOpen(fresh, 300), 'open');
    // Sala nova: o peerId recomeça e o guest do QR conversa com o host novo.
    const g2 = guest(room);
    await g2.opened;
    assert.equal(await fresh.text((text) => text === joined(1)), joined(1));
    g2.send(envelope(0, [2]));
    assert.deepEqual(Array.from(await fresh.frame(0)), [0, 0, 0, 1, 2]);
    fresh.close();
  });

  it('perda sem close, host novo (pinga): protegido enquanto pinga; quando a rede cai, o heartbeat o derruba e o desktop volta', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const pinger = setInterval(() => h.send(PING), HEARTBEAT_MS / 2);
    await sleep(IDLE_MS + 300);
    const early = host(room);
    assert.deepEqual(await early.closed, { code: 4009, reason: 'host already connected' });
    // Frame só para o TTL de 4 s não se misturar com o heartbeat aqui.
    h.send(envelope(0, [1]));
    clearInterval(pinger);
    const lostAt = Date.now();
    assert.deepEqual(await h.closed, { code: 1001, reason: 'heartbeat timeout' });
    assert.ok(Date.now() - lostAt < IDLE_MS + 2 * HEARTBEAT_MS, 'heartbeat demorou demais');
    const back = host(room);
    await back.opened;
    assert.equal(await staysOpen(back, 300), 'open');
    back.close();
  });

  it('perda sem close, guest antigo (sem ping): com a sala cheia, o novo guest despeja o calado (4008); guest ativo fica', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const quiet = guest(room);
    await quiet.opened;
    await h.text((text) => text === joined(1));
    const active = guest(room);
    await active.opened;
    await h.text((text) => text === joined(2));
    const talker = setInterval(() => active.send(envelope(0, [9])), 300);
    try {
      await sleep(IDLE_MS + 300);
      const newcomer = guest(room);
      await newcomer.opened;
      assert.deepEqual(await quiet.closed, { code: 4008, reason: 'replaced by a new connection' });
      await h.text((text) => text === joined(3));
      assert.deepEqual(
        h.texts.filter((text) => text !== PONG),
        [joined(1), joined(2), left(1), joined(3)],
      );
      // Todos ativos (o novo acabou de entrar, o outro fala): o próximo leva 4029.
      const late = guest(room);
      assert.deepEqual(await late.closed, { code: 4029, reason: 'room is full' });
      assert.equal(await staysOpen(active, 10), 'open');
    } finally {
      clearInterval(talker);
      h.close();
    }
  });

  it('perda sem close, guest novo (pinga): quem pingou e calou cai pelo heartbeat (1001) e o host recebe peer-left', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g = guest(room);
    await g.opened;
    await h.text((text) => text === joined(1));
    g.send(PING);
    await g.text((text) => text === PONG);
    const lostAt = Date.now();
    assert.deepEqual(await g.closed, { code: 1001, reason: 'heartbeat timeout' });
    assert.ok(Date.now() - lostAt >= 2 * HEARTBEAT_MS - 200, 'caiu antes de 2 intervalos');
    await h.text((text) => text === left(1));
    assert.equal(await staysOpen(h, 10), 'open');
    h.close();
  });

  it('TEXT acima do teto em bytes UTF-8 fecha com 1009 (ASCII e multibyte); abaixo do teto passa', async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g1 = guest(room);
    await g1.opened;
    await h.text((text) => text === joined(1));
    g1.send('é'.repeat(400)); // 800 bytes
    g1.send(envelope(0, [1]));
    await h.frame(0);
    assert.equal(await staysOpen(g1, 10), 'open');
    g1.send('a'.repeat(1_100));
    assert.deepEqual(await g1.closed, { code: 1009, reason: 'invalid frame' });
    await h.text((text) => text === left(1));

    const g2 = guest(room);
    await g2.opened;
    await h.text((text) => text === joined(2));
    g2.send('é'.repeat(600)); // 600 caracteres, 1200 bytes
    assert.deepEqual(await g2.closed, { code: 1009, reason: 'invalid frame' });
    await h.text((text) => text === left(2));

    const g3 = guest(room);
    await g3.opened;
    await h.text((text) => text === joined(3));
    h.send('ç'.repeat(513)); // 1026 bytes
    assert.deepEqual(await h.closed, { code: 1009, reason: 'invalid frame' });
    assert.deepEqual(await g3.closed, { code: 4001, reason: 'room closed' });
  });

  it(`mais de ${MAX_MESSAGES_PER_SECOND} mensagens por segundo fecha com 1008; ritmo normal segue`, async () => {
    const room = newRoom();
    const h = host(room);
    await h.opened;
    const g = guest(room);
    await g.opened;
    await h.text((text) => text === joined(1));
    for (let i = 0; i < 20; i++) g.send(envelope(0, [i]));
    await h.frame(19);
    await sleep(1_100);
    assert.equal(await staysOpen(g, 10), 'open');
    for (let i = 0; i < 3 * MAX_MESSAGES_PER_SECOND; i++) g.send(envelope(0, [i]));
    assert.deepEqual(await g.closed, { code: 1008, reason: 'rate limit' });
    await h.text((text) => text === left(1));

    const g2 = guest(room);
    await g2.opened;
    await h.text((text) => text === joined(2));
    for (let i = 0; i < 3 * MAX_MESSAGES_PER_SECOND; i++) h.send(envelope(0, [i]));
    assert.deepEqual(await h.closed, { code: 1008, reason: 'rate limit' });
    assert.deepEqual(await g2.closed, { code: 4001, reason: 'room closed' });
  });

  // Por último: gasta a cota do IP sintético usado aqui e mais nada.
  const local = { timeout: 30_000, skip: process.env.RELAY_TEST_URL ? 'IP sintético só vale no workerd local' : false };
  nodeIt('limite de upgrades por IP → 429 (cota de 60 por minuto)', local, async () => {
    const ip = syntheticIp();
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) {
      statuses.push(await upgradeStatus(`${relay.httpBase}/r/${newRoom()}?role=nenhum`, { 'CF-Connecting-IP': ip }));
    }
    assert.deepEqual(statuses.slice(0, 60), Array(60).fill(404));
    assert.deepEqual(statuses.slice(60), [429, 429]);
    // Outro IP não paga pela cota deste.
    assert.equal(await upgradeStatus(`${relay.httpBase}/r/${newRoom()}?role=nenhum`), 404);
  });
});
